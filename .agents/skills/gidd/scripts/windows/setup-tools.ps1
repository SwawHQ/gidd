[CmdletBinding()]
param([string]$RepositoryPath, [ValidateSet('bun','node','gh')][string]$Tool)
# Compatibility entry: operations forward through the generated shared launcher.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
Invoke-GiddEntry -CommandArguments (@('setup') + @($Tool | Where-Object { $_ }) + @('--repository',$RepositoryPath))
