param(
    [string]$Command = '.help',
    [string]$Argument = '',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Extra = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$codeRoot = Join-Path $repoRoot 'skills/gidd/scripts/windows'
$toolsRoot = $null
$storage = $null
$lock = $null
function Get-DevRuntime {
    param([string]$Name)
    $minimum = if ($Name -eq 'bun') { [version]'1.2.15' } else { [version]'24.0.0' }
    $pattern = if ($Name -eq 'bun') { '^(\d+\.\d+\.\d+)$' } else { '^v(\d+\.\d+\.\d+)$' }
    $check = Find-Tool $Name $minimum $pattern (Join-Path $toolsRoot "$Name/$Name.exe") $storage.tools[$Name].version
    return $check
}
function Test-DevManagedRuntime {
    param($Check, [string]$Name)
    return $Check.status -eq 'ready' -and [string]::Equals(
        [IO.Path]::GetFullPath($Check.details.path), (Join-Path $toolsRoot "$Name/$Name.exe"), [StringComparison]::OrdinalIgnoreCase)
}
try {
    if ($Extra.Count) { throw 'Unexpected arguments. Use dev.cmd .help.' }
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
    if ($Command -notin @('.info','.setup','.test','.test-bun','.test-node','.test-live')) { throw 'Unknown command. Use dev.cmd .help.' }
    if ($Command -eq '.info' -and $Argument) { throw '.info takes no arguments.' }
    if ($Command -in @('.test','.test-bun','.test-node') -and $Argument -and $Argument -notin @('all','doctor','setup','process','dev','config')) { throw 'Unknown test suite.' }
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','lib/_configuration.ps1','doctor/platform.ps1')) { . (Join-Path $codeRoot $file) }
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    if ($Command -in @('.setup','.test-live') -and $Argument) {
        if ($Argument -notmatch '^[A-Za-z]:[\\/]') { throw 'archive_directory_must_be_absolute' }
        Assert-GiddPlainPath $Argument
    }
    $storage = Resolve-GiddToolStorage $repoRoot '.dev'
    $toolsRoot = $storage.tools_root
    $checks = @{ bun = (Get-DevRuntime 'bun'); node = (Get-DevRuntime 'node') }
    if ($Command -eq '.info') {
        @{ schema='gidd.dev/v1'; bun=$checks.bun; node=$checks.node; tools_root=$toolsRoot; storage=$storage } | ConvertTo-Json -Depth 8
        if ($checks.bun.status -eq 'ready' -and $checks.node.status -eq 'ready') { exit 0 } else { exit 1 }
    }
    if ($Command -eq '.setup') {
        $needsLocal = @('bun','node') | Where-Object { $checks[$_].status -ne 'ready' -or (Test-DevManagedRuntime $checks[$_] $_) }
        if ($needsLocal) {
            foreach ($file in @('setup-tools/_filesystem.ps1','setup-tools/download.ps1','setup-tools/releases.ps1','setup-tools/install.ps1')) { . (Join-Path $codeRoot $file) }
            $manifest = [IO.File]::ReadAllText((Join-Path $repoRoot 'skills/gidd/assets/runtimes.json')) | ConvertFrom-Json
            $devManifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'runtimes.json')) | ConvertFrom-Json
            foreach ($item in @($manifest,$devManifest)) {
                if ($item.schema -ne 'gidd.runtimes/v1' -or $item.platform -ne 'windows-x64') { throw 'invalid_runtime_manifest' }
            }
            $lock = Open-GiddInstallLock $toolsRoot
            Write-GiddInstallationGuide $toolsRoot
            foreach ($name in @('bun','node')) {
                $check = Get-DevRuntime $name
                if ($check.status -eq 'ready') {
                    if (Test-DevManagedRuntime $check $name) { Remove-GiddStage $toolsRoot $name }
                } else {
                    if (Test-Path -LiteralPath (Join-Path $toolsRoot $name)) { throw "occupied_or_version_conflicting_target:$name" }
                    $pinned = @(@($manifest.tools) + @($devManifest.tools) | Where-Object name -eq $name)[0]
                    $definition = Resolve-GiddRelease $name $storage.tools[$name] $pinned $Argument
                    $minimum = if ($name -eq 'node') { [version]'24.0.0' } else { [version]'1.2.15' }
                    if ([version]$definition.version -lt $minimum) { throw "configured_version_below_minimum:$name" }
                    [void](Install-GiddTool $toolsRoot $definition $Argument {
                        param($phase)
                        [Console]::Error.WriteLine("Development ${name}: $phase")
                    })
                }
                $checks[$name] = Get-DevRuntime $name
                if ($checks[$name].status -ne 'ready') { throw "development_runtime_unusable:$name" }
            }
        }
        foreach ($name in @('bun','node')) { [Console]::WriteLine("${name} $($checks[$name].details.version): $($checks[$name].details.path)") }
        exit 0
    }
    $runtimes = if ($Command -eq '.test-bun') { @('bun') } elseif ($Command -eq '.test-node') { @('node') } else { @('bun','node') }
    foreach ($name in $runtimes) {
        if ($checks[$name].status -ne 'ready') { throw "$name unavailable. Run dev.cmd .setup first." }
    }
    $testCommand = if ($Command -eq '.test-live') { '.test-live' } else { '.test' }
    $testExit = 0
    Push-Location -LiteralPath $repoRoot
    try {
        foreach ($name in $runtimes) {
            & $checks[$name].details.path (Join-Path $PSScriptRoot 'dev.mjs') $testCommand $Argument
            if ($LASTEXITCODE -ne 0) { $testExit = 1 }
        }
    } finally { Pop-Location }
    exit $testExit
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
