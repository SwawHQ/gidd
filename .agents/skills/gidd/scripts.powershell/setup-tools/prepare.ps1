function Read-GiddBindings {
    param([string]$Root)
    $path = Join-Path $Root 'tool-bindings.json'; Assert-GiddPlainPath $path
    if (-not [IO.File]::Exists($path)) { throw 'tool_bindings_missing' }
    if ((Get-Item -LiteralPath $path).Length -gt 64KB) { throw 'tool_bindings_invalid' }
    $record = [IO.File]::ReadAllText($path) | ConvertFrom-Json
    if ($record.schema -ne 'gidd.tool-bindings/v1' -or $record.platform -ne 'windows-x64' -or -not $record.tools) { throw 'tool_bindings_invalid' }
    foreach ($property in $record.tools.PSObject.Properties) {
        $tool = $property.Value
        if ($property.Name -notin @('git','gh') -or $tool.path -notmatch '^[a-z]:[\\/].*\.exe$' -or
            $tool.source -notin @('path','managed') -or $tool.version -notmatch '^\d+\.\d+\.\d+$') { throw 'tool_bindings_invalid' }
        if ($tool.source -eq 'managed' -and ($tool.record_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [IO.Path]::GetFullPath($tool.path) -ne [IO.Path]::GetFullPath((Join-Path $Root ($property.Name + '/' + (Get-GiddExecutableName $property.Name)))))) { throw 'tool_bindings_invalid' }
    }
    return $record
}

function Test-GiddToolBinding {
    param([string]$Root, [string]$Name, $Candidate)
    try {
        $tool = (Read-GiddBindings $Root).tools.$Name
        return $tool.path -eq $Candidate.path -and $tool.version -eq $Candidate.version -and $tool.source -eq $Candidate.source -and
            ($tool.source -ne 'managed' -or $tool.record_sha256 -eq (Get-FileHash -LiteralPath (Join-Path $Root "$Name/install.json") -Algorithm SHA256).Hash)
    } catch { return $false }
}

