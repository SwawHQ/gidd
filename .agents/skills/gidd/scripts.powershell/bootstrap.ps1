# Native entry: prepare shared tools without a repository or JavaScript prerequisite.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$rows = @()
. (Join-Path $PSScriptRoot 'lib/_report.ps1')

try {
    $inputArgs = @($args)
    if ($inputArgs.Count -and $inputArgs[0] -in @('help','--help','-h')) {
        if ($inputArgs.Count -gt 2) { throw 'invalid_arguments' }
        $explicitLanguage = if ($inputArgs.Count -eq 2 -and $inputArgs[1]) { [string]$inputArgs[1] } else { '' }
        if ($explicitLanguage -and $explicitLanguage -cnotmatch '^(zh|en)(?:$|[-_])') { throw 'unsupported_help_language' }
        # Use the same regional locale as JavaScript Intl.
        $choice = if ($explicitLanguage) { $explicitLanguage } else { [Globalization.CultureInfo]::CurrentCulture.Name }
        $language = if ($choice -cmatch '^zh(?:$|[-_])') { 'zh-CN' } else { 'en' }
        [Console]::WriteLine([IO.File]::ReadAllText((Join-Path $PSScriptRoot "../references/tools.ensure.help.$language.md"), [Text.Encoding]::UTF8))
        exit 0
    }
    $tool = ''; $checkOnly = $false; $force = $false
    if ($inputArgs.Count) {
        $tool = ([string]$inputArgs[0]).ToLowerInvariant()
        if ($tool -notin @('bun','node','git','gh') -or $inputArgs.Count -gt 2) { throw 'invalid_arguments' }
        if ($inputArgs.Count -eq 2) {
            switch ($inputArgs[1]) {
                '--check' { $checkOnly = $true }
                '--force' { $force = $true }
                default { throw 'invalid_arguments' }
            }
        }
    }
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1','_bootstrap.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1','prepare.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'unsupported_platform' }
    $storage = Resolve-GiddToolStorage
    if ($tool -in @('git','gh')) {
        $prepared = Invoke-GiddPrepareTools $storage -Names @($tool) -CheckOnly:$checkOnly -Force:$force
        $rows += Convert-GiddNativeReport $prepared @($tool)
    } else {
        $prepared = Invoke-GiddBootstrap $storage -Yes:(-not $checkOnly) -Runtime $tool -Reinstall:$force
        $rows += Convert-GiddRuntimeReport $prepared $tool
        if (-not $tool) {
            $prepared = Invoke-GiddPrepareTools $storage
            $rows += Convert-GiddNativeReport $prepared @('git','gh')
        }
    }
    $report = New-GiddToolsReport $rows
    $report | ConvertTo-Json -Depth 12 -Compress
    if ($report.status -eq 'ready') { exit 0 }; exit 1
} catch {
    $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'tools_failed' }
    [Console]::Error.WriteLine('GIDD preparation failed. Use tools.ensure.cmd help en or help zh.')
    New-GiddToolsReport $rows $reason $_.Exception.Data['gidd_download'] | ConvertTo-Json -Depth 12 -Compress
    exit 2
}
