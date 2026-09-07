# Runtime argv bypasses PowerShell; this script resolves tools and runs development operations.
$Command = if ($args.Count) { [string]$args[0] } else { '.help' }
$Argument = if ($args.Count -gt 1) { [string]$args[1] } else { '' }
$Extra = @()
if ($args.Count -gt 2) { $Extra = @($args[2..($args.Count - 1)]) }

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$codeRoot = Join-Path $repoRoot 'skills/gidd/scripts/windows'
$toolsRoot = $null
$storage = $null
$lock = $null
function Get-DevTool {
    param([string]$Name, [ValidateSet('auto','managed','system')][string]$Source = 'auto')
    $minimum = switch ($Name) { bun { [version]'1.2.15' } node { [version]'24.0.0' } gh { [version]'2.98.0' } }
    $pattern = switch ($Name) { bun { '^(\d+\.\d+\.\d+)$' } node { '^v(\d+\.\d+\.\d+)$' } gh { '^gh version (\d+\.\d+\.\d+)' } }
    $savedPath = $env:PATH
    try {
        if ($Source -eq 'managed') { $env:PATH = '' }
        $managedPath = if ($Source -eq 'system') { '' } else { Join-Path $toolsRoot "$Name/$Name.exe" }
        $check = Find-Tool $Name $minimum $pattern $managedPath $storage.tools[$Name].version
    } finally { $env:PATH = $savedPath }
    return $check
}
function Test-DevManagedTool {
    param($Check, [string]$Name)
    return $Check.status -eq 'ready' -and [string]::Equals(
        [IO.Path]::GetFullPath($Check.details.path), (Join-Path $toolsRoot "$Name/$Name.exe"), [StringComparison]::OrdinalIgnoreCase)
}
try {
    $runtimeSource = 'managed'
    if ($Command -eq '.runtime-path') {
        if ($Argument -notin @('bun','node') -or $Extra.Count -ne 1 -or $Extra[0] -notin @('managed','system')) {
            throw 'Invalid internal runtime request.'
        }
        $runtimeSource = $Extra[0]
        $Command = $Argument
        $Argument = ''; $Extra = @()
    }
    if ($Command -eq '.setup') {
        if ($Argument -and $Argument -notin @('bun','node','gh')) { throw 'Use dev.cmd .setup bun, .setup node or .setup gh.' }
    }
    if ($Extra.Count -and $Command -notin @('bun','node')) { throw 'Unexpected arguments. Use dev.cmd .help.' }
    if ($Command -in @('.help','--help','-h','/?')) {
        $language = $null
        foreach ($choice in @($Argument, $env:GIDD_DEV_LANG)) {
            if (-not [string]::IsNullOrWhiteSpace($choice)) {
                if ($choice -match '^zh(?:$|[-_])') { $language = 'zh-CN' }
                elseif ($choice -match '^en(?:$|[-_])') { $language = 'en' }
                else { throw 'Unsupported help language. Use zh or en.' }
                break
            }
        }
        if (-not $language) {
            $locale = @($env:LC_ALL,$env:LC_MESSAGES,$env:LANG,[Globalization.CultureInfo]::CurrentUICulture.Name) | Where-Object { $_ } | Select-Object -First 1
            $language = if ($locale -match '^zh(?:$|[-_])') { 'zh-CN' } else { 'en' }
        }
        [Console]::WriteLine([IO.File]::ReadAllText((Join-Path $PSScriptRoot "help/$language.txt")))
        exit 0
    }
    if ($Command -notin @('.info','.setup','.test','.test-bun','.test-node','.test-live','.auth','bun','node')) { throw 'Unknown command. Use dev.cmd .help.' }
    if ($Command -eq '.auth' -and $Argument) { throw '.auth reads github.account from config.toml; use gidd.cmd config set github.account <login>.' }
    if ($Command -eq '.info' -and $Argument) { throw '.info takes no arguments.' }
    if ($Command -eq '.test-live' -and $Argument) { throw '.test-live takes no arguments.' }
    if ($Command -in @('.test','.test-bun','.test-node') -and $Argument -and $Argument -notin @('all','doctor','setup','process','dev','config','github','entry')) { throw 'Unknown test suite.' }
    if ($Command -eq '.auth') {
        . (Join-Path $codeRoot 'lib/_entry.ps1')
        Invoke-GiddEntry -CommandArguments @('auth','--repository',$repoRoot) -DefaultToolsDirectory '.dev'
        exit $LASTEXITCODE
    }
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','lib/_configuration.ps1','doctor/platform.ps1')) { . (Join-Path $codeRoot $file) }
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    $storage = Resolve-GiddToolStorage $repoRoot '.dev'
    $toolsRoot = $storage.tools_root
    if ($Command -in @('bun','node')) {
        $name = $Command.ToLowerInvariant()
        $runtime = Get-DevTool $name -Source $runtimeSource
        if ($runtime.status -ne 'ready') { throw "$runtimeSource $name unavailable or invalid. Portable and PATH modes do not fall back to each other. Use dev.cmd .help." }
        [Console]::WriteLine($runtime.details.path)
        exit 0
    }
    $setupTools = if ($Command -eq '.setup' -and $Argument) { @($Argument.ToLowerInvariant()) } else { @('bun','node') }
    $checks = @{}
    foreach ($name in $setupTools) { $checks[$name] = Get-DevTool $name }
    if ($Command -eq '.info') {
        @{ schema='gidd.dev/v1'; bun=$checks.bun; node=$checks.node; tools_root=$toolsRoot; storage=$storage } | ConvertTo-Json -Depth 8
        if ($checks.bun.status -eq 'ready' -and $checks.node.status -eq 'ready') { exit 0 } else { exit 1 }
    }
    if ($Command -eq '.setup') {
        $needsLocal = $setupTools | Where-Object { $checks[$_].status -ne 'ready' -or (Test-DevManagedTool $checks[$_] $_) }
        if ($needsLocal) {
            foreach ($file in @('setup-tools/_filesystem.ps1','setup-tools/download.ps1','setup-tools/releases.ps1','setup-tools/install.ps1')) { . (Join-Path $codeRoot $file) }
            $manifest = [IO.File]::ReadAllText((Join-Path $repoRoot 'skills/gidd/assets/runtimes.json')) | ConvertFrom-Json
            $devManifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'runtimes.json')) | ConvertFrom-Json
            foreach ($item in @($manifest,$devManifest)) {
                if ($item.schema -ne 'gidd.runtimes/v1' -or $item.platform -ne 'windows-x64') { throw 'invalid_runtime_manifest' }
            }
            $lock = Open-GiddInstallLock $toolsRoot
            Write-GiddInstallationGuide $toolsRoot
            foreach ($name in $setupTools) {
                $check = Get-DevTool $name
                if ($check.status -eq 'ready') {
                    if (Test-DevManagedTool $check $name) { Remove-GiddStage $toolsRoot $name }
                } else {
                    if (Test-Path -LiteralPath (Join-Path $toolsRoot $name)) { throw "occupied_or_version_conflicting_target:$name" }
                    $pinned = @(@($manifest.tools) + @($devManifest.tools) | Where-Object name -eq $name)[0]
                    $definition = Resolve-GiddRelease $name $storage.tools[$name] $pinned
                    $minimum = switch ($name) { bun { [version]'1.2.15' } node { [version]'24.0.0' } gh { [version]'2.98.0' } }
                    if ([version]$definition.version -lt $minimum) { throw "configured_version_below_minimum:$name" }
                    [void](Install-GiddTool $toolsRoot $definition {
                        param($phase)
                        [Console]::Error.WriteLine("Development ${name}: $phase")
                    })
                }
                $checks[$name] = Get-DevTool $name
                if ($checks[$name].status -ne 'ready') { throw "development_runtime_unusable:$name" }
            }
        }
        foreach ($name in $setupTools) { [Console]::WriteLine("${name} $($checks[$name].details.version): $($checks[$name].details.path)") }
        exit 0
    }
    $runtimes = if ($Command -eq '.test-bun') { @('bun') } elseif ($Command -eq '.test-node') { @('node') } else { @('bun','node') }
    foreach ($name in $runtimes) {
        if ($checks[$name].status -ne 'ready') { throw "$name unavailable. Run dev.cmd .setup first." }
    }
    $testCommand = if ($Command -eq '.test-live') { '.test-live' } else { '.test' }
    $testExit = 0
    $testWatch = [Diagnostics.Stopwatch]::StartNew()
    $runtimeResults = @()
    Push-Location -LiteralPath $repoRoot
    try {
        foreach ($name in $runtimes) {
            $runtimeWatch = [Diagnostics.Stopwatch]::StartNew()
            & $checks[$name].details.path (Join-Path $PSScriptRoot 'dev.mjs') $testCommand $Argument
            $runtimeExit = $LASTEXITCODE
            $runtimeWatch.Stop()
            if ($runtimeExit -ne 0) { $testExit = 1 }
            $resultLabel = if ($runtimeExit -eq 0) { 'PASS' } else { 'FAIL' }
            $runtimeResults += ('{0} {1} {2} ({3:F2}s)' -f $resultLabel, $name, $checks[$name].details.version, $runtimeWatch.Elapsed.TotalSeconds)
        }
    } finally { Pop-Location }
    [Console]::WriteLine("`nRuntime summary:")
    foreach ($line in $runtimeResults) { [Console]::WriteLine($line) }
    [Console]::WriteLine(('Total: {0:F2}s; exit {1}' -f $testWatch.Elapsed.TotalSeconds, $testExit))
    exit $testExit
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