function Write-GiddToolBinding {
    param([string]$Root, [string]$Name, $Candidate)
    if (Test-GiddToolBinding $Root $Name $Candidate) { return 'reused' }
    $path = Join-Path $Root 'tool-bindings.json'; Assert-GiddPlainPath $path
    try { $record = Read-GiddBindings $Root }
    catch {
        if ([IO.File]::Exists($path)) {
            if ((Get-Item -LiteralPath $path).Length -gt 64KB) { throw 'tool_bindings_invalid' }
            Write-GiddDurableFile (Join-Path $Root ('.cache/bindings-invalid-' + [guid]::NewGuid() + '.json')) ([IO.File]::ReadAllBytes($path))
        }
        $record = [pscustomobject]@{schema='gidd.tool-bindings/v1';platform='windows-x64';tools=[pscustomobject]@{}}
    }
    $tool = @{path=$Candidate.path;source=$Candidate.source;version=$Candidate.version}
    if ($Candidate.source -eq 'managed') { $tool.record_sha256 = (Get-FileHash -LiteralPath (Join-Path $Root "$Name/install.json") -Algorithm SHA256).Hash.ToLowerInvariant() }
    $record.tools | Add-Member -NotePropertyName $Name -NotePropertyValue $tool -Force
    $temporary = Join-Path $Root ('.bindings-' + [guid]::NewGuid() + '.tmp')
    try {
        Write-GiddDurableFile $temporary ([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress)))
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary,$path,[System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary,$path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    return 'published'
}

function Restore-GiddInterruptedTool {
    param([string]$Root, [string]$Name)
    $backup = Get-GiddRuntimeBackupPath $Root $Name
    if (-not (Test-Path -LiteralPath $backup)) { return }
    if (-not (Test-GiddOwnedRuntime $backup $Name)) { throw "unknown_tool_backup:$Name" }
    $target = Join-Path $Root $Name; $committed = $false
    try {
        $bound = (Read-GiddBindings $Root).tools.$Name
        $committed = $bound.source -eq 'managed' -and (Test-GiddManagedTool $target $Name) -and
            $bound.record_sha256 -eq (Get-FileHash -LiteralPath (Join-Path $target 'install.json') -Algorithm SHA256).Hash
    } catch { }
    if ($committed) { Remove-GiddRuntimeBackup $Root $Name }
    else { Restore-GiddRuntimeBackup $Root $Name }
}

function Get-GiddOptionalToolBinding {
    param([string]$Root, [string]$Name)
    $property = (Read-GiddBindings $Root).tools.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-GiddLauncherGit {
    param([string]$Root, $Candidate)
    if ($Candidate.id -ne 'tool.gh') { return $null }
    $git = Get-GiddOptionalToolBinding $Root 'git'
    if ($git) { return @{id='tool.git';details=$git} }
    return $null
}

function Test-GiddPreparedLauncher {
    param([string]$Root, $Candidate)
    $git = Get-GiddLauncherGit $Root $Candidate
    $link = Join-Path $Root ($Candidate.id.Substring(5) + '.link.cmd'); Assert-GiddPlainPath $link
    return (Test-GiddRuntimeBinding $Root (Get-GiddRuntimeBinding $Candidate)) -and
        (-not $git -or (Test-GiddRuntimeBinding $Root (Get-GiddRuntimeBinding $git))) -and
        [IO.File]::Exists($link) -and [IO.File]::ReadAllText($link) -ceq (Get-GiddLauncherText $Candidate $git)
}

function Write-GiddPreparedLauncher {
    param([string]$Root, $Candidate)
    $git = Get-GiddLauncherGit $Root $Candidate
    Write-GiddRuntimeBinding $Root (Get-GiddRuntimeBinding $Candidate)
    if ($git) { Write-GiddRuntimeBinding $Root (Get-GiddRuntimeBinding $git) }
    [void](Write-GiddLauncher $Root (Get-GiddLauncherText $Candidate $git) $Candidate.id.Substring(5))
}

function Invoke-GiddPrepareTools {
    param($Storage, [string[]]$Names = @('git','gh'), [switch]$CheckOnly, [switch]$Force,
        [scriptblock]$ReadText = { param($url) Read-GiddReleaseText $url }, [scriptblock]$OnPhase = {})
    if ($CheckOnly -and $Force) { throw 'force_conflicts_with_check' }
    foreach ($name in $Names) { if ($name -notin @('git','gh')) { throw 'invalid_tool_name' } }
    $root = $Storage.tools_root; $tools = @(); $checks = @(); $lock = $null
    try {
        if (-not $CheckOnly) { $lock = Open-GiddInstallLock $root; Write-GiddInstallationGuide $root }
        foreach ($name in $Names) {
            try {
                if (-not $CheckOnly) { Restore-GiddInterruptedTool $root $name }
                $extra = @()
                try { $bound = (Read-GiddBindings $root).tools.$name; if ($bound.source -eq 'path') { $extra += $bound.path } } catch { }
                $minimum = if ($name -eq 'git') { [version]'2.0.0' } else { [version]'2.98.0' }
                $pattern = if ($name -eq 'git') { '^git version (\d+\.\d+\.\d+)' } else { '^gh version (\d+\.\d+\.\d+)(?:\s|$)' }
                $managed = Join-Path $root ($name + '/' + (Get-GiddExecutableName $name))
                $candidate = Find-Tool $name $minimum $pattern $managed -ExtraPaths $extra
                if ($CheckOnly) {
                    $checks += $candidate
                    $pending = Test-Path -LiteralPath (Get-GiddRuntimeBackupPath $root $name)
                    $matches = $candidate.status -eq 'ready' -and (Test-GiddToolBinding $root $name $candidate.details) -and
                        (Test-GiddPreparedLauncher $root $candidate)
                    if ($matches -and $name -eq 'git') {
                        $gh = Get-GiddOptionalToolBinding $root 'gh'
                        if ($gh) { $matches = Test-GiddPreparedLauncher $root @{id='tool.gh';details=$gh} }
                    }
                    $checks += New-Check "binding.$name" $(if (-not $pending -and $matches) {'ready'} else {'invalid'}) $(if ($pending) {'tool_recovery_pending'} elseif ($matches) {'bound_candidate_verified'} else {'bootstrap_required'})
                    continue
                }
                $action = 'reused'
                if ($Force -or $candidate.status -ne 'ready') {
                    $target = Join-Path $root $name; $replace = Test-Path -LiteralPath $target
                    if ($replace -and -not (Test-GiddOwnedRuntime $target $name)) { throw "unknown_tool_ownership:$name" }
                    $settings = if ($name -eq 'git') { $null } else { $Storage.tools[$name] }
                    $definition = Resolve-GiddRelease $name $settings $null $ReadText
                    if ([version]$definition.version -lt $minimum) { throw "release_below_minimum:$name" }
                    $toolPhaseCallback = $OnPhase
                    [void](Install-GiddTool $root $definition { param($phase) & $toolPhaseCallback $name $phase } -Replace:$replace)
                    $action = if ($Force -and $replace) {'reinstalled'} elseif ($replace) {'repaired'} else {'installed'}
                    $candidate = Find-Tool $name $minimum $pattern $managed -Source managed
                    if ($candidate.status -ne 'ready') { throw "post_install_check_failed:$name" }
                }
                $binding = Write-GiddToolBinding $root $name $candidate.details
                # Bindings are the commit evidence. Refresh derived launchers under
                # the same lock; a later check detects an interrupted refresh.
                Write-GiddPreparedLauncher $root $candidate
                if ($name -eq 'git') {
                    $gh = Get-GiddOptionalToolBinding $root 'gh'
                    if ($gh) { Write-GiddPreparedLauncher $root @{id='tool.gh';details=$gh} }
                }
                & $OnPhase $name 'bound'
                $tools += @{name=$name;action=$action;path=$candidate.details.path;binding_action=$binding}
                $checks += $candidate; $checks += New-Check "binding.$name" 'ready' 'bound_candidate_verified'
                Restore-GiddInterruptedTool $root $name; Remove-GiddStage $root $name
            } catch {
                $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'tool_preparation_failed' }
                $checks += New-Check "tool.$name" 'invalid' $reason
                if (-not $CheckOnly) { try { Restore-GiddInterruptedTool $root $name } catch { $checks += New-Check "recovery.$name" 'invalid' 'tool_recovery_failed' } }
            }
        }
    } finally { if ($lock) { $lock.Dispose() } }
    return @{schema='gidd.bootstrap-tools/v1';status=$(if (@($checks | Where-Object status -NE 'ready').Count) {'needs_bootstrap'} else {'ready'});
        read_only=[bool]$CheckOnly;tools=$tools;checks=$checks;tools_root=$root;binding_path=(Join-Path $root 'tool-bindings.json')}
}
