[CmdletBinding()]
param(
    [string]$RepositoryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    foreach ($file in @('_process.ps1', '_managed.ps1', '_tools.ps1', '_configuration.ps1')) {
        . (Join-Path $PSScriptRoot "lib/$file")
    }
    foreach ($file in @('platform.ps1', 'tools.ps1', 'repository.ps1', 'configuration.ps1')) {
        . (Join-Path $PSScriptRoot "doctor/$file")
    }
    if ([string]::IsNullOrWhiteSpace($RepositoryPath)) {
        throw 'RepositoryPath is required.'
    }
    foreach ($path in @($RepositoryPath)) {
        if ($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
            throw 'RepositoryPath must be absolute; expand the home directory before invocation.'
        }
    }
    $target = [IO.Path]::GetFullPath($RepositoryPath)
    $storage = $null; $configurationError = $null
    $resolutionRoot = $null
    if ([IO.Directory]::Exists($target)) {
        try { $resolutionRoot = Get-GiddRepositoryRoot $target }
        catch { $configurationError = 'repository_storage_path_invalid' }
    }
    if (-not $configurationError) {
        try { $storage = Resolve-GiddToolStorage $resolutionRoot }
        catch { $configurationError = $_.Exception.Message }
    }
    $toolsRoot = if ($storage) { $storage.tools_root } else { '' }
    $checks = New-Object System.Collections.Generic.List[object]
    $checks.Add((Get-DoctorPlatformCheck))
    if ($configurationError) {
        $checks.Add((New-Check 'tools.storage' 'invalid' $configurationError @{ managed_tools_checked = $false }))
    } else { $checks.Add((New-Check 'tools.storage' 'ready' 'resolved' $storage)) }
    $toolSettings = if ($storage) { $storage.tools } else { $null }
    $toolChecks = @(Get-DoctorToolChecks -ToolsRoot $toolsRoot -Settings $toolSettings)
    foreach ($check in $toolChecks) { $checks.Add($check) }
    $git = @($toolChecks | Where-Object { $_.id -eq 'tool.git' })[0]
    $repositoryChecks = @(Get-DoctorRepositoryChecks -Target $target -Git $git)
    foreach ($check in $repositoryChecks) { $checks.Add($check) }
    $repository = @($repositoryChecks | Where-Object { $_.id -eq 'repository' })[0]
    $repositoryRoot = if ($repository.status -eq 'ready') { $repository.details.path } else { $null }
    foreach ($check in @(Get-DoctorConfigurationChecks -RepositoryRoot $repositoryRoot -Storage $storage -ConfigurationError $configurationError)) { $checks.Add($check) }
    $checks.Add((New-Check 'github.identity' 'not_checked' 'offline_diagnostic'))
    $checks.Add((New-Check 'git.authentication' 'not_checked' 'offline_diagnostic'))
    $required = @('platform', 'tools.storage', 'tool.git', 'runtime', 'tool.gh', 'repository', 'repository.history', 'repository.remotes', 'repository.config', 'repository.config.validation')
    $incomplete = @($checks | Where-Object { $_.id -in $required -and $_.status -ne 'ready' }).Count -gt 0
    $status = if ($incomplete) { 'needs_setup' } else { 'local_ready' }
    [ordered]@{
        schema = 'gidd.doctor/v1'; status = $status; repository = $target
        checks = @($checks.ToArray())
    } | ConvertTo-Json -Depth 12 -Compress
    if ($incomplete) { exit 1 }
    exit 0
} catch {
    [Console]::Error.WriteLine('GIDD doctor could not complete. Supply an absolute -RepositoryPath and check filesystem access.')
    [ordered]@{ schema = 'gidd.doctor/v1'; status = 'error'; checks = @() } | ConvertTo-Json -Compress
    exit 2
}
