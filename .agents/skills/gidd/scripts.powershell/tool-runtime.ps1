param([ValidateSet('','node','bun')][string]$Unavailable = '')
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_bootstrap.ps1')) {
    . (Join-Path $PSScriptRoot "lib/$file")
}
$runtimeRoot = Join-Path $env:USERPROFILE '.agents/skills.tools/gidd'
function Test-PreparedRuntime([string]$Name) {
    try {
        $candidate = Get-GiddBoundRuntime $runtimeRoot -Runtime $Name
        return $candidate -and (Invoke-GiddRuntimeCompatibility $candidate.details.path $Name).status -eq 'compatible'
    } catch { return $false }
}

if (-not $Unavailable) {
    if (Test-PreparedRuntime 'node') { exit 0 }
    [Console]::Error.WriteLine('GIDD: runtime_unavailable. Run tools.ensure.cmd node to repair Node.js for tool forwarding.')
    $Unavailable = 'node'
}
$other = if ($Unavailable -eq 'node') { 'bun' } else { 'node' }
if (Test-PreparedRuntime $other) {
    $command = if ($other -eq 'node') { 'gidd node' } else { 'bun.link.cmd directly' }
    [Console]::Error.WriteLine("  ${other}: available. Use $command.")
}
exit 2
