param([string]$Source, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -OutputAssembly $Destination -OutputType ConsoleApplication
