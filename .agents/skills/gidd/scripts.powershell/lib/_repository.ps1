# Preparation checks only local worktree ownership and publishes its entry.
# Remote configuration and GitHub checks belong to JavaScript.
function Assert-GiddRepositoryRoot {
    param([string]$Repository)
    if ($Repository -notmatch '^[A-Za-z]:[\\/]') { throw 'repository_absolute_local_path_required' }
    Assert-GiddPlainPath $Repository
    if (-not [IO.Directory]::Exists($Repository)) { throw 'repository_directory_missing' }
    if (-not (Test-Path -LiteralPath (Join-Path $Repository '.git'))) { throw 'not_git_repository_root' }
}

function Test-GiddSameDirectory {
    param([string]$Left, [string]$Right)
    return (Get-Item -LiteralPath $Left -Force).FullName.TrimEnd('\') -eq (Get-Item -LiteralPath $Right -Force).FullName.TrimEnd('\')
}

function Get-GiddInstallationRepository {
    param([string]$Repository, [string]$Entry)
    Assert-GiddRepositoryRoot $Repository
    Assert-GiddPlainPath $Entry
    if (-not [IO.File]::Exists($Entry)) { throw 'linked_skill_unavailable' }
    $skill = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName((Get-Item -LiteralPath $Entry).FullName))
    $ancestor = $skill
    while ($ancestor) {
        if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) {
            $known = $false
            foreach ($layout in @('.agents','.claude')) {
                if ($skill -eq [IO.Path]::GetFullPath((Join-Path $ancestor "$layout/skills/gidd"))) { $known = $true; break }
            }
            if (-not $known) { throw 'installation_scope_unknown' }
            if (-not (Test-GiddSameDirectory $ancestor $Repository)) { throw 'installation_repository_mismatch' }
            return $ancestor
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $null
}

function Test-GiddRepository {
    param([string]$Repository, [string]$Git)
    Assert-GiddRepositoryRoot $Repository
    $inside = Invoke-GiddProcess $Git @('-C',$Repository,'rev-parse','--is-inside-work-tree')
    $top = Invoke-GiddProcess $Git @('-C',$Repository,'rev-parse','--show-toplevel')
    if (-not $inside.ok -or $inside.text -cne 'true' -or -not $top.ok) { throw 'not_readable_worktree' }
    if (-not (Test-GiddSameDirectory $Repository $top.text)) { throw 'repository_root_mismatch' }
    return @{status='ready';path=$Repository}
}

function Get-GiddEntryPath {
    param([string]$Repository)
    return [IO.Path]::GetFullPath((Join-Path $Repository '.agents/skills/gidd/gidd.link.cmd'))
}

function Get-GiddEntryBytes {
    param([string]$Path)
    Assert-GiddPlainPath $Path
    if ([IO.Directory]::Exists($Path)) { throw 'repository_entry_occupied' }
    if (-not [IO.File]::Exists($Path)) { return $null }
    return ,([IO.File]::ReadAllBytes($Path))
}

function Test-GiddSameBytes {
    param($Left, $Right)
    if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
    return [Convert]::ToBase64String($Left) -ceq [Convert]::ToBase64String($Right)
}

function Get-GiddDesiredEntry {
    param([string]$Repository, [string]$Entry, [ValidateSet('bun','node')][string]$Runtime)
    $internal = Get-GiddInstallationRepository $Repository $Entry
    $path = Get-GiddEntryPath $Repository
    $fullEntry = (Get-Item -LiteralPath $Entry).FullName
    # Known repository layouts need no URI-based relative-path conversion.
    $target = if ($internal) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($fullEntry)) -eq (Join-Path $internal '.agents/skills/gidd')) { 'scripts.js\gidd.mjs' }
        else { '..\..\..\.claude\skills\gidd\scripts.js\gidd.mjs' }
    } else { $fullEntry }
    $spec = [ordered]@{schema='gidd.repository-entry/v1';entry=$target;runtime=$Runtime}
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Compress)))
    $dispatcher = ([IO.Path]::GetDirectoryName($target) + '\repository-entry.mjs').Replace('\','/')
    # Windows PowerShell's URI encoder preserves apostrophes; the JS literal cannot.
    $segments = @($dispatcher.Split('/') | ForEach-Object { [uri]::EscapeDataString($_).Replace("'",'%27') })
    if (-not $internal) { $segments[0] = $dispatcher.Substring(0,2); $moduleUrl = 'file:///' + ($segments -join '/') }
    else { $moduleUrl = $segments -join '/' }
    $literalUrl = $moduleUrl.Replace('%','%%')
    $loader = "import(new URL('$literalUrl',require('node:url').pathToFileURL(process.env.GIDD_LINK_DIRECTORY))).then(m=>m.startLink())"
    $text = @(
        '@echo off'
        'setlocal DisableDelayedExpansion'
        ('rem GIDD_LINK ' + $encoded)
        'set "GIDD_LINK_DIRECTORY=%~dp0"'
        ('set "GIDD_LINK_SPEC=' + $encoded + '"')
        ('if not exist "%USERPROFILE%\.agents\skills.tools\gidd\' + $Runtime + '.link.cmd" goto :missing')
        ('set "GIDD_LINK_LOADER=' + $loader + '"')
        ('"%USERPROFILE%\.agents\skills.tools\gidd\' + $Runtime + '.link.cmd" -e "%GIDD_LINK_LOADER%" -- %*')
        ':missing'
        '>&2 echo GIDD runtime launcher missing. Rerun gidd.pre.ensure.cmd --repo with the target directory.'
        'echo {"schema":"gidd.repository-entry/v1","status":"error","reason":"bootstrap_required"}'
        'exit /b 2'
        ''
    ) -join "`r`n"
    return @{bytes=[Text.Encoding]::UTF8.GetBytes($text);path=$path;target=$Repository;location=$(if ($internal) {'relative'} else {'absolute'})}
}

function Get-GiddRepositoryLink {
    param([string]$Repository, [string]$Entry, [string]$Runtime, [switch]$CheckOnly, [scriptblock]$BeforePublish = {})
    $desired = Get-GiddDesiredEntry $Repository $Entry $Runtime
    $path = $desired.path
    $report = @{path=$path;target=$desired.target;location=$desired.location}
    $original = Get-GiddEntryBytes $path
    if ($CheckOnly) {
        $matches = Test-GiddSameBytes $original $desired.bytes
        $reason = if (Test-Path -LiteralPath ($path + '.lock')) { 'repository_entry_locked' }
            elseif ($null -eq $original) { 'repository_entry_missing' }
            elseif ($matches) { 'repository_entry_verified' } else { 'repository_entry_outdated' }
        $report.status = if ($reason -eq 'repository_entry_verified') {'ready'} elseif ($reason -eq 'repository_entry_missing') {'missing'} else {'invalid'}
        $report.reason = $reason
        return $report
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
    Assert-GiddPlainPath $path
    $lockPath = $path + '.lock'; $temporary = $path + '.' + [guid]::NewGuid() + '.tmp'; $lock = $null
    try {
        Assert-GiddPlainPath $lockPath
        try { $lock = [IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None) }
        catch { if (Test-Path -LiteralPath $lockPath) { throw 'repository_entry_locked' }; throw }
        $original = Get-GiddEntryBytes $path
        if (Test-GiddSameBytes $original $desired.bytes) { $report.status='ready';$report.action='reused';return $report }
        Write-GiddDurableFile $temporary $desired.bytes
        & $BeforePublish
        if (-not (Test-GiddSameBytes (Get-GiddEntryBytes $path) $original)) { throw 'repository_entry_changed' }
        if ($null -ne $original) { [IO.File]::Replace($temporary,$path,[System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary,$path) }
        $report.status = 'ready'; $report.action = if ($null -eq $original) {'created'} else {'updated'}
        return $report
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ($lock) { $lock.Dispose();[IO.File]::Delete($lockPath) }
    }
}

function Complete-GiddRepositoryPreparation {
    param($Report, [string]$Repository, [string]$Entry, [switch]$CheckOnly)
    $Report.repository = $Repository
    $git = @($Report.tool_checks | Where-Object { $_.id -eq 'tool.git' -and $_.status -eq 'ready' }) | Select-Object -First 1
    try {
        $Report.repository_check = if ($git) { Test-GiddRepository $Repository $git.details.path }
            else { @{status='not_checked';reason='git_unavailable'} }
    } catch {
        $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'repository_entry_failed' }
        $Report.repository_check = @{status='invalid';reason=$reason}
        $Report.tool_checks += New-Check 'repository' 'invalid' $reason
    }
    try {
        if ($CheckOnly -or ($Report.status -eq 'ready' -and $Report.repository_check.status -eq 'ready')) {
            $Report.entry = Get-GiddRepositoryLink $Repository $Entry $Report.runtime.id.Substring(5) -CheckOnly:$CheckOnly
        } else { $Report.entry = @{status='not_published'} }
    } catch {
        $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_]*(?::[a-zA-Z0-9_.-]+)*$') { $_.Exception.Message } else { 'repository_entry_failed' }
        $Report.entry = @{status='invalid';reason=$reason}
    }
    if ($Report.repository_check.status -ne 'ready' -or $Report.entry.status -ne 'ready') { $Report.status = 'needs_tools' }
    if (-not $CheckOnly -and $Report.entry.status -eq 'ready') { $Report.message = "Prepared repository entry $($Report.entry.path)." }
    return $Report
}
