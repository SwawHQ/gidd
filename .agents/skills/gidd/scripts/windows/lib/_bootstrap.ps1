function Find-GiddBootstrapRuntime {
    param($Storage, [switch]$Node)
    $order = if ($Node) { @('node') } else { @('bun','node') }
    $attempts = @()
    foreach ($source in @('managed','path')) {
        foreach ($name in $order) {
            $candidate = Find-Tool $name ([version]'0.0.0') '' (Join-Path $Storage.tools_root "$name/$name.exe") -Source $source -CheckCompatibility
            $attempts += $candidate
            if ($candidate.status -eq 'ready') { return @{ candidate=$candidate; attempts=$attempts } }
        }
    }
    return @{ candidate=$null; attempts=$attempts }
}

function Get-GiddLauncherText {
    param($Candidate)
    $name = $Candidate.id.Substring(5)
    $executable = if ($Candidate.details.source -eq 'managed') { "%~dp0$name\$name.exe" }
        else { $Candidate.details.path.Replace('%','%%') }
    if ($executable -match '["\r\n]') { throw 'invalid_runtime_path' }
    # Switch only while reading the UTF-8 path literal, then restore the console.
    # No CALL: arguments (including percent signs) must only be expanded once.
    return (@(
        '@echo off'
        'setlocal DisableDelayedExpansion'
        'for /f "tokens=2 delims=:" %%C in (''"%SystemRoot%\System32\chcp.com"'') do set "GIDD_JS_CODEPAGE=%%C"'
        '"%SystemRoot%\System32\chcp.com" 65001 >nul'
        ('set "GIDD_JS_EXEC=' + $executable + '"')
        '"%SystemRoot%\System32\chcp.com" %GIDD_JS_CODEPAGE% >nul'
        '"%GIDD_JS_EXEC%" %*'
        'exit /b %ERRORLEVEL%'
        ''
    ) -join "`r`n")
}

function Write-GiddLauncher {
    param([string]$Root, [string]$Text)
    $path = Join-Path $Root 'js_exec.cmd'
    Assert-GiddPlainPath $path
    if ([IO.File]::Exists($path) -and [IO.File]::ReadAllText($path) -ceq $Text) { return 'reused' }
    $temporary = Join-Path $Root ('.js_exec-' + [guid]::NewGuid().ToString() + '.tmp')
    try {
        Write-GiddDurableFile $temporary ([Text.Encoding]::UTF8.GetBytes($Text))
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary,$path,[System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary,$path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    return 'published'
}

function Invoke-GiddBootstrap {
    param($Storage, [switch]$Yes, [switch]$Node, [switch]$Reinstall)
    if ($Reinstall -and -not $Yes) { throw 'reinstall_requires_yes' }
    $root = $Storage.tools_root; $launcher = Join-Path $root 'js_exec.cmd'
    if (-not $Yes) {
        $found = Find-GiddBootstrapRuntime $Storage -Node:$Node
        $matches = $found.candidate -and [IO.File]::Exists($launcher) -and [IO.File]::ReadAllText($launcher) -ceq (Get-GiddLauncherText $found.candidate)
        return @{ schema='gidd.bootstrap/v1';status=$(if ($matches) {'ready'} else {'needs_bootstrap'});read_only=$true;
            runtime=$found.candidate;attempts=$found.attempts;launcher=$launcher;launcher_matches=[bool]$matches }
    }
    $lock = Open-GiddInstallLock $root
    $prepared = $null; $published = $false
    try {
        foreach ($name in @('bun','node')) { Restore-GiddInterruptedRuntime $root $name }
        $found = Find-GiddBootstrapRuntime $Storage -Node:$Node
        $candidate = $found.candidate
        if (-not $candidate -or $Reinstall) {
            $name = if ($Node) {'node'} else {'bun'}
            $target = Join-Path $root $name
            $replace = Test-Path -LiteralPath $target
            if ($replace -and -not (Test-GiddOwnedRuntime $target $name)) { throw "occupied_or_unknown_target:$name" }
            $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../../assets/runtimes.json')) | ConvertFrom-Json
            $pinned = @($manifest.tools | Where-Object name -eq $name) | Select-Object -First 1
            $definition = Resolve-GiddRelease $name $Storage.tools[$name] $pinned
            Write-GiddInstallationGuide $root
            $prepared = $name
            [void](Install-GiddTool $root $definition { param($phase) [Console]::Error.WriteLine("GIDD bootstrap: $phase") } -Replace:$replace -ValidatePayload {
                param($path,$runtimeName)
                if ((Invoke-GiddRuntimeCompatibility $path $runtimeName).status -ne 'compatible') { throw 'runtime_incompatible' }
            })
            $candidate = Find-Tool $name ([version]'0.0.0') '' (Join-Path $target "$name.exe") -Source managed -CheckCompatibility
            if ($candidate.status -ne 'ready') { throw 'bootstrap_runtime_unusable' }
        }
        Write-GiddInstallationGuide $root
        $action = Write-GiddLauncher $root (Get-GiddLauncherText $candidate)
        $published = $true; $cleanupPending = $false
        if ($candidate.details.source -eq 'managed') {
            try {
                Remove-GiddRuntimeBackup $root $candidate.id.Substring(5)
                Remove-GiddStage $root $candidate.id.Substring(5)
            } catch {
                $cleanupPending = $true
                [Console]::Error.WriteLine('GIDD bootstrap: launcher published; installation cache cleanup pending.')
            }
        }
        return @{ schema='gidd.bootstrap/v1';status='ready';read_only=$false;runtime=$candidate;attempts=$found.attempts;
            launcher=$launcher;launcher_action=$action;cleanup_pending=$cleanupPending;runtime_action=$(if ($prepared) {'installed'} else {'reused'}) }
    } catch {
        if ($prepared -and -not $published) { Restore-GiddRuntimeBackup $root $prepared }
        throw
    } finally { $lock.Dispose() }
}
