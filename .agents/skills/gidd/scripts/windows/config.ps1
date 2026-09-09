[CmdletBinding()]
param([string]$RepositoryPath, [string]$Action, [string]$Key, [AllowEmptyString()][string]$Value)
# Compatibility entry: all operations follow the same native stage0.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments (@('config',$Action) + $(if ($Action -eq 'set') { @($Key,$Value) }) + @('--repository',$RepositoryPath))
