[CmdletBinding()]
param([string]$RepositoryPath, [ValidateSet('bun','node','gh')][string]$Tool)
# Compatibility entry: all operations follow the same native stage0.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments (@('setup') + @($Tool | Where-Object { $_ }) + @('--repository',$RepositoryPath))
