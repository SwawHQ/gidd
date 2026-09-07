[CmdletBinding()]
param([string]$RepositoryPath, [string]$CandidatePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    $null = Resolve-GiddToolStorage -RepositoryRoot $RepositoryPath -CandidatePath $CandidatePath
    @{ status='ready' } | ConvertTo-Json -Compress
} catch {
    @{ status='error'; reason=$_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
