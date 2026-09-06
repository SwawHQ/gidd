function Get-DoctorRepositoryChecks {
    param([string]$Target, $Git)
    $repositoryRoot = $null
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        New-Check 'repository' 'invalid' 'directory_missing' @{ path = $target }
    } elseif ($git.status -ne 'ready') {
        New-Check 'repository' 'not_checked' 'git_unavailable' @{ depends_on = @('tool.git') }
    } else {
        $inside = Invoke-GiddProcess $git.details.path @('-C', $target, 'rev-parse', '--is-inside-work-tree')
        $root = Invoke-GiddProcess $git.details.path @('-C', $target, 'rev-parse', '--show-toplevel')
        if ($inside.ok -and $inside.text -eq 'true' -and $root.ok) {
            $repositoryRoot = $root.text
            New-Check 'repository' 'ready' 'worktree' @{ path = $repositoryRoot }
            $head = Invoke-GiddProcess $git.details.path @('-C', $repositoryRoot, 'rev-parse', '--verify', 'HEAD')
            $symbolic = Invoke-GiddProcess $git.details.path @('-C', $repositoryRoot, 'symbolic-ref', '-q', 'HEAD')
            if ($head.ok) {
                New-Check 'repository.history' 'ready' 'has_commit' @{ commit = $head.text }
            } elseif ($symbolic.ok) {
                New-Check 'repository.history' 'missing' 'unborn_branch'
            } else { New-Check 'repository.history' 'invalid' 'head_unreadable' }
            $remotes = Invoke-GiddProcess $git.details.path @('-C', $repositoryRoot, 'remote')
            $names = @($remotes.text -split '\r?\n' | Where-Object { $_ })
            $origins = @()
            foreach ($name in $names) {
                $url = Invoke-GiddProcess $git.details.path @('-C', $repositoryRoot, 'remote', 'get-url', $name)
                # URLs can contain credentials: expose only a public GitHub owner/repo slug.
                $slug = $null
                if ($url.ok -and $url.text -match '^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$') {
                    $slug = $Matches[1]
                }
                $origins += @{ name = $name; github_repository = $slug; url_checked = $url.ok }
            }
            $remoteStatus = if (-not $remotes.ok) { 'invalid' } elseif ($names.Count) { 'ready' } else { 'missing' }
            New-Check 'repository.remotes' $remoteStatus 'local_remote_configuration_only' @{ remotes = $origins }
        } else { New-Check 'repository' 'invalid' 'not_readable_worktree' @{ path = $target } }
    }
}
