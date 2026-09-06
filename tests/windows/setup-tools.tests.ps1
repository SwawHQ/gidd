Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$code = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../skills/gidd/scripts/windows'))
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gidd-install-' + [guid]::NewGuid().ToString('N'))
$shellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$savedPath = $env:PATH
$script:count = 0
function Assert($Value, [string]$Reason) { if (-not $Value) { throw $Reason } }
function Pass([string]$Name) { $script:count++; Write-Output "PASS $Name" }
function Reject([scriptblock]$Action, [string]$Reason) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed $Reason
}
function Start-Worker([string]$Tools, [string]$Stop = '') {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $shellPath
    $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'install-worker.ps1') +
        '" -CodeRoot "' + $code + '" -ToolsRoot "' + $Tools + '" -DefinitionPath "' + $definitionPath + '" -ArchiveDirectory "' + $fixture + '"'
    if ($Stop) { $start.Arguments += ' -StopAt ' + $Stop }
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    return [Diagnostics.Process]::Start($start)
}
function Wait-Worker($Process) {
    if (-not $Process.WaitForExit(15000)) { $Process.Kill(); throw 'worker_timeout' }
    $out = $Process.StandardOutput.ReadToEnd(); $err = $Process.StandardError.ReadToEnd()
    $exitCode = $Process.ExitCode; $Process.Dispose()
    return @{ code = $exitCode; output = $out; error = $err }
}
function Make-Zip([string]$ZipPath, [string]$EntryName, [string]$Source) {
    $zip = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
    try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $Source, $EntryName) }
    finally { $zip.Dispose() }
}
try {
    foreach ($source in @(Get-ChildItem -LiteralPath $code -Recurse -Filter '*.ps1') + @(Get-Item $PSCommandPath,(Join-Path $PSScriptRoot 'install-worker.ps1'))) {
        $bytes = [IO.File]::ReadAllBytes($source.FullName)
        Assert ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'PowerShell BOM'
        $tokens=$null; $errors=$null
        [void][Management.Automation.Language.Parser]::ParseFile($source.FullName,[ref]$tokens,[ref]$errors)
        Assert ($errors.Count -eq 0) 'PowerShell parse'
    }
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','setup-tools/_filesystem.ps1','setup-tools/download.ps1','setup-tools/install.ps1')) { . (Join-Path $code $file) }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    [void][IO.Directory]::CreateDirectory($fixture)
    $stub = @'
using System;
using System.IO;
using System.Reflection;
public class Tool {
    public static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "--version") return 50;
        string name = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
        Console.WriteLine(name == "node" ? "v24.0.0" : name == "gh" ? "gh version 2.98.0 (test)" : "1.2.15");
        return 0;
    }
}
'@
    $exe = Join-Path $fixture 'stub.exe'
    Add-Type -TypeDefinition $stub -OutputAssembly $exe -OutputType ConsoleApplication
    $archive = Join-Path $fixture 'bun.zip'
    Make-Zip $archive 'bun-windows-x64/bun.exe' $exe
    $definition = [pscustomobject]@{ name='bun'; version='1.2.15'; archive='bun.zip'; url='https://example.invalid/bun.zip'
        sha256=(Get-FileHash $archive).Hash.ToLowerInvariant(); files=@(@{entry='bun-windows-x64/bun.exe';name='bun.exe'}); supplements=@() }
    $definitionPath = Join-Path $fixture 'definition.json'
    [IO.File]::WriteAllText($definitionPath, ($definition | ConvertTo-Json -Depth 6))
    $tools = Join-Path $fixture '技能 space/gidd.tools'
    $lock = Open-GiddInstallLock $tools
    try {
        Write-GiddInstallationGuide $tools
        [IO.File]::WriteAllText((Join-Path $tools 'INSTALLATION.md'), 'old guide')
        Write-GiddInstallationGuide $tools
        Assert ([IO.File]::ReadAllText((Join-Path $tools 'INSTALLATION.md')).StartsWith('# GIDD-managed tools')) 'Atomic guide replacement'
        $result = Install-GiddTool $tools $definition $fixture
        Assert ($result.action -eq 'installed' -and (Test-GiddManagedTool (Join-Path $tools 'bun') 'bun')) 'Install failed'
        $hash = (Get-FileHash (Join-Path $tools 'bun/install.json')).Hash
        $result = Install-GiddTool $tools $definition (Join-Path $fixture 'missing-offline-files')
        Assert ($result.action -eq 'reused' -and (Get-FileHash (Join-Path $tools 'bun/install.json')).Hash -eq $hash) 'Repeat install must be offline and unchanged'
    } finally { $lock.Dispose() }
    Pass 'install, manifest, repeat without download, Unicode paths'
    foreach ($phase in @('downloaded','extracted','verified','published')) {
        $target = Join-Path $fixture "kill-$phase/gidd.tools"
        $worker = Wait-Worker (Start-Worker $target $phase)
        Assert ($worker.code -ne 0) 'Worker must be killed'
        Assert ((Test-Path (Join-Path $target 'bun')) -eq ($phase -eq 'published')) 'Only complete directories may be published'
        $worker = Wait-Worker (Start-Worker $target)
        Assert ($worker.code -eq 0 -and (Test-GiddManagedTool (Join-Path $target 'bun') 'bun')) "Recovery failed: $($worker.error)"
        Assert (-not (Test-Path (Join-Path $target '.install/bun'))) 'Staging must be cleaned after recovery'
        Pass "forced termination at $phase and recovery"
    }
    $concurrent = Join-Path $fixture 'concurrent/gidd.tools'
    $owner = Start-Worker $concurrent 'locked'
    try {
        $timer=[Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path ($definitionPath + '.locked'))) {
            if ($timer.Elapsed.TotalSeconds -gt 10) { throw 'Lock owner did not start' }
            Start-Sleep -Milliseconds 50
        }
        $other = Wait-Worker (Start-Worker $concurrent)
        Assert ($other.code -ne 0 -and $other.error -match 'install_locked') 'Concurrent installer must fail without writes'
    } finally { if (-not $owner.HasExited) { $owner.Kill() }; $owner.WaitForExit(); $owner.Dispose() }
    $worker = Wait-Worker (Start-Worker $concurrent)
    Assert ($worker.code -eq 0) 'OS must release lock after owner is killed'
    Pass 'concurrent process rejected; killed lock owner needs no manual lock deletion'
    $partialRoot = Join-Path $fixture 'partial/gidd.tools'
    [void][IO.Directory]::CreateDirectory((Join-Path $partialRoot '.install/bun/payload'))
    [IO.File]::WriteAllText((Join-Path $partialRoot '.install/bun/download.part'), 'truncated download')
    [IO.File]::WriteAllText((Join-Path $partialRoot '.install/bun/payload/bun.exe'), 'truncated extraction')
    $worker = Wait-Worker (Start-Worker $partialRoot)
    Assert ($worker.code -eq 0) 'Partial staging recovery'
    Pass 'partial download and extraction discarded on explicit retry'
    $corrupt = Join-Path $tools 'bun/bun.exe'
    [IO.File]::WriteAllText($corrupt, 'corrupted')
    $hash = (Get-FileHash $corrupt).Hash
    Reject { Install-GiddTool $tools $definition $fixture } 'Corrupt target must fail'
    Assert ((Get-FileHash $corrupt).Hash -eq $hash) 'Corrupt target must be preserved'
    $check = Find-Tool 'bun' ([version]'1.2') '^(\d+\.\d+\.\d+)$' $corrupt
    Assert ($check.details.rejected[-1].reason -eq 'managed_integrity_failed') 'Doctor must reject before executing corrupt tool'
    Pass 'corrupt installed tool rejected and preserved'
    $unknownRoot = Join-Path $fixture 'unknown/gidd.tools'
    [void][IO.Directory]::CreateDirectory((Join-Path $unknownRoot 'bun'))
    [IO.File]::WriteAllText((Join-Path $unknownRoot 'bun/user.txt'), 'keep')
    Reject { Install-GiddTool $unknownRoot $definition $fixture } 'Unknown target must fail'
    Assert ([IO.File]::ReadAllText((Join-Path $unknownRoot 'bun/user.txt')) -eq 'keep') 'Preserve unknown files'
    Pass 'unknown directory is not overwritten'
    $pairRoot = Join-Path $fixture 'pair/gidd.tools'
    [void](Install-GiddTool $pairRoot $definition $fixture)
    $ghDefinition = $definition | ConvertTo-Json -Depth 6 | ConvertFrom-Json
    $ghDefinition.name='gh'; $ghDefinition.archive='absent-gh.zip'; $ghDefinition.version='2.98.0'
    Reject { Install-GiddTool $pairRoot $ghDefinition $fixture } 'Second tool download must fail'
    Assert (Test-GiddManagedTool (Join-Path $pairRoot 'bun') 'bun') 'First completed tool must remain valid'
    Assert (-not (Test-Path (Join-Path $pairRoot 'gh'))) 'Failed second tool must not be published'
    Pass 'second tool failure preserves completed first tool'
    foreach ($case in @('hash','zip','traversal','version')) {
        $bad = $definition | ConvertTo-Json -Depth 6 | ConvertFrom-Json
        $badRoot = Join-Path $fixture "$case/gidd.tools"
        if ($case -eq 'hash') { $bad.sha256 = '0' * 64 }
        if ($case -eq 'zip') {
            $bad.archive='broken.zip'; [IO.File]::WriteAllText((Join-Path $fixture $bad.archive),'not zip')
            $bad.sha256=(Get-FileHash (Join-Path $fixture $bad.archive)).Hash.ToLowerInvariant()
        }
        if ($case -eq 'traversal') {
            $bad.archive='traversal.zip'; Make-Zip (Join-Path $fixture $bad.archive) '../escape.exe' $exe
            $bad.sha256=(Get-FileHash (Join-Path $fixture $bad.archive)).Hash.ToLowerInvariant()
        }
        if ($case -eq 'version') { $bad.version='1.9.9' }
        Reject { Install-GiddTool $badRoot $bad $fixture } "Must reject $case"
        Assert (-not (Test-Path (Join-Path $badRoot 'bun'))) 'Failure must not publish'
        Pass "reject $case before publish"
    }
    $outside = Join-Path $fixture 'outside'
    [void][IO.Directory]::CreateDirectory($outside)
    [IO.File]::WriteAllText((Join-Path $outside 'keep.txt'),'keep')
    $junction = Join-Path $fixture 'linked'
    [void](New-Item -ItemType Junction -Path $junction -Target $outside)
    Reject { Open-GiddInstallLock (Join-Path $junction 'gidd.tools') } 'Reject reparse ancestor'
    $stageLink = Join-Path $fixture 'junction-stage/gidd.tools/.install/bun'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stageLink))
    [void](New-Item -ItemType Junction -Path $stageLink -Target $outside)
    Reject { Remove-GiddStage (Join-Path $fixture 'junction-stage/gidd.tools') 'bun' } 'Reject reparse stage'
    Assert ([IO.File]::ReadAllText((Join-Path $outside 'keep.txt')) -eq 'keep') 'Never follow junction during cleanup'
    [IO.Directory]::Delete($junction); [IO.Directory]::Delete($stageLink)
    Pass 'reparse ancestor and staging rejected without touching target'
    $external = Join-Path $fixture 'external'
    [void][IO.Directory]::CreateDirectory($external)
    Copy-Item $exe (Join-Path $external 'node.exe'); Copy-Item $exe (Join-Path $external 'gh.exe')
    $env:PATH=$external
    $newSkills = Join-Path $fixture 'not-created-skills'
    $json = & $shellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $code 'setup-tools.ps1') -UserSkillsRoot $newSkills
    Assert ($LASTEXITCODE -eq 0 -and ($json | ConvertFrom-Json).status -eq 'ready') 'Reuse existing Node and gh'
    Assert (-not (Test-Path $newSkills)) 'External reuse creates no directories'
    Pass 'public entry reuses Node and gh without creating data'
    Write-Output "Passed $script:count installation/recovery cases."
} finally {
    $env:PATH=$savedPath
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if ([IO.Path]::GetFullPath($fixture).StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fixture) -match '^gidd-install-[0-9a-f]{32}$') {
        # Test junctions must be removed without traversal before recursive fixture cleanup.
        foreach ($relative in @('linked','junction-stage/gidd.tools/.install/bun')) {
            $path=Join-Path $fixture $relative
            if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($path) }
        }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
