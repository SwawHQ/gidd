# Internal preparation policy. Repository config.toml is never read here.
function Get-GiddDefaultTools {
    return @{
        node = @{ version = 'lts'; source = 'https://nodejs.org/dist' }
        bun = @{ version = 'latest'; source = 'https://github.com/oven-sh/bun/releases' }
        gh = @{ version = 'latest'; source = 'https://github.com/cli/cli/releases' }
    }
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

function Resolve-GiddToolStorage {
    # USERPROFILE is the Windows home convention; tests provide an isolated home.
    $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
    if ($userHome -notmatch '^[A-Za-z]:[\\/]') { throw 'user_home_absolute_local_path_required' }
    $root = [IO.Path]::GetFullPath((Join-Path $userHome '.agents/skills.tools/gidd'))
    Assert-GiddPlainPath $root
    if (Test-Path -LiteralPath $root) {
        if (-not [IO.Directory]::Exists($root)) { throw 'tools_directory_not_a_directory' }
        $pending = New-Object 'System.Collections.Generic.Stack[string]'
        $pending.Push($root)
        while ($pending.Count) {
            $directory = $pending.Pop()
            foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    # Bootstrap validates its selected binding; never traverse external tools.
                    if ($directory -eq $root -and $item.Name -cmatch '^\.runtime-path-[a-f0-9]{64}$') { continue }
                    throw 'reparse_tools_directory'
                }
                if ($item.Name -in @('SKILL.md','config.toml','.git')) { throw 'tools_directory_contains_project_or_skill' }
                if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            }
        }
    }
    return @{ tools_root = $root; tools = (Get-GiddDefaultTools) }
}
