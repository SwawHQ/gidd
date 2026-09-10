[CmdletBinding()]
param([string]$RepositoryPath, [string]$Action, [string]$Key, [AllowEmptyString()][string]$Value)
# Compatibility entry: operations forward through the generated shared launcher.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments (@('config',$Action) + $(if ($Action -eq 'set') { @($Key,$Value) }) + @('--repository',$RepositoryPath))
