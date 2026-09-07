[CmdletBinding()]
param([string]$RepositoryPath,
    [string]$DefaultToolsDirectory = '~/.agents/skills/gidd.tools')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    if ($RepositoryPath -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_must_be_absolute' }
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','lib/_configuration.ps1','doctor/platform.ps1','doctor/tools.ps1')) {
        . (Join-Path $PSScriptRoot $file)
    }
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    $target = Get-GiddRepositoryRoot $RepositoryPath
    $storage = Resolve-GiddToolStorage $target $DefaultToolsDirectory
    $checks = @(Get-DoctorToolChecks $storage.tools_root $storage.tools -GhMinimum '2.98.0')
    $runtime = @($checks | Where-Object id -eq 'runtime')[0]
    $gh = @($checks | Where-Object id -eq 'tool.gh')[0]
    if ($runtime.status -ne 'ready') { throw 'runtime_unavailable' }
    if ($gh.status -ne 'ready') { throw 'gh_unavailable' }
    & $runtime.details.path (Join-Path $PSScriptRoot '../auth.mjs') --repository $target --gh $gh.details.path
    exit $LASTEXITCODE
} catch {
    $reason = if ($_.Exception.Message -in @('expected_account_required','repository_must_be_absolute','unsupported_platform','runtime_unavailable','gh_unavailable')) {
        $_.Exception.Message
    } else { 'bootstrap_failed_run_offline_doctor' }
    @{ schema='gidd.auth/v1'; status='error'; reason=$reason } | ConvertTo-Json
    exit 2
}
