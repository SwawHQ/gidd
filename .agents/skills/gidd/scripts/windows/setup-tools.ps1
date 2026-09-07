[CmdletBinding()]
param([string]$RepositoryPath, [ValidateSet('bun','node','gh')][string]$Tool)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$lock = $null
$results = New-Object 'System.Collections.Generic.List[object]'
try {
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    . (Join-Path $PSScriptRoot 'doctor/platform.ps1')
    . (Join-Path $PSScriptRoot 'doctor/tools.ps1')
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    $repositoryRoot = Get-GiddRepositoryRoot $RepositoryPath
    $storage = Resolve-GiddToolStorage $repositoryRoot
    $toolsRoot = $storage.tools_root
    $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../assets/runtimes.json')) | ConvertFrom-Json
    if ($manifest.schema -ne 'gidd.runtimes/v1' -or $manifest.platform -ne 'windows-x64') { throw 'invalid_runtime_manifest' }
    $ghMinimum = if ($Tool -eq 'gh') { [version]'2.98.0' } else { [version]'2.0' }
    $definitions = @($manifest.tools | Where-Object { -not $Tool -or $_.name -eq $Tool })
    # Node uses the same official release resolver without a development-manifest dependency.
    if ($Tool -eq 'node') { $definitions = @([pscustomobject]@{ name = 'node' }) }
    $requiredIds = if ($Tool) { @("tool.$Tool") } else { @('runtime','tool.gh') }
    $checks = @(Get-DoctorToolChecks $toolsRoot $storage.tools -GhMinimum $ghMinimum)
    $needed = @($checks | Where-Object { $_.id -in $requiredIds -and $_.status -ne 'ready' })
    # All external tools already usable: do not create a GIDD data directory.
    if ($needed.Count -or (Test-Path -LiteralPath $toolsRoot)) {
        $lock = Open-GiddInstallLock $toolsRoot
        Write-GiddInstallationGuide $toolsRoot
        # Development may have prepared Node in the same configured directory.
        if (-not $Tool -and (Test-Path -LiteralPath (Join-Path $toolsRoot 'node'))) {
            if (-not (Test-GiddManagedTool (Join-Path $toolsRoot 'node') 'node')) { throw 'occupied_or_invalid_target:node' }
            Remove-GiddStage $toolsRoot 'node'
        }
        foreach ($definition in $definitions) {
            $name = $definition.name
            $target = Join-Path $toolsRoot $name
            if (Test-Path -LiteralPath $target) {
                if (-not (Test-GiddManagedTool $target $name)) { throw "occupied_or_invalid_target:$name" }
                Remove-GiddStage $toolsRoot $name
            }
        }
        # Re-probe inside the lock: another completed install may have changed the result.
        $checks = @(Get-DoctorToolChecks $toolsRoot $storage.tools -GhMinimum $ghMinimum)
        foreach ($definition in $definitions) {
            $id = if ($Tool) { "tool.$Tool" } elseif ($definition.name -eq 'bun') { 'runtime' } else { 'tool.gh' }
            $check = @($checks | Where-Object id -eq $id)[0]
            if ($check.status -eq 'ready') {
                Remove-GiddStage $toolsRoot $definition.name
                $reusedName = if ($id -eq 'runtime') { $check.details.selected -replace '^tool\.', '' } else { $definition.name }
                $results.Add(@{ name = $reusedName; action = 'reused'; path = $check.details.path })
            } else {
                if (Test-Path -LiteralPath (Join-Path $toolsRoot $definition.name)) { throw "occupied_or_version_conflicting_target:$($definition.name)" }
                $pinned = if ($definition.name -eq 'node') { $null } else { $definition }
                $resolved = Resolve-GiddRelease $definition.name $storage.tools[$definition.name] $pinned
                $minimum = if ($definition.name -eq 'bun') { [version]'1.2' } elseif ($definition.name -eq 'node') { [version]'22.0' } else { $ghMinimum }
                if ([version]$resolved.version -lt $minimum) { throw "configured_version_below_minimum:$($definition.name)" }
                $result = Install-GiddTool $toolsRoot $resolved {
                    param($phase)
                    [Console]::Error.WriteLine("GIDD install: $phase")
                }
                $results.Add($result)
            }
        }
    } else {
        foreach ($id in $requiredIds) {
            $check = @($checks | Where-Object id -eq $id)[0]
            $name = if ($check.id -eq 'runtime') { $check.details.selected -replace '^tool\.', '' } else { $check.id -replace '^tool\.', '' }
            $results.Add(@{ name = $name; action = 'reused'; path = $check.details.path })
        }
    }
    $final = @(Get-DoctorToolChecks $toolsRoot $storage.tools -GhMinimum $ghMinimum)
    if (@($final | Where-Object { $_.id -in $requiredIds -and $_.status -ne 'ready' }).Count) { throw 'post_install_check_failed' }
    @{ schema = 'gidd.setup-tools/v1'; status = 'ready'; tools = @($results.ToArray()); tools_root = $toolsRoot; storage = $storage } | ConvertTo-Json -Depth 6 -Compress
    exit 0
} catch {
    $reason = $_.Exception.Message
    [Console]::Error.WriteLine("GIDD setup failed: $reason")
    @{ schema = 'gidd.setup-tools/v1'; status = 'error'; reason = $reason; tools = @($results.ToArray()) } | ConvertTo-Json -Depth 6 -Compress
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
