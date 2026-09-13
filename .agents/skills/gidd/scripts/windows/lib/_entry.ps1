# Legacy PowerShell/dev wrappers resolve the prepared runtime and forward to JS.
function Invoke-GiddEntry {
    param([object[]]$CommandArguments)
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1','_bootstrap.ps1')) {
        . (Join-Path $PSScriptRoot $file)
    }
    $storage = Resolve-GiddToolStorage
    $runtime = Get-GiddBoundRuntime $storage.tools_root
    if (-not $runtime) {
        [Console]::Error.WriteLine('GIDD runtime launcher missing or invalid. Run gidd.pre.ensure.cmd --repo with the target directory.')
        [Console]::WriteLine('{"schema":"gidd.cli/v1","status":"error","reason":"bootstrap_required"}')
        exit 2
    }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($CommandArguments) -Compress)))
    & $runtime.details.path (Join-Path $PSScriptRoot '../../gidd.mjs') '--encoded-arguments' $encoded
    exit $LASTEXITCODE
}
