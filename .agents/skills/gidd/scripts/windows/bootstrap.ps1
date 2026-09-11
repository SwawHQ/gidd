# Explicit native bootstrap. No JavaScript runtime is needed to reach this entry.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $inputArgs = @($args)
    if ($inputArgs.Count -and $inputArgs[0] -eq 'bootstrap') { $inputArgs = @($inputArgs | Select-Object -Skip 1) }
    $options = @{}; $repository = $null
    for ($i=0; $i -lt $inputArgs.Count; $i++) {
        $argument = [string]$inputArgs[$i]
        if ($options.ContainsKey($argument)) { throw 'invalid_arguments' }
        if ($argument -eq '--repository') {
            if ($i+1 -ge $inputArgs.Count -or -not $inputArgs[$i+1]) { throw 'invalid_arguments' }
            $i++; $repository = [string]$inputArgs[$i]
        } elseif ($argument -notin @('--yes','--node','--reinstall')) { throw 'invalid_arguments' }
        $options[$argument] = $true
    }
    if ($options.ContainsKey('--reinstall') -and -not $options.ContainsKey('--yes')) { throw 'reinstall_requires_yes' }
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1','_bootstrap.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'unsupported_platform' }
    if (-not $repository) {
        $skill = Get-Item -LiteralPath (Join-Path $PSScriptRoot '../..')
        if ($skill.Name -eq 'gidd' -and $skill.Parent.Name -eq 'skills' -and $skill.Parent.Parent.Name -eq '.agents' -and
            (Test-Path -LiteralPath (Join-Path $skill.Parent.Parent.Parent.FullName '.git'))) { $repository = $skill.Parent.Parent.Parent.FullName }
    }
    $root = if ($repository) { Get-GiddRepositoryRoot $repository } else { $null }
    $report = Invoke-GiddBootstrap (Resolve-GiddToolStorage $root) -Yes:($options.ContainsKey('--yes')) -Node:($options.ContainsKey('--node')) -Reinstall:($options.ContainsKey('--reinstall'))
    $report | ConvertTo-Json -Depth 12 -Compress
    if ($report.status -eq 'ready') { exit 0 } else { exit 1 }
} catch {
    $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'bootstrap_failed' }
    [Console]::Error.WriteLine('GIDD bootstrap failed. Existing installations and the launcher are retained where possible.')
    @{schema='gidd.bootstrap/v1';status='error';reason=$reason} | ConvertTo-Json -Compress
    exit 2
}
