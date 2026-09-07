function Get-GiddRepositoryRoot {
    param([string]$Path)
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_absolute_local_path_required' }
    $target = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Directory]::Exists($target)) { throw 'repository_directory_missing' }
    Assert-GiddPlainPath $target
    $current = $target
    while ($current) {
        if (Test-Path -LiteralPath (Join-Path $current '.git')) { return $current }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    # Bootstrap can run before Git is available; the explicit target is then the root.
    return $target
}

function Get-GiddDefaultTools {
    return @{
        node = @{ version = 'lts'; source = 'https://nodejs.org/dist' }
        bun = @{ version = 'latest'; source = 'https://github.com/oven-sh/bun/releases' }
        gh = @{ version = 'latest'; source = 'https://github.com/cli/cli/releases' }
    }
}

function ConvertFrom-GiddConfigString {
    param([string]$Literal)
    if ($Literal.StartsWith("'")) { return $Literal.Substring(1,$Literal.Length-2) }
    return [regex]::Replace($Literal.Substring(1,$Literal.Length-2), '\\(["\\])', '$1')
}

function Assert-GiddToolSettings {
    param([string]$Name, $Settings)
    if ($Settings.version -cnotmatch '^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$' -and
        $Settings.version -cne 'latest' -and -not ($Name -eq 'node' -and $Settings.version -ceq 'lts')) { throw "config_invalid_version:$Name" }
    $uri = $null
    if (-not [uri]::TryCreate($Settings.source,[UriKind]::Absolute,[ref]$uri) -or
        $uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $Settings.source -match '[\s\\]' -or $Settings.source -cnotmatch '^https://') { throw "config_invalid_source:$Name" }
    $Settings.source = $Settings.source.TrimEnd('/')
}

function Read-GiddToolConfiguration {
    param([string]$Path)
    Assert-GiddPlainPath $Path
    if (-not [IO.File]::Exists($Path)) { throw 'config_not_a_file' }
    if ((Get-Item -LiteralPath $Path).Length -gt 16KB) { throw 'config_too_large' }
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    try { $text = $utf8.GetString([IO.File]::ReadAllBytes($Path)).TrimStart([char]0xFEFF) }
    catch { throw 'config_invalid_utf8' }
    $values = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    $tools = Get-GiddDefaultTools
    $stringPattern = '(?:"(?:[^"\\]|\\["\\])*"|''[^'']*'')'
    $inTools = $false; $lineNumber = 0; $section = ''
    $tables = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($line in ($text -split "`n")) {
        $lineNumber++
        $line = $line.TrimEnd("`r")
        if ($line -match '[\x00-\x08\x0b-\x1f\x7f]') { throw "config_control_character:$lineNumber" }
        if ($line -cmatch '^[ \t]*(?:#.*)?$') { continue }
        if ($line -cmatch '^[ \t]*\[(tools|github)\][ \t]*(?:#.*)?$') {
            $section = $Matches[1]
            if (-not $tables.Add($section)) { throw "config_duplicate_${section}_table" }
            $inTools = $section -eq 'tools'; continue
        }
        if ($section -eq 'github' -and $line -cmatch ('^[ \t]*(hostname|account|remote)[ \t]*=[ \t]*(' + $stringPattern + ')[ \t]*(?:#.*)?$')) {
            $key = 'github.' + $Matches[1]
            if ($values.ContainsKey($key)) { throw "config_duplicate_key:$key" }
            $values.Add($key, (ConvertFrom-GiddConfigString $Matches[2])); continue
        }
        if (-not $section -and $line -cmatch '^[ \t]*schema_version[ \t]*=[ \t]*1[ \t]*(?:#.*)?$') {
            if ($values.ContainsKey('schema_version')) { throw 'config_duplicate_schema_version' }
            $values.Add('schema_version','1'); continue
        }
        if ($inTools -and $line -cmatch '^[ \t]*(directory)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\["\\])*)"|''([^'']*)'')[ \t]*(?:#.*)?$') {
            $key = $Matches[1]
            if ($values.ContainsKey($key)) { throw "config_duplicate_key:$key" }
            $value = if ($Matches.ContainsKey(2)) { [regex]::Replace($Matches[2], '\\(["\\])', '$1') } else { $Matches[3] }
            $values.Add($key,$value); continue
        }
        if ($inTools -and $line -cmatch '^[ \t]*(node|bun|gh)[ \t]*=[ \t]*\{(.*?)\}[ \t]*(?:#.*)?$') {
            $name = $Matches[1]; $remaining = $Matches[2].Trim()
            if ($values.ContainsKey($name)) { throw "config_duplicate_key:$name" }
            $values.Add($name,'inline')
            $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
            while ($remaining) {
                if ($remaining -cnotmatch ('^(version|source)[ \t]*=[ \t]*(' + $stringPattern + ')[ \t]*(.*)$')) { throw "config_invalid_tool_table:$name" }
                $key = $Matches[1]; $literal = $Matches[2]; $tail = $Matches[3]
                if (-not $seen.Add($key)) { throw "config_duplicate_tool_field:${name}:$key" }
                $tools[$name][$key] = ConvertFrom-GiddConfigString $literal
                if (-not $tail) { break }
                if (-not $tail.StartsWith(',') -or -not $tail.Substring(1).Trim()) { throw "config_invalid_tool_table:$name" }
                $remaining = $tail.Substring(1).Trim()
            }
            if (-not $seen.Contains('version') -or -not $seen.Contains('source')) { throw "config_missing_tool_field:$name" }
            Assert-GiddToolSettings $name $tools[$name]
            continue
        }
        # This bootstrap reader intentionally supports only the documented storage schema.
        throw "config_unsupported_syntax_or_field:$lineNumber"
    }
    foreach ($key in @('schema_version','directory')) {
        if (-not $values.ContainsKey($key)) { throw "config_missing_key:$key" }
    }
    return @{ directory = $values['directory']; tools = $tools }
}

