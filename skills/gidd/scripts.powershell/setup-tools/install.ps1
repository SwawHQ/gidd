function Install-GiddTool {
    param([string]$ToolsRoot, $Definition, [scriptblock]$OnPhase = {}, [switch]$Replace, [scriptblock]$ValidatePayload = {})
    $name = $Definition.name
    if ($name -notin @('bun','node','git','gh')) { throw 'invalid_tool_name' }
    $target = Join-Path $ToolsRoot $name
    Assert-GiddPlainPath $target
    if (Test-Path -LiteralPath (Get-GiddRuntimeBackupPath $ToolsRoot $name)) { throw "pending_runtime_recovery:$name" }
    if ($Replace -and (Test-Path -LiteralPath $target) -and -not (Test-GiddOwnedRuntime $target $name)) { throw "occupied_or_unknown_target:$name" }
    if (-not $Replace -and (Test-Path -LiteralPath $target)) {
        if (-not (Test-GiddManagedTool $target $name)) { throw "occupied_or_invalid_target:$name" }
        $existing = [IO.File]::ReadAllText((Join-Path $target 'install.json')) | ConvertFrom-Json
        if ($existing.version -ne $Definition.version) { throw "installed_version_conflict:${name}:$($existing.version):$($Definition.version)" }
        Remove-GiddStage $ToolsRoot $name
        return @{ name = $name; action = 'reused'; path = (Join-Path $target (Get-GiddExecutableName $name)) }
    }
    Remove-GiddStage $ToolsRoot $name
    $stage = Join-Path $ToolsRoot ".cache/$name"
    $payload = Join-Path $stage 'payload'
    Assert-GiddPlainPath $payload
    [void][IO.Directory]::CreateDirectory($payload)
    $archive = Join-Path $stage 'download.part'
    [Console]::Error.WriteLine("GIDD download: $name $($Definition.version) $($Definition.url)")
    Receive-GiddFile $Definition.url $archive $Definition.sha256
    & $OnPhase 'downloaded'
    Expand-GiddPayload $archive $payload $Definition
    foreach ($file in $(if ($Definition.PSObject.Properties['supplements']) { $Definition.supplements } else { @() })) {
        if ($file.name -notmatch '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$') { throw 'invalid_supplement_name' }
        Receive-GiddFile $file.url (Join-Path $payload $file.name) $file.sha256
    }
    & $OnPhase 'extracted'
    $probe = Invoke-GiddProcess (Join-Path $payload (Get-GiddExecutableName $name)) @('--version')
    $pattern = if ($name -eq 'bun') { '^' + [regex]::Escape($Definition.version) + '$' }
        elseif ($name -eq 'node') { '^v' + [regex]::Escape($Definition.version) + '$' }
        elseif ($name -eq 'git') { '^git version ' + [regex]::Escape($Definition.reported_version) + '$' }
        else { '^gh version ' + [regex]::Escape($Definition.version) + '(?:\s|$)' }
    if (-not $probe.ok -or $probe.text -notmatch $pattern) { throw 'installed_version_mismatch' }
    $canonicalPayload = (Get-Item -LiteralPath $payload -Force).FullName
    $files = @(Get-ChildItem -LiteralPath $payload -File -Recurse | ForEach-Object {
        @{ name = $_.FullName.Substring($canonicalPayload.TrimEnd('\').Length + 1).Replace('\','/'); length = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
    })
    $record = @{ schema = $(if ($name -eq 'git') {'gidd.install/v2'} else {'gidd.install/v1'}); installation_id=[guid]::NewGuid().ToString(); name = $name; platform = 'windows-x64'; version = $Definition.version
        source = $Definition.url; archive_sha256 = $Definition.sha256; files = $files }
    if ($Definition.PSObject.Properties['metadata_sources']) { $record.metadata_sources = $Definition.metadata_sources }
    Write-GiddDurableFile (Join-Path $payload 'install.json') ([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 6)))
    if (-not (Test-GiddManagedTool $payload $name)) { throw 'staged_integrity_failed' }
    & $ValidatePayload (Join-Path $payload (Get-GiddExecutableName $name)) $name
    & $OnPhase 'verified'
    $backup = Get-GiddRuntimeBackupPath $ToolsRoot $name
    try {
        if ($Replace -and (Test-Path -LiteralPath $target)) {
            if (-not (Test-GiddOwnedRuntime $target $name)) { throw "occupied_or_unknown_target:$name" }
            if (Test-Path -LiteralPath $backup) { throw "pending_runtime_recovery:$name" }
            [IO.Directory]::Move($target,$backup)
            & $OnPhase 'backed_up'
        }
        [IO.Directory]::Move($payload, $target)
        & $OnPhase 'published'
        if (-not (Test-GiddManagedTool $target $name)) { throw 'published_integrity_failed' }
    } catch { Restore-GiddRuntimeBackup $ToolsRoot $name; throw }
    Remove-GiddStage $ToolsRoot $name
    return @{ name = $name; action = 'installed'; path = (Join-Path $target (Get-GiddExecutableName $name)) }
}

# A readable GIDD record identifies owned files even when their contents are
# damaged. Missing/malformed records, extra files, directories and links survive.
function Test-GiddOwnedRuntime {
    param([string]$Path, [string]$Name)
    return Test-GiddManagedTool $Path $Name -AllowDamaged
}

function Get-GiddRuntimeBackupPath {
    param([string]$Root, [string]$Name)
    if ($Name -notin @('bun','node','git','gh')) { throw 'invalid_tool_name' }
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $path = [IO.Path]::GetFullPath((Join-Path $rootPath ".cache/previous-$Name"))
    if ($path -ne "$rootPath\.cache\previous-$Name") { throw 'backup_outside_root' }
    Assert-GiddPlainPath $path
    return $path
}

function Remove-GiddRuntimeBackup {
    param([string]$Root, [string]$Name)
    $backup = Get-GiddRuntimeBackupPath $Root $Name
    if (Test-Path -LiteralPath $backup) {
        if (-not (Test-GiddOwnedRuntime $backup $Name)) { throw "unknown_runtime_backup:$Name" }
        # After publication, partial cleanup must never become a recovery backup.
        $retired = [IO.Path]::GetFullPath((Join-Path $Root ('.cache/retired-' + $Name + '-' + [guid]::NewGuid().ToString())))
        $expected = [IO.Path]::GetFullPath((Join-Path $Root '.cache')).TrimEnd('\') + '\'
        if (-not $retired.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'backup_outside_root' }
        Assert-GiddPlainPath $retired
        [IO.Directory]::Move($backup,$retired)
        Remove-Item -LiteralPath $retired -Recurse -Force
    }
}

function Restore-GiddRuntimeBackup {
    param([string]$Root, [string]$Name)
    $backup = Get-GiddRuntimeBackupPath $Root $Name
    if (-not (Test-Path -LiteralPath $backup)) { return }
    if (-not (Test-GiddOwnedRuntime $backup $Name)) { throw "unknown_runtime_backup:$Name" }
    $target = [IO.Path]::GetFullPath((Join-Path $Root $Name))
    if ($target -ne ([IO.Path]::GetFullPath($Root).TrimEnd('\') + "\$Name")) { throw 'target_outside_root' }
    Assert-GiddPlainPath $target
    if (Test-Path -LiteralPath $target) {
        if (-not (Test-GiddManagedTool $target $Name)) { throw "runtime_recovery_target_conflict:$Name" }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    [IO.Directory]::Move($backup,$target)
}
