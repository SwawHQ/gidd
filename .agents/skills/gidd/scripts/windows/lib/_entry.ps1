# Legacy PowerShell/dev wrappers only forward; normal gidd.cmd never loads this.
function Invoke-GiddEntry {
    param([object[]]$CommandArguments)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($CommandArguments) -Compress)))
    & (Join-Path $PSScriptRoot '../../../gidd.cmd') '--encoded-arguments' $encoded
    exit $LASTEXITCODE
}
