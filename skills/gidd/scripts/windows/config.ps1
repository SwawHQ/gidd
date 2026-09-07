[CmdletBinding()]
param([string]$RepositoryPath, [ValidateSet('show','set')][string]$Action, [string]$Key, [string]$Value)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','lib/_configuration.ps1','doctor/platform.ps1','doctor/tools.ps1')) {
        . (Join-Path $PSScriptRoot $file)
    }
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    $target = Get-GiddRepositoryRoot $RepositoryPath
    $storage = Resolve-GiddToolStorage $target
    # Editing a version pin must remain possible before that version is installed.
    $checks = @(Get-DoctorToolChecks $storage.tools_root (Get-GiddDefaultTools))
    $runtime = @($checks | Where-Object id -eq 'runtime')[0]
    if ($runtime.status -ne 'ready') { throw 'runtime_unavailable' }
    $arguments = @((Join-Path $PSScriptRoot '../config.mjs'), '--repository', $target, '--action', $Action)
    if ($Action -eq 'set') { $arguments += @('--key', $Key, '--value', $Value) }
    & $runtime.details.path @arguments
    exit $LASTEXITCODE
} catch {
    $reason = if ($_.Exception.Message -match '^(runtime_unavailable|unsupported_platform|config_[a-z_]+(?::[a-z_.0-9]+)?)$') { $_.Exception.Message } else { 'config_bootstrap_failed' }
    @{ schema='gidd.config/v1'; status='error'; reason=$reason } | ConvertTo-Json -Compress
    exit 2
}
