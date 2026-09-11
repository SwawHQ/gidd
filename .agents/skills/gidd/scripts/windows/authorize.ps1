[CmdletBinding()]
param([string]$RepositoryPath)
# Compatibility entry: operations forward through the generated shared launcher.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments @('auth','--repository',$RepositoryPath)
