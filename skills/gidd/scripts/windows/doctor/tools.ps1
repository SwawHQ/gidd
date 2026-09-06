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

function Get-DoctorToolChecks {
    param([string]$ToolsRoot)
    $git = Find-Tool 'git' ([version]'2.0') '^git version (\d+\.\d+\.\d+)' ''
    $node = Find-Tool 'node' ([version]'22.0') '^v(\d+\.\d+\.\d+)$' ''
    $bun = Find-Tool 'bun' ([version]'1.2') '^(\d+\.\d+\.\d+)$' (Join-Path $toolsRoot 'bun/bun.exe')
    $gh = Find-Tool 'gh' ([version]'2.0') '^gh version (\d+\.\d+\.\d+)' (Join-Path $toolsRoot 'gh/gh.exe')
    foreach ($tool in @($git, $node, $bun, $gh)) { $tool }
    # Prefer existing PATH runtimes over managed downloads; Bun wins within the same source.
    $runtime = @($bun, $node | Where-Object { $_.status -eq 'ready' -and $_.details.source -eq 'path' })
    if (-not $runtime.Count) { $runtime = @($bun, $node | Where-Object { $_.status -eq 'ready' }) }
    if ($runtime.Count) {
        New-Check 'runtime' 'ready' 'usable' @{ selected = $runtime[0].id; path = $runtime[0].details.path }
    } else {
        New-Check 'runtime' 'missing' 'requires_node_or_bun' @{ depends_on = @('tool.node', 'tool.bun') }
    }

}
