[CmdletBinding()]
param([string]$RepositoryPath)
# Compatibility entry: all operations follow the same native stage0.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments @('auth','--repository',$RepositoryPath)
