function Get-DoctorConfigurationChecks {
    param([string]$RepositoryRoot, $Storage, [string]$ConfigurationError)
    if ($repositoryRoot) {
        $configPath = Join-Path $repositoryRoot '.agents/skills/gidd/config.toml'
        $configStatus = if (Test-Path -LiteralPath $configPath -PathType Leaf) { 'ready' }
            elseif (Test-Path -LiteralPath $configPath) { 'invalid' } else { 'missing' }
        New-Check 'repository.config' $configStatus 'file_presence_only' @{ path = $configPath }
        if ($ConfigurationError) {
            New-Check 'repository.config.validation' 'invalid' $ConfigurationError
        } elseif ($configStatus -eq 'ready' -and $Storage -and $Storage.configured) {
            New-Check 'repository.config.validation' 'ready' 'tool_storage_schema_v1' @{ tools_root = $Storage.tools_root }
        } else { New-Check 'repository.config.validation' 'not_checked' 'config_missing' }
    } else {
        New-Check 'repository.config' 'not_checked' 'repository_unavailable' @{ depends_on = @('repository') }
        New-Check 'repository.config.validation' 'not_checked' 'repository_unavailable'
    }
}
