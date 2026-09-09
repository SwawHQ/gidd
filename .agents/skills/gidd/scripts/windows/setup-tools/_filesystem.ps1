function Write-GiddDurableFile {
    param([string]$Path, [byte[]]$Bytes)
    Assert-GiddPlainPath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Remove-GiddStage {
    param([string]$ToolsRoot, [string]$Name)
    if ($Name -notin @('bun','gh','node')) { throw 'invalid_tool_name' }
    $stage = [IO.Path]::GetFullPath((Join-Path $ToolsRoot ".cache/$Name"))
    $expected = [IO.Path]::GetFullPath($ToolsRoot).TrimEnd('\') + '\.cache\' + $Name
    if ($stage -ne $expected) { throw 'stage_outside_root' }
    Assert-GiddPlainPath $stage
    if (-not (Test-Path -LiteralPath $stage)) { return }
    # Inspect recursively ourselves: never traverse a reparse directory during cleanup.
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($stage)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse_stage' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $stage -Recurse -Force
}

function Open-GiddInstallLock {
    param([string]$ToolsRoot)
    Assert-GiddPlainPath $ToolsRoot
    [void][IO.Directory]::CreateDirectory($ToolsRoot)
    $cacheRoot = Join-Path $ToolsRoot '.cache'
    Assert-GiddPlainPath $cacheRoot
    [void][IO.Directory]::CreateDirectory($cacheRoot)
    $lockPath = Join-Path $ToolsRoot '.cache/install.lock'
    Assert-GiddPlainPath $lockPath
    $token = [guid]::NewGuid().ToString()
    $marker = "owner-$token.json"
    $prepared = Join-Path $cacheRoot "lock-$token"
    [void][IO.Directory]::CreateDirectory($prepared)
    Write-GiddDurableFile (Join-Path $prepared $marker) ([Text.Encoding]::UTF8.GetBytes((@{schema='gidd.lock/v1';pid=$PID;token=$token} | ConvertTo-Json -Compress)))
    try {
        for ($attempt = 0; $attempt -lt 4; $attempt++) {
            Assert-GiddPlainPath $lockPath
            if (Test-Path -LiteralPath $lockPath) {
                $item = Get-Item -LiteralPath $lockPath -Force
                if (-not $item.PSIsContainer -and $item.Length -eq 0) {
                    $retired = Join-Path $cacheRoot "legacy-$token"
                    try { [IO.File]::Move($lockPath,$retired); [IO.File]::Delete($retired) }
                    catch { throw 'install_locked_or_unwritable' }
                } elseif ($item.PSIsContainer) {
                    $entries = @(Get-ChildItem -LiteralPath $lockPath -Force)
                    if (-not $entries.Count) { try { [IO.Directory]::Delete($lockPath) } catch {}; continue }
                    if ($entries.Count -ne 1 -or $entries[0].Name -notmatch '^owner-[a-f0-9-]{36}\.json$' -or $entries[0].Length -gt 1024) { throw 'install_locked_or_unwritable' }
                    Assert-GiddPlainPath $entries[0].FullName
                    $owner = [IO.File]::ReadAllText($entries[0].FullName) | ConvertFrom-Json
                    if ($owner.schema -ne 'gidd.lock/v1' -or $owner.pid -le 0 -or $entries[0].Name -ne "owner-$($owner.token).json") { throw 'install_locked_or_unwritable' }
                    $dead = $false
                    try { $process = [Diagnostics.Process]::GetProcessById($owner.pid); $process.Dispose() }
                    catch [ArgumentException] { $dead = $true }
                    if (-not $dead) { throw 'install_locked_or_unwritable' }
                    Remove-GiddLockMarker $lockPath $entries[0].Name
                    continue
                } else { throw 'install_locked_or_unwritable' }
            }
            try { [IO.Directory]::Move($prepared,$lockPath) }
            catch { if (-not (Test-Path -LiteralPath $lockPath)) { throw }; continue }
            $handle = [pscustomobject]@{ Path=$lockPath; Marker=$marker }
            $handle | Add-Member -MemberType ScriptMethod -Name Dispose -Value { Remove-GiddLockMarker $this.Path $this.Marker }
            return $handle
        }
        throw 'install_locked_or_unwritable'
    } finally { if ([IO.Directory]::Exists($prepared)) { Remove-GiddLockMarker $prepared $marker } }
}

function Remove-GiddLockMarker {
    param([string]$Path, [string]$Marker)
    # Delete only this owner's unique marker, then only an empty directory.
    [IO.File]::Delete((Join-Path $Path $Marker))
    try { [IO.Directory]::Delete($Path) }
    catch [IO.IOException] { if ([IO.Directory]::Exists($Path) -and -not @(Get-ChildItem -LiteralPath $Path -Force).Count) { throw } }
}

function Write-GiddInstallationGuide {
    param([string]$ToolsRoot)
    $destination = Join-Path $ToolsRoot 'INSTALLATION.md'
    $temporary = Join-Path $ToolsRoot '.INSTALLATION.tmp'
    Assert-GiddPlainPath $destination
    $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../../assets/INSTALLATION.md'))
    if ([IO.File]::Exists($destination) -and [IO.File]::ReadAllText($destination) -ceq $text) { return }
    Write-GiddDurableFile $temporary ([Text.Encoding]::UTF8.GetBytes($text))
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $destination) }
}
