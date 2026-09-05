[CmdletBinding()]
param(
    [string]$RepositoryPath,
    [string]$UserSkillsRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'process.ps1')

function New-Check {
    param([string]$Id, [string]$Status, [string]$Reason, [hashtable]$Details = @{})
    return [ordered]@{ id = $Id; status = $Status; reason = $Reason; details = $Details }
}

function Find-Tool {
    param([string]$Name, [version]$Minimum, [string]$Pattern, [string]$ManagedPath)
    $candidates = @()
    foreach ($command in @(Get-Command "$Name.exe" -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $candidates += @{ path = $command.Source; source = 'path' }
    }
    if ($ManagedPath -and (Test-Path -LiteralPath $ManagedPath)) {
        $candidates += @{ path = $ManagedPath; source = 'gidd.tools' }
    }
    $attempts = @()
    foreach ($candidate in $candidates) {
        $result = Invoke-DoctorProcess $candidate.path @('--version')
        $version = $null
        $reason = $result.reason
        if ($result.ok) {
            if ($result.text -match $Pattern) {
                $version = $Matches[1]
                $reason = 'version_below_minimum'
                if ([version]$version -ge $Minimum) {
                    return New-Check "tool.$Name" 'ready' 'usable' @{
                        path = $candidate.path; source = $candidate.source; version = $version
                        minimum = $Minimum.ToString(); rejected = $attempts
                    }
                }
            } else { $reason = 'unrecognized_version' }
        }
        $attempts += @{ path = $candidate.path; source = $candidate.source; reason = $reason; version = $version }
    }
    $status = if ($candidates.Count) { 'invalid' } else { 'missing' }
    return New-Check "tool.$Name" $status 'no_usable_candidate' @{
        minimum = $Minimum.ToString(); rejected = $attempts
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($RepositoryPath) -or [string]::IsNullOrWhiteSpace($UserSkillsRoot)) {
        throw 'RepositoryPath and UserSkillsRoot are required.'
    }
    foreach ($path in @($RepositoryPath, $UserSkillsRoot)) {
        if ($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
            throw 'Both paths must be absolute; expand the home directory before invocation.'
        }
    }
    $target = [IO.Path]::GetFullPath($RepositoryPath)
    $skillsRoot = [IO.Path]::GetFullPath($UserSkillsRoot)
    $toolsRoot = Join-Path $skillsRoot 'gidd.tools'
    $checks = New-Object System.Collections.Generic.List[object]
    $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
    if (-not $architecture) { $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
    $supported = [Environment]::OSVersion.Platform -eq 'Win32NT' -and $architecture -eq 'AMD64'
    $platformStatus = if ($supported) { 'ready' } else { 'invalid' }
    $checks.Add((New-Check 'platform' $platformStatus 'windows_x64_initial_target' @{ architecture = $architecture }))

    $git = Find-Tool 'git' ([version]'2.0') '^git version (\d+\.\d+\.\d+)' ''
    $node = Find-Tool 'node' ([version]'22.0') '^v(\d+\.\d+\.\d+)$' ''
    $bun = Find-Tool 'bun' ([version]'1.2') '^(\d+\.\d+\.\d+)$' (Join-Path $toolsRoot 'bun/bun.exe')
    $gh = Find-Tool 'gh' ([version]'2.0') '^gh version (\d+\.\d+\.\d+)' (Join-Path $toolsRoot 'gh/gh.exe')
    foreach ($tool in @($git, $node, $bun, $gh)) { $checks.Add($tool) }
    # Prefer existing PATH runtimes over managed downloads; Bun wins within the same source.
    $runtime = @($bun, $node | Where-Object { $_.status -eq 'ready' -and $_.details.source -eq 'path' })
    if (-not $runtime.Count) { $runtime = @($bun, $node | Where-Object { $_.status -eq 'ready' }) }
    if ($runtime.Count) {
        $checks.Add((New-Check 'runtime' 'ready' 'usable' @{ selected = $runtime[0].id; path = $runtime[0].details.path }))
    } else {
        $checks.Add((New-Check 'runtime' 'missing' 'requires_node_or_bun' @{ depends_on = @('tool.node', 'tool.bun') }))
    }

    $repositoryRoot = $null
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        $checks.Add((New-Check 'repository' 'invalid' 'directory_missing' @{ path = $target }))
    } elseif ($git.status -ne 'ready') {
        $checks.Add((New-Check 'repository' 'not_checked' 'git_unavailable' @{ depends_on = @('tool.git') }))
    } else {
        $inside = Invoke-DoctorProcess $git.details.path @('-C', $target, 'rev-parse', '--is-inside-work-tree')
        $root = Invoke-DoctorProcess $git.details.path @('-C', $target, 'rev-parse', '--show-toplevel')
        if ($inside.ok -and $inside.text -eq 'true' -and $root.ok) {
            $repositoryRoot = $root.text
            $checks.Add((New-Check 'repository' 'ready' 'worktree' @{ path = $repositoryRoot }))
            $head = Invoke-DoctorProcess $git.details.path @('-C', $repositoryRoot, 'rev-parse', '--verify', 'HEAD')
            $symbolic = Invoke-DoctorProcess $git.details.path @('-C', $repositoryRoot, 'symbolic-ref', '-q', 'HEAD')
            if ($head.ok) {
                $checks.Add((New-Check 'repository.history' 'ready' 'has_commit' @{ commit = $head.text }))
            } elseif ($symbolic.ok) {
                $checks.Add((New-Check 'repository.history' 'missing' 'unborn_branch'))
            } else { $checks.Add((New-Check 'repository.history' 'invalid' 'head_unreadable')) }
            $remotes = Invoke-DoctorProcess $git.details.path @('-C', $repositoryRoot, 'remote')
            $names = @($remotes.text -split '\r?\n' | Where-Object { $_ })
            $origins = @()
            foreach ($name in $names) {
                $url = Invoke-DoctorProcess $git.details.path @('-C', $repositoryRoot, 'remote', 'get-url', $name)
                # URLs can contain credentials: expose only a public GitHub owner/repo slug.
                $slug = $null
                if ($url.ok -and $url.text -match '^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$') {
                    $slug = $Matches[1]
                }
                $origins += @{ name = $name; github_repository = $slug; url_checked = $url.ok }
            }
            $remoteStatus = if (-not $remotes.ok) { 'invalid' } elseif ($names.Count) { 'ready' } else { 'missing' }
            $checks.Add((New-Check 'repository.remotes' $remoteStatus 'local_remote_configuration_only' @{ remotes = $origins }))
        } else { $checks.Add((New-Check 'repository' 'invalid' 'not_readable_worktree' @{ path = $target })) }
    }
    if ($repositoryRoot) {
        $configPath = Join-Path $repositoryRoot '.agents/skills/gidd/config.toml'
        $configStatus = if (Test-Path -LiteralPath $configPath -PathType Leaf) { 'ready' }
            elseif (Test-Path -LiteralPath $configPath) { 'invalid' } else { 'missing' }
        $checks.Add((New-Check 'repository.config' $configStatus 'file_presence_only' @{ path = $configPath }))
    } else {
        $checks.Add((New-Check 'repository.config' 'not_checked' 'repository_unavailable' @{ depends_on = @('repository') }))
    }
    $checks.Add((New-Check 'repository.config.validation' 'not_checked' 'not_implemented'))
    $checks.Add((New-Check 'github.identity' 'not_checked' 'offline_diagnostic'))
    $checks.Add((New-Check 'git.authentication' 'not_checked' 'offline_diagnostic'))
    $required = @('platform', 'tool.git', 'runtime', 'tool.gh', 'repository', 'repository.history', 'repository.remotes', 'repository.config')
    $incomplete = @($checks | Where-Object { $_.id -in $required -and $_.status -ne 'ready' }).Count -gt 0
    $status = if ($incomplete) { 'needs_setup' } else { 'local_ready' }
    [ordered]@{
        schema = 'gidd.doctor/v1'; status = $status; repository = $target
        user_skills_root = $skillsRoot; checks = @($checks.ToArray())
    } | ConvertTo-Json -Depth 12 -Compress
    if ($incomplete) { exit 1 }
    exit 0
} catch {
    [Console]::Error.WriteLine('GIDD doctor could not complete. Supply absolute -RepositoryPath and -UserSkillsRoot paths and check filesystem access.')
    [ordered]@{ schema = 'gidd.doctor/v1'; status = 'error'; checks = @() } | ConvertTo-Json -Compress
    exit 2
}
