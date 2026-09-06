function Write-GiddDurableFile {
    param([string]$Path, [byte[]]$Bytes)
    Assert-GiddPlainPath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Remove-GiddStage {
    param([string]$ToolsRoot, [string]$Name)
    if ($Name -notin @('bun','gh')) { throw 'invalid_tool_name' }
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
    try { return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { throw 'install_locked_or_unwritable' }
}

function Write-GiddInstallationGuide {
    param([string]$ToolsRoot)
    $destination = Join-Path $ToolsRoot 'INSTALLATION.md'
    $temporary = Join-Path $ToolsRoot '.INSTALLATION.tmp'
    Assert-GiddPlainPath $destination
    $text = @'
# GIDD-managed tools

This directory is shared by repositories using this user's GIDD skill root.
It is not a skill: do not add SKILL.md or repository config.toml here.

- bun/ and gh/: published tool files, upstream license materials and install.json.
- install.json: tool version, upstream source and file hashes; do not edit it.
- .cache/bun/ and .cache/gh/: temporary downloads and extraction; removed after success
  or rebuilt on the next explicit retry. Download archives are not retained.
- .cache/install.lock: OS file lock; its presence alone does not mean installation is running.

Run setup-tools.ps1 again after an interruption. The installer verifies completed
directories and never overwrites an occupied final directory. A corrupt or unknown
final directory requires explicit review; keep it until its ownership is clear.
Do not delete .cache/ or its lock file while an installer is running.

When uninstalling, distinguish one repository from all shared tools. Remove this
whole directory only when removal of shared GIDD tools is intended and no installer
is running. External PATH tools are not owned here. Deleting files does not revoke
GitHub authorization. GIDD's MIT license does not replace upstream tool licenses.
'@
    if ([IO.File]::Exists($destination) -and [IO.File]::ReadAllText($destination) -ceq $text) { return }
    Write-GiddDurableFile $temporary ([Text.Encoding]::UTF8.GetBytes($text))
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $destination) }
}
