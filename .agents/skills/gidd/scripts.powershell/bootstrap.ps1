# Native entry for tool checks and explicit preparation.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

try {
    $inputArgs = @($args)
    $options = @{}; $repository = $null; $runtime = ''; $toolOnly = ''
    if (-not $inputArgs.Count -or $inputArgs[0] -in @('help','--help','-h')) {
        if ($inputArgs.Count -gt 2) { throw 'invalid_arguments' }
        $explicitLanguage = if ($inputArgs.Count -eq 2 -and $inputArgs[1]) { [string]$inputArgs[1] } else { $env:GIDD_LANG }
        if ($explicitLanguage -and $explicitLanguage -cnotmatch '^(zh|en)(?:$|[-_])') { throw 'unsupported_help_language' }
        $choice = @($explicitLanguage,$env:LC_ALL,$env:LC_MESSAGES,$env:LANG,[Globalization.CultureInfo]::CurrentUICulture.Name) |
            Where-Object { $_ } | Select-Object -First 1
        $language = if ($choice -cmatch '^zh(?:$|[-_])') { 'zh-CN' } else { 'en' }
        [Console]::WriteLine([IO.File]::ReadAllText((Join-Path $PSScriptRoot "help/$language.txt"), [Text.Encoding]::UTF8))
        exit 0
    }
    for ($i=0; $i -lt $inputArgs.Count; $i++) {
        $argument = [string]$inputArgs[$i]
        if ($argument -eq '--repo') { $argument = '--repository' }
        if ($argument -match '^--tools-only=(bun|node|git|gh)$') {
            if ($options.ContainsKey('--tools-only')) { throw 'invalid_arguments' }
            $toolOnly = $Matches[1].ToLowerInvariant(); $options['--tools-only'] = $true; continue
        }
        if ($argument -match '^--jsruntime=(bun|node)$') {
            if ($options.ContainsKey('--jsruntime')) { throw 'invalid_arguments' }
            $runtime = $Matches[1].ToLowerInvariant(); $options['--jsruntime'] = $true; continue
        }
        if ($options.ContainsKey($argument)) { throw 'invalid_arguments' }
        if ($argument -eq '--repository') {
            if ($i+1 -ge $inputArgs.Count -or -not $inputArgs[$i+1]) { throw 'invalid_arguments' }
            $i++; $repository = [string]$inputArgs[$i]
        } elseif ($argument -notin @('--check','--force')) { throw 'invalid_arguments' }
        $options[$argument] = $true
    }
    if ($toolOnly -and ($repository -or $runtime)) { throw 'tools_only_conflicts_with_repository_or_runtime' }
    if (-not $repository -and -not $toolOnly) { throw 'repository_required' }
    $checkOnly = $options.ContainsKey('--check')
    if ($checkOnly -and ($options.ContainsKey('--force') -or $runtime)) { throw 'check_conflicts_with_preparation' }
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1','_bootstrap.ps1','_repository.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1','prepare.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'unsupported_platform' }
    if ($toolOnly) {
        $storage = Resolve-GiddToolStorage
        if ($toolOnly -in @('bun','node')) {
            $report = Invoke-GiddBootstrap $storage -Yes:(-not $checkOnly) -Runtime $toolOnly -Reinstall:($options.ContainsKey('--force'))
        } else {
            $report = Invoke-GiddPrepareTools $storage -Names @($toolOnly) -CheckOnly:$checkOnly -Force:($options.ContainsKey('--force'))
        }
        $report.schema = 'gidd.tools/v1'; $report.tool = $toolOnly
        if ($report.status -ne 'ready') { $report.status = 'needs_tools' }
        $report | ConvertTo-Json -Depth 12 -Compress
        if ($report.status -eq 'ready') { exit 0 }; exit 1
    }
    if ($repository -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_absolute_local_path_required' }
    $root = [IO.Path]::GetFullPath($repository)
    if (-not [IO.Directory]::Exists($root)) { throw 'repository_directory_missing' }
    Assert-GiddPlainPath $root
    if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) { throw 'not_git_repository_root' }
    $sourceEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts.js/gidd.mjs'))
    [void](Get-GiddInstallationRepository $root $sourceEntry)
    $link = Join-Path $root '.agents/skills/gidd/gidd.link.cmd'
    if (-not $checkOnly) {
        Assert-GiddPlainPath $link
        if ([IO.Directory]::Exists($link)) { throw 'repository_entry_occupied' }
    }
    # An existing repository keeps its selected runtime until explicitly changed.
    if (-not $runtime -and [IO.File]::Exists($link)) {
        try {
            $text = [IO.File]::ReadAllText($link)
            if ($text -match '(?m)^rem GIDD_LINK ([A-Za-z0-9+/=]+)\r?$') {
                $metadata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1])) | ConvertFrom-Json
                if ($metadata.schema -eq 'gidd.repository-entry/v1' -and $metadata.runtime -in @('bun','node')) { $runtime = $metadata.runtime }
            }
        } catch { }
    }
    $storage = Resolve-GiddToolStorage
    $report = Invoke-GiddBootstrap $storage -Yes:(-not $checkOnly) -Runtime $runtime -Reinstall:($options.ContainsKey('--force'))
    $report.schema = 'gidd.tools/v1'
    if ($report.status -eq 'needs_bootstrap') { $report.status = 'needs_tools' }
    if (-not $report.runtime) {
        $report.tool_checks = @(@{ id='tools';status='not_checked';reason='runtime_unavailable' })
        $report.repository = $root
        $report.repository_check = @{ status='not_checked';reason='runtime_unavailable' }
        $report.entry = @{ status='not_checked';reason='runtime_unavailable' }
        $report | ConvertTo-Json -Depth 12 -Compress
        exit 1
    }
    $prepared = Invoke-GiddPrepareTools $storage -CheckOnly:$checkOnly -Force:($options.ContainsKey('--force'))
    $report.tools = $prepared.tools; $report.tool_checks = $prepared.checks; $report.binding_path = $prepared.binding_path
    if ($prepared.status -ne 'ready') { $report.status = 'needs_tools' }
    $report = Complete-GiddRepositoryPreparation $report $root $sourceEntry -CheckOnly:$checkOnly
    $report | ConvertTo-Json -Depth 12 -Compress
    if ($report.status -eq 'ready') { exit 0 }; exit 1
} catch {
    $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'tools_failed' }
    [Console]::Error.WriteLine('GIDD preparation failed. Use gidd.pre.ensure.cmd help en or help zh.')
    @{schema='gidd.tools/v1';status='error';reason=$reason} | ConvertTo-Json -Compress
    exit 2
}
