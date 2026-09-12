# Native entry for tool checks and explicit preparation.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Assert-GiddInstallationRepository {
    param([string]$Repository)
    $skill = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')
    Assert-GiddPlainPath $skill
    $ancestor = $skill
    while ($ancestor) {
        if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) {
            $knownLayout = $false
            foreach ($layout in @('.agents','.claude')) {
                $expected = [IO.Path]::GetFullPath((Join-Path $ancestor "$layout/skills/gidd"))
                if ($skill -eq $expected) { $knownLayout = $true; break }
            }
            if (-not $knownLayout) { throw 'installation_scope_unknown' }
            if ($ancestor.TrimEnd('\') -ne $Repository.TrimEnd('\')) { throw 'installation_repository_mismatch' }
            return
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}

try {
    $inputArgs = @($args)
    $options = @{}; $repository = $null; $runtime = ''
    if (-not $inputArgs.Count -or $inputArgs[0] -in @('help','--help','-h')) {
        if ($inputArgs.Count -gt 2) { throw 'invalid_arguments' }
        $explicitLanguage = if ($inputArgs.Count -eq 2 -and $inputArgs[1]) { [string]$inputArgs[1] } else { $env:GIDD_LANG }
        if ($explicitLanguage -and $explicitLanguage -cnotmatch '^(zh|en)(?:$|[-_])') { throw 'unsupported_help_language' }
        $choice = @($explicitLanguage,$env:LC_ALL,$env:LC_MESSAGES,$env:LANG,[Globalization.CultureInfo]::CurrentUICulture.Name) |
            Where-Object { $_ } | Select-Object -First 1
        $language = if ($choice -cmatch '^zh(?:$|[-_])') { 'zh-CN' } else { 'en' }
        [Console]::WriteLine([IO.File]::ReadAllText((Join-Path $PSScriptRoot "../help/pre-ensure/$language.txt"), [Text.Encoding]::UTF8))
        exit 0
    }
    for ($i=0; $i -lt $inputArgs.Count; $i++) {
        $argument = [string]$inputArgs[$i]
        if ($argument -eq '--repo') { $argument = '--repository' }
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
    if (-not $repository) { throw 'repository_required' }
    $checkOnly = $options.ContainsKey('--check')
    if ($checkOnly -and ($options.ContainsKey('--force') -or $runtime)) { throw 'check_conflicts_with_preparation' }
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1','_bootstrap.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'unsupported_platform' }
    if ($repository -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_absolute_local_path_required' }
    $root = [IO.Path]::GetFullPath($repository)
    if (-not [IO.Directory]::Exists($root)) { throw 'repository_directory_missing' }
    Assert-GiddPlainPath $root
    if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) { throw 'not_git_repository_root' }
    Assert-GiddInstallationRepository $root
    $link = Join-Path $root '.agents/skills/gidd/gidd.link.cmd'
    if (-not $checkOnly) {
        Assert-GiddPlainPath $link
        if ([IO.Directory]::Exists($link)) { throw 'repository_entry_occupied' }
    }
    $report = Invoke-GiddBootstrap (Resolve-GiddToolStorage $root) -Yes:(-not $checkOnly) -Runtime $runtime -Reinstall:($options.ContainsKey('--force'))
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
    $jsArguments = @((Join-Path $PSScriptRoot '../bootstrap-tools.mjs'),'--repository',$root)
    if ($checkOnly) { $jsArguments += '--check' }
    if ($options.ContainsKey('--force')) { $jsArguments += '--force' }
    $OutputEncoding = New-Object Text.UTF8Encoding($false)
    # Bypass a second cmd expansion of Unicode/percent paths.
    $executor = $report.runtime.details.path
    ($report | ConvertTo-Json -Depth 12 -Compress) | & $executor @jsArguments
    exit $LASTEXITCODE
} catch {
    $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'tools_failed' }
    [Console]::Error.WriteLine('GIDD preparation failed. Use gidd.pre.ensure.cmd help en or help zh.')
    @{schema='gidd.tools/v1';status='error';reason=$reason} | ConvertTo-Json -Compress
    exit 2
}
