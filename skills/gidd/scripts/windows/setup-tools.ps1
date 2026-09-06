[CmdletBinding()]
param([string]$UserSkillsRoot, [string]$ArchiveDirectory = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$lock = $null
$results = New-Object 'System.Collections.Generic.List[object]'
try {
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1')) { . (Join-Path $PSScriptRoot "lib/$file") }
    foreach ($file in @('_filesystem.ps1','download.ps1','install.ps1')) { . (Join-Path $PSScriptRoot "setup-tools/$file") }
    . (Join-Path $PSScriptRoot 'doctor/platform.ps1')
    . (Join-Path $PSScriptRoot 'doctor/tools.ps1')
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    foreach ($path in @($UserSkillsRoot) + @($ArchiveDirectory | Where-Object { $_ })) {
        if ($path -notmatch '^[A-Za-z]:[\\/]') { throw 'absolute_local_path_required' }
        Assert-GiddPlainPath $path
    }
    $toolsRoot = Join-Path ([IO.Path]::GetFullPath($UserSkillsRoot)) 'gidd.tools'
    Assert-GiddPlainPath $toolsRoot
    $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../assets/runtimes.json')) | ConvertFrom-Json
    if ($manifest.schema -ne 'gidd.runtimes/v1' -or $manifest.platform -ne 'windows-x64') { throw 'invalid_runtime_manifest' }
    $checks = @(Get-DoctorToolChecks $toolsRoot)
    $runtime = @($checks | Where-Object id -eq runtime)[0]
    $gh = @($checks | Where-Object id -eq tool.gh)[0]
    $needed = @()
    if ($runtime.status -ne 'ready') { $needed += 'bun' }
    if ($gh.status -ne 'ready') { $needed += 'gh' }
    # All external tools already usable: do not create a GIDD data directory.
    if ($needed.Count -or (Test-Path -LiteralPath $toolsRoot)) {
        $lock = Open-GiddInstallLock $toolsRoot
        Write-GiddInstallationGuide $toolsRoot
        foreach ($definition in $manifest.tools) {
            $name = $definition.name
            $target = Join-Path $toolsRoot $name
            if (Test-Path -LiteralPath $target) {
                if (-not (Test-GiddManagedTool $target $name)) { throw "occupied_or_invalid_target:$name" }
                Remove-GiddStage $toolsRoot $name
            }
        }
        # Re-probe inside the lock: another completed install may have changed the result.
        $checks = @(Get-DoctorToolChecks $toolsRoot)
        foreach ($definition in $manifest.tools) {
            $id = if ($definition.name -eq 'bun') { 'runtime' } else { 'tool.gh' }
            $check = @($checks | Where-Object id -eq $id)[0]
            if ($check.status -eq 'ready') {
                Remove-GiddStage $toolsRoot $definition.name
                $results.Add(@{ name = $definition.name; action = 'reused'; path = $check.details.path })
            } else {
                $result = Install-GiddTool $toolsRoot $definition $ArchiveDirectory {
                    param($phase)
                    [Console]::Error.WriteLine("GIDD install: $phase")
                }
                $results.Add($result)
            }
        }
    } else {
        $results.Add(@{ name = 'bun'; action = 'reused'; path = $runtime.details.path })
        $results.Add(@{ name = 'gh'; action = 'reused'; path = $gh.details.path })
    }
    $final = @(Get-DoctorToolChecks $toolsRoot)
    if (@($final | Where-Object { $_.id -in @('runtime','tool.gh') -and $_.status -ne 'ready' }).Count) { throw 'post_install_check_failed' }
    @{ schema = 'gidd.setup-tools/v1'; status = 'ready'; tools = @($results.ToArray()); tools_root = $toolsRoot } | ConvertTo-Json -Depth 6 -Compress
    exit 0
} catch {
    $reason = $_.Exception.Message
    [Console]::Error.WriteLine("GIDD setup failed: $reason")
    @{ schema = 'gidd.setup-tools/v1'; status = 'error'; reason = $reason; tools = @($results.ToArray()) } | ConvertTo-Json -Depth 6 -Compress
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
