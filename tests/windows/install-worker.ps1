param([string]$CodeRoot, [string]$ToolsRoot, [string]$DefinitionPath, [string]$ArchiveDirectory, [string]$StopAt = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','setup-tools/_filesystem.ps1','setup-tools/download.ps1','setup-tools/install.ps1')) {
    . (Join-Path $CodeRoot $file)
}
$lock = $null
try {
    $definition = [IO.File]::ReadAllText($DefinitionPath) | ConvertFrom-Json
    $lock = Open-GiddInstallLock $ToolsRoot
    if ($StopAt -eq 'locked') {
        [IO.File]::WriteAllText(($DefinitionPath + '.locked'), 'locked')
        Start-Sleep -Seconds 30
    }
    $result = Install-GiddTool $ToolsRoot $definition $ArchiveDirectory {
        param($phase)
        if ($phase -eq $StopAt) { [Diagnostics.Process]::GetCurrentProcess().Kill() }
    }
    $result | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
