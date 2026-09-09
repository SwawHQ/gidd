# Internal dispatcher shared by the published entry and repository development entry.
function Invoke-GiddEntry {
    param([object[]]$CommandArguments)
    $entryRoot = Split-Path -Parent $PSScriptRoot
    # Validate the invocation before bootstrap can download; operations run in JS.
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    try {
        $command = if ($CommandArguments.Count) { ([string]$CommandArguments[0]).ToLowerInvariant() } else { 'help' }
        $tail = @(); if ($CommandArguments.Count -gt 1) { $tail = @($CommandArguments[1..($CommandArguments.Count - 1)]) }
        if ($command -in @('help','--help','-h')) {
            if ($tail.Count -gt 1) { throw 'invalid_arguments' }
            $choice = if ($tail.Count) { [string]$tail[0] } else { $env:GIDD_LANG }
            if ($choice) {
                if ($choice -match '^zh(?:$|[-_])') { $language = 'zh-CN' }
                elseif ($choice -match '^en(?:$|[-_])') { $language = 'en' }
                else { throw 'unsupported_help_language' }
            } else {
                $locale = @($env:LC_ALL,$env:LC_MESSAGES,$env:LANG,[Globalization.CultureInfo]::CurrentUICulture.Name) | Where-Object { $_ } | Select-Object -First 1
                $language = if ($locale -match '^zh(?:$|[-_])') { 'zh-CN' } else { 'en' }
            }
            . (Join-Path $PSScriptRoot '_bootstrap.ps1')
            $helpRepository = [IO.Path]::GetFullPath((Join-Path $entryRoot '../../../../..'))
            if (-not (Test-Path -LiteralPath (Join-Path $helpRepository '.git'))) { $helpRepository = '' }
            Start-GiddJavaScript -RepositoryPath $helpRepository -Arguments @('help',$language) -IgnorePins
        }
        if ($command -notin @('doctor','setup','identity','auth','config')) { throw 'unknown_command' }
        $parameters = @{}
        $offset = 0
        if ($command -in @('identity','auth') -and (@($tail | Where-Object { $_ -in @('--hostname','--account','--remote') }).Count -or
            ($command -eq 'auth' -and $tail.Count -and -not $tail[0].StartsWith('--')))) { throw 'github_parameters_moved_to_config' }
        if ($command -eq 'config') {
            if (-not $tail.Count -or $tail[0] -notin @('show','set')) { throw 'invalid_arguments' }
            $parameters.Action = ([string]$tail[0]).ToLowerInvariant(); $offset = 1
            if ($parameters.Action -eq 'set') {
                if ($tail.Count -lt 3) { throw 'invalid_arguments' }
                $parameters.Key = [string]$tail[1]; $parameters.Value = [string]$tail[2]; $offset = 3
            }
        } elseif ($command -eq 'setup' -and $tail.Count -and -not $tail[0].StartsWith('--')) {
            if ($tail[0] -notin @('bun','node','gh')) { throw 'invalid_setup_tool' }
            $parameters.Tool = [string]$tail[0]; $offset = 1
        }
        $allowed = @('--repository')
        $names = @{ '--repository'='RepositoryPath' }
        for ($i = $offset; $i -lt $tail.Count; $i += 2) {
            $key = [string]$tail[$i]
            if ($key -notin $allowed -or $i + 1 -ge $tail.Count) { throw 'invalid_arguments' }
            $name = $names[$key]
            if ($parameters.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($tail[$i + 1])) { throw 'invalid_arguments' }
            $parameters[$name] = [string]$tail[$i + 1]
        }
        if (-not $parameters.ContainsKey('RepositoryPath')) {
            $skill = Get-Item -LiteralPath (Join-Path $entryRoot '../..')
            if ($skill.Name -ne 'gidd' -or $skill.Parent.Name -ne 'skills' -or $skill.Parent.Parent.Name -ne '.agents') {
                throw 'repository_required_for_unbound_entry'
            }
            $parameters.RepositoryPath = $skill.Parent.Parent.Parent.FullName
            if (-not (Test-Path -LiteralPath (Join-Path $parameters.RepositoryPath '.git'))) {
                throw 'repository_required_for_unbound_entry'
            }
        }
        if ($parameters.RepositoryPath -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_must_be_absolute' }
        . (Join-Path $PSScriptRoot '_bootstrap.ps1')
        $forward = @($CommandArguments)
        if ($tail -notcontains '--repository') { $forward += @('--repository',$parameters.RepositoryPath) }
        Start-GiddJavaScript -RepositoryPath $parameters.RepositoryPath -Arguments $forward -IgnorePins:($command -eq 'config')
    } catch {
        $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'entry_failed' }
        if ($reason -eq 'github_parameters_moved_to_config') { [Console]::Error.WriteLine('Use gidd.cmd config set github.hostname/account/remote <value>; identity/auth read config.toml only.') }
        [Console]::Error.WriteLine('GIDD command failed. Use gidd.cmd help for usage.')
        @{ schema='gidd.cli/v1'; status='error'; reason=$reason } | ConvertTo-Json -Compress
        exit 2
    }

}