function Resolve-GiddToolStorage {
    param([string]$RepositoryRoot, [string]$DefaultDirectory = '~/.agents/skills/gidd.tools',
        [string]$UserProfilePath = [Environment]::GetFolderPath('UserProfile'),
        [string]$CandidatePath)
    # Internal editor validation can inspect a temporary candidate before publication.
    $configPath = if ($CandidatePath) { $CandidatePath } elseif ($RepositoryRoot) { Join-Path $RepositoryRoot '.agents/skills/gidd/config.toml' } else { $null }
    $configured = $false
    $settings = @{ directory = $DefaultDirectory; tools = (Get-GiddDefaultTools) }
    if ($configPath) {
        Assert-GiddPlainPath $configPath
        if (Test-Path -LiteralPath $configPath) { $settings = Read-GiddToolConfiguration $configPath; $configured = $true }
    }
    $directory = $settings.directory
    if ([string]::IsNullOrWhiteSpace($directory)) { throw 'tools_directory_invalid' }
    if ($directory -match '^~[\\/]') {
        $base = $UserProfilePath; $relative = $directory.Substring(2)
    } elseif ($directory -match '^[A-Za-z]:[\\/]') {
        $base = $directory.Substring(0,3); $relative = $directory.Substring(3)
    } else {
        if ($directory -match '^[~\\/]') { throw 'tools_directory_invalid' }
        $base = $RepositoryRoot; $relative = $directory
        if ($relative -match '^\.[\\/]') { $relative = $relative.Substring(2) }
    }
    if ($base -notmatch '^[A-Za-z]:[\\/]') { throw 'tools_directory_base_unavailable' }
    $base = [IO.Path]::GetFullPath($base).TrimEnd('\') + '\'
    $relative = $relative.TrimEnd('\','/')
    # Reject ambiguous Windows paths and traversal; the configured absolute location may be outside the repo.
    if (-not $relative -or $relative -match '[<>:"|?*\x00-\x1f]') { throw 'tools_directory_invalid' }
    foreach ($part in ($relative -split '[\\/]')) {
        if (-not $part -or $part -match '[. ]$|^\.git$|^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'tools_directory_invalid' }
    }
    $root = [IO.Path]::GetFullPath((Join-Path $base $relative))
    if (-not $root.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'tools_directory_outside_base' }
    if ($UserProfilePath -match '^[A-Za-z]:[\\/]' -and [string]::Equals(
        $root.TrimEnd('\'), [IO.Path]::GetFullPath($UserProfilePath).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'tools_directory_is_user_home' }
    Assert-GiddPlainPath $root
    if (Test-Path -LiteralPath $root) {
        if (-not [IO.Directory]::Exists($root)) { throw 'tools_directory_not_a_directory' }
        $pending = New-Object 'System.Collections.Generic.Stack[string]'
        $pending.Push($root)
        while ($pending.Count) {
            foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse_tools_directory' }
                # A candidate will become config.toml here; catch it before publication, including path aliases.
                if ($item.Name -in @('SKILL.md','config.toml','.git') -or
                    ($CandidatePath -and $item.Name -eq [IO.Path]::GetFileName($CandidatePath))) { throw 'tools_directory_contains_project_or_skill' }
                if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            }
        }
    }
    return @{ tools_root = $root; directory = $directory; config_path = $configPath; configured = $configured; tools = $settings.tools }
}
