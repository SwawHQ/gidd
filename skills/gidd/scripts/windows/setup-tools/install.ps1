function Install-GiddTool {
    param([string]$ToolsRoot, $Definition, [string]$ArchiveDirectory = '', [scriptblock]$OnPhase = {})
    $name = $Definition.name
    if ($name -notin @('bun','gh','node')) { throw 'invalid_tool_name' }
    $target = Join-Path $ToolsRoot $name
    Assert-GiddPlainPath $target
    if (Test-Path -LiteralPath $target) {
        if (-not (Test-GiddManagedTool $target $name)) { throw "occupied_or_invalid_target:$name" }
        $existing = [IO.File]::ReadAllText((Join-Path $target 'install.json')) | ConvertFrom-Json
        if ($existing.version -ne $Definition.version) { throw "installed_version_conflict:${name}:$($existing.version):$($Definition.version)" }
        Remove-GiddStage $ToolsRoot $name
        return @{ name = $name; action = 'reused'; path = (Join-Path $target "$name.exe") }
    }
    Remove-GiddStage $ToolsRoot $name
    $stage = Join-Path $ToolsRoot ".cache/$name"
    $payload = Join-Path $stage 'payload'
    Assert-GiddPlainPath $payload
    [void][IO.Directory]::CreateDirectory($payload)
    $archive = Join-Path $stage 'download.part'
    $local = if ($ArchiveDirectory) { Join-Path $ArchiveDirectory $Definition.archive } else { '' }
    [Console]::Error.WriteLine("GIDD download: $name $($Definition.version) $($Definition.url)")
    Receive-GiddFile $Definition.url $archive $Definition.sha256 $local
    & $OnPhase 'downloaded'
    Expand-GiddPayload $archive $payload $Definition
    foreach ($file in $Definition.supplements) {
        if ($file.name -notmatch '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$') { throw 'invalid_supplement_name' }
        $local = if ($ArchiveDirectory) { Join-Path $ArchiveDirectory "$name-$($Definition.version)-$($file.name)" } else { '' }
        Receive-GiddFile $file.url (Join-Path $payload $file.name) $file.sha256 $local
    }
    & $OnPhase 'extracted'
    $probe = Invoke-GiddProcess (Join-Path $payload "$name.exe") @('--version')
    $pattern = if ($name -eq 'bun') { '^' + [regex]::Escape($Definition.version) + '$' }
        elseif ($name -eq 'node') { '^v' + [regex]::Escape($Definition.version) + '$' }
        else { '^gh version ' + [regex]::Escape($Definition.version) + '(?:\s|$)' }
    if (-not $probe.ok -or $probe.text -notmatch $pattern) { throw 'installed_version_mismatch' }
    $files = @(Get-ChildItem -LiteralPath $payload -File | ForEach-Object {
        @{ name = $_.Name; length = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
    })
    $record = @{ schema = 'gidd.install/v1'; name = $name; platform = 'windows-x64'; version = $Definition.version
        source = $Definition.url; archive_sha256 = $Definition.sha256; files = $files }
    if ($Definition.PSObject.Properties['metadata_sources']) { $record.metadata_sources = $Definition.metadata_sources }
    Write-GiddDurableFile (Join-Path $payload 'install.json') ([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 6)))
    if (-not (Test-GiddManagedTool $payload $name)) { throw 'staged_integrity_failed' }
    & $OnPhase 'verified'
    # Same-volume publish into an absent path. Never replace an existing directory.
    [IO.Directory]::Move($payload, $target)
    & $OnPhase 'published'
    if (-not (Test-GiddManagedTool $target $name)) { throw 'published_integrity_failed' }
    Remove-GiddStage $ToolsRoot $name
    return @{ name = $name; action = 'installed'; path = (Join-Path $target "$name.exe") }
}
