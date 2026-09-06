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
$toolsRoot = Join-Path $repoRoot '.dev'
$lock = $null
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
    if ($Command -notin @('.info','.setup','.test','.test-live')) { throw 'Unknown command. Use dev.cmd .help.' }
    if ($Command -eq '.info' -and $Argument) { throw '.info takes no arguments.' }
    if ($Command -eq '.test' -and $Argument -and $Argument -notin @('all','doctor','setup','process','dev')) { throw 'Unknown test suite.' }
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','doctor/platform.ps1')) { . (Join-Path $codeRoot $file) }
    if ((Get-DoctorPlatformCheck).status -ne 'ready') { throw 'unsupported_platform' }
    if ($Command -in @('.setup','.test-live') -and $Argument) {
        if ($Argument -notmatch '^[A-Za-z]:[\\/]') { throw 'archive_directory_must_be_absolute' }
        Assert-GiddPlainPath $Argument
    }
    $bun = Find-Tool 'bun' ([version]'1.2.15') '^(\d+\.\d+\.\d+)$' (Join-Path $toolsRoot 'bun/bun.exe')
    if ($Command -eq '.info') {
        if ($bun.status -eq 'ready' -and $bun.details.source -eq 'gidd.tools') { $bun.details.source = 'checkout' }
        @{ schema='gidd.dev/v1'; bun=$bun; tools_root=$toolsRoot } | ConvertTo-Json -Depth 8
        if ($bun.status -eq 'ready') { exit 0 } else { exit 1 }
    }
    if ($Command -eq '.setup') {
        $usesLocalBun = $bun.status -eq 'ready' -and [string]::Equals(
            [IO.Path]::GetFullPath($bun.details.path), (Join-Path $toolsRoot 'bun/bun.exe'), [StringComparison]::OrdinalIgnoreCase)
        if ($bun.status -ne 'ready' -or $usesLocalBun) {
            foreach ($file in @('setup-tools/_filesystem.ps1','setup-tools/download.ps1','setup-tools/install.ps1')) { . (Join-Path $codeRoot $file) }
            $manifest = [IO.File]::ReadAllText((Join-Path $repoRoot 'skills/gidd/assets/runtimes.json')) | ConvertFrom-Json
            if ($manifest.schema -ne 'gidd.runtimes/v1' -or $manifest.platform -ne 'windows-x64') { throw 'invalid_runtime_manifest' }
            $lock = Open-GiddInstallLock $toolsRoot
            $guide = "Development-only Bun for this checkout. Source and hashes: skills/gidd/assets/runtimes.json and bun/install.json.`nTemporary downloads and extraction: .cache/bun/ (removed after success or rebuilt on retry). Lock: .cache/install.lock (retained).`nRemove .dev/ or its cache only when no setup or tests are running. External PATH tools and user-level GIDD tools are not owned here.`n"
            Write-GiddDurableFile (Join-Path $repoRoot '.dev/INSTALLATION.md') ([Text.Encoding]::UTF8.GetBytes($guide))
            [void](Install-GiddTool $toolsRoot @($manifest.tools | Where-Object name -eq bun)[0] $Argument {
                param($phase)
                [Console]::Error.WriteLine("Development Bun: $phase")
            })
            $bun = Find-Tool 'bun' ([version]'1.2.15') '^(\d+\.\d+\.\d+)$' (Join-Path $toolsRoot 'bun/bun.exe')
            if ($bun.status -ne 'ready') { throw 'development_bun_unusable' }
        }
        [Console]::WriteLine("Bun $($bun.details.version): $($bun.details.path)")
        exit 0
    }
    if ($bun.status -ne 'ready') { throw 'Bun unavailable. Run dev.cmd .setup first.' }
    Push-Location -LiteralPath $repoRoot
    try {
        & $bun.details.path (Join-Path $PSScriptRoot 'dev.mjs') $Command $Argument
        $testExit = $LASTEXITCODE
    } finally { Pop-Location }
    exit $testExit
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
