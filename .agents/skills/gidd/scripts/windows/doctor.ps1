[CmdletBinding()]
param([string]$RepositoryPath, [switch]$Offline)
# Compatibility entry: operations forward through the generated shared launcher.
. (Join-Path $PSScriptRoot 'lib/_entry.ps1')
$arguments = @('doctor','--repository',$RepositoryPath)
if ($Offline) { $arguments += '--offline' }
Invoke-GiddEntry -CommandArguments $arguments
