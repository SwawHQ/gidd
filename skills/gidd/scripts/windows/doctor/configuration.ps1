function Get-DoctorConfigurationChecks {
    param([string]$RepositoryRoot)
    if ($repositoryRoot) {
        $configPath = Join-Path $repositoryRoot '.agents/skills/gidd/config.toml'
        $configStatus = if (Test-Path -LiteralPath $configPath -PathType Leaf) { 'ready' }
            elseif (Test-Path -LiteralPath $configPath) { 'invalid' } else { 'missing' }
        New-Check 'repository.config' $configStatus 'file_presence_only' @{ path = $configPath }
    } else {
        New-Check 'repository.config' 'not_checked' 'repository_unavailable' @{ depends_on = @('repository') }
    }
    New-Check 'repository.config.validation' 'not_checked' 'not_implemented'
}
