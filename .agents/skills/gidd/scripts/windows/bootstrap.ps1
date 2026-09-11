# Native entry for explicit tool management; no JS runtime required to show help.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $inputArgs = @($args)
    if ($inputArgs.Count -and $inputArgs[0] -eq 'tools') { $inputArgs = @($inputArgs | Select-Object -Skip 1) }
    if (-not $inputArgs.Count) {
        $language = if ($env:GIDD_LANG) { $env:GIDD_LANG } elseif ($env:LC_ALL) { $env:LC_ALL } elseif ($env:LC_MESSAGES) { $env:LC_MESSAGES } elseif ($env:LANG) { $env:LANG } else { [Globalization.CultureInfo]::CurrentUICulture.Name }
        $helpFile = if ($language -match '^zh') { 'zh-CN.txt' } else { 'en.txt' }
        [Console]::Write([IO.File]::ReadAllText((Join-Path $PSScriptRoot "../help/$helpFile"),[Text.Encoding]::UTF8))
        exit 0
    }
    $options = @{}; $repository = $null; $runtime = ''
    for ($i=0; $i -lt $inputArgs.Count; $i++) {
        $argument = [string]$inputArgs[$i]
        if ($argument -match '^--jsruntime=(bun|node)$') {
            if ($options.ContainsKey('--jsruntime')) { throw 'invalid_arguments' }
            $runtime = $Matches[1].ToLowerInvariant(); $options['--jsruntime'] = $true; continue
        }
        if ($options.ContainsKey($argument)) { throw 'invalid_arguments' }
        if ($argument -eq '--repository') {
            if ($i+1 -ge $inputArgs.Count -or -not $inputArgs[$i+1]) { throw 'invalid_arguments' }
            $i++; $repository = [string]$inputArgs[$i]
        } elseif ($argument -notin @('--check','--ensure','--force')) { throw 'invalid_arguments' }
        $options[$argument] = $true
    }
    if ($options.ContainsKey('--check') -and $options.ContainsKey('--ensure')) { throw 'check_conflicts_with_ensure' }
    if (-not $options.ContainsKey('--ensure') -and ($options.ContainsKey('--force') -or $runtime)) { throw 'option_requires_ensure' }
    if (-not $options.ContainsKey('--check') -and -not $options.ContainsKey('--ensure')) { throw 'tools_mode_required' }
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1','_bootstrap.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'unsupported_platform' }
    if (-not $repository) {
        $skill = Get-Item -LiteralPath (Join-Path $PSScriptRoot '../..')
        if ($skill.Name -eq 'gidd' -and $skill.Parent.Name -eq 'skills' -and $skill.Parent.Parent.Name -eq '.agents' -and
            (Test-Path -LiteralPath (Join-Path $skill.Parent.Parent.Parent.FullName '.git'))) { $repository = $skill.Parent.Parent.Parent.FullName }
    }
    $root = if ($repository) { Get-GiddRepositoryRoot $repository } else { $null }
    $report = Invoke-GiddBootstrap (Resolve-GiddToolStorage $root) -Yes:($options.ContainsKey('--ensure')) -Runtime $runtime -Reinstall:($options.ContainsKey('--force'))
    $report.schema = 'gidd.tools/v1'
    if ($report.status -eq 'needs_bootstrap') { $report.status = 'needs_tools' }
    if (-not $report.runtime) {
        $report.tool_checks = @(@{ id='tools';status='not_checked';reason='runtime_unavailable' })
        $report | ConvertTo-Json -Depth 12 -Compress
        exit 1
    }
    $jsArguments = @((Join-Path $PSScriptRoot '../bootstrap-tools.mjs'),'--runtime-report')
    if ($options.ContainsKey('--check')) { $jsArguments += '--check' }
    if ($options.ContainsKey('--force')) { $jsArguments += '--force' }
    if ($root) { $jsArguments += @('--repository',$root) }
    $OutputEncoding = New-Object Text.UTF8Encoding($false)
    # Bypass a second cmd expansion of Unicode/percent paths.
    $executor = $report.runtime.details.path
    ($report | ConvertTo-Json -Depth 12 -Compress) | & $executor @jsArguments
    exit $LASTEXITCODE
} catch {
    $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'tools_failed' }
    [Console]::Error.WriteLine('GIDD tools failed. Use tools --check or tools --ensure [--jsruntime=bun|node] [--force].')
    @{schema='gidd.tools/v1';status='error';reason=$reason} | ConvertTo-Json -Compress
    exit 2
}
