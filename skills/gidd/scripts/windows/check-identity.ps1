[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryPath,
    [string]$Hostname = 'github.com',
    [string]$Account = '',
    [string]$Remote = 'origin'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','lib/_configuration.ps1','doctor/platform.ps1','doctor/tools.ps1')) {
        . (Join-Path $PSScriptRoot $file)
    }
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    if ($RepositoryPath -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_must_be_absolute' }
    $target = Get-GiddRepositoryRoot $RepositoryPath
    $storage = Resolve-GiddToolStorage $target
    $checks = @(Get-DoctorToolChecks $storage.tools_root $storage.tools)
    $runtime = @($checks | Where-Object id -eq 'runtime')[0]
    if ($runtime.status -ne 'ready') { throw 'runtime_unavailable' }
    $arguments = @((Join-Path $PSScriptRoot '../github.mjs'), '--repository', $target, '--hostname', $Hostname, '--remote', $Remote)
    if ($Account) { $arguments += @('--account', $Account) }
    foreach ($name in @('git','gh')) {
        $tool = @($checks | Where-Object id -eq "tool.$name")[0]
        if ($tool.status -eq 'ready') { $arguments += @("--$name", $tool.details.path) }
    }
    & $runtime.details.path @arguments
    exit $LASTEXITCODE
} catch {
    $reason = if ($_.Exception.Message -in @('unsupported_platform','repository_must_be_absolute','runtime_unavailable')) {
        $_.Exception.Message
    } else { 'bootstrap_failed_run_offline_doctor' }
    @{ schema='gidd.identity/v1'; status='error'; reason=$reason } | ConvertTo-Json
    exit 2
}
