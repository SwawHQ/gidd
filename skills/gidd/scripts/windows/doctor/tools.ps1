function Get-DoctorToolChecks {
    param([string]$ToolsRoot, $Settings = $null, [version]$GhMinimum = '2.0')
    $versions = @{ node = ''; bun = ''; gh = '' }
    if ($Settings) { foreach ($name in @('node','bun','gh')) { $versions[$name] = $Settings[$name].version } }
    $git = Find-Tool 'git' ([version]'2.0') '^git version (\d+\.\d+\.\d+)' ''
    $nodePath = if ($ToolsRoot) { Join-Path $ToolsRoot 'node/node.exe' } else { '' }
    $bunPath = if ($ToolsRoot) { Join-Path $ToolsRoot 'bun/bun.exe' } else { '' }
    $ghPath = if ($ToolsRoot) { Join-Path $ToolsRoot 'gh/gh.exe' } else { '' }
    $node = Find-Tool 'node' ([version]'22.0') '^v(\d+\.\d+\.\d+)$' $nodePath $versions.node
    $bun = Find-Tool 'bun' ([version]'1.2') '^(\d+\.\d+\.\d+)$' $bunPath $versions.bun
    $gh = Find-Tool 'gh' $GhMinimum '^gh version (\d+\.\d+\.\d+)' $ghPath $versions.gh
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
