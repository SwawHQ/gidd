param([string]$NodePath, [string]$BunPath, [string]$GhPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$doctor = Join-Path $root 'skills/gidd/scripts/windows/doctor.ps1'
$git = @(Get-Command git.exe -CommandType Application)[0].Source
$shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$savedPath = $env:PATH
$savedGitDir = $env:GIT_DIR
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gidd-doctor-' + [guid]::NewGuid().ToString('N'))
$skills = Join-Path $fixture '技能 with spaces'
$repository = Join-Path $fixture 'repo 中文 & spaces'
$fakeBin = Join-Path $fixture 'fake-bin'
$emptyBin = Join-Path $fixture 'empty-bin'
$script:passed = 0

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Check($Report, [string]$Id) {
    $item = @($Report.checks | Where-Object id -eq $Id)
    Assert-True ($item.Count -eq 1) "Expected exactly one check: $Id"
    return $item[0]
}
function New-Stub([string]$Destination, [string]$Mode) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
    Copy-Item -LiteralPath (Join-Path $fixture 'stub.exe') -Destination $Destination
    [IO.File]::WriteAllText(($Destination + '.mode'), $Mode)
}
function Snapshot {
    return ((Get-ChildItem -LiteralPath $fixture -Recurse -Force | Sort-Object FullName | ForEach-Object {
        if ($_.PSIsContainer) { $_.FullName + ':directory' }
        else { $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    }) -join "`n")
}
function Run-Case([string]$Name, [string]$SearchPath, [scriptblock]$Validate, [string]$Target = $repository) {
    $before = Snapshot
    $env:PATH = $SearchPath
    $json = & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $doctor -RepositoryPath $Target -UserSkillsRoot $skills
    $exitCode = $LASTEXITCODE
    $report = ($json -join "`n") | ConvertFrom-Json
    Assert-True ($report.schema -eq 'gidd.doctor/v1') 'Wrong schema'
    Assert-True ((Snapshot) -ceq $before) "Diagnostic wrote fixture files: $Name"
    & $Validate $report $exitCode
    $script:passed++
    Write-Output "PASS $Name"
}

try {
    foreach ($path in @($doctor, (Join-Path $root 'skills/gidd/scripts/windows/process.ps1'), $PSCommandPath)) {
        $bytes = [IO.File]::ReadAllBytes($path)
        Assert-True ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'PowerShell source needs UTF-8 BOM'
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        Assert-True ($errors.Count -eq 0) 'PowerShell parse errors'
    }
    [void][IO.Directory]::CreateDirectory($fixture)
    foreach ($directory in @($skills, $repository, $fakeBin, $emptyBin)) { [void][IO.Directory]::CreateDirectory($directory) }
    $stub = @'
using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class Stub {
    public static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "--version") return 90;
        string mode = File.ReadAllText(Assembly.GetExecutingAssembly().Location + ".mode");
        if (mode == "hang") { Thread.Sleep(30000); return 91; }
        if (mode == "fail") { Console.Error.WriteLine("private-test-secret"); return 9; }
        Console.WriteLine(mode);
        return 0;
    }
}
'@
    Add-Type -TypeDefinition $stub -OutputAssembly (Join-Path $fixture 'stub.exe') -OutputType ConsoleApplication
    & $git -C $repository init --quiet
    Assert-True ($LASTEXITCODE -eq 0) 'Fixture Git init failed'
    $gitBin = [IO.Path]::GetDirectoryName($git)
    $gitOnly = "$emptyBin;$gitBin"
    Run-Case 'all dependencies missing' $emptyBin {
        param($r, $code)
        Assert-True ($code -eq 1) 'Missing tools must exit 1'
        foreach ($id in @('tool.git','tool.node','tool.bun','tool.gh','runtime')) {
            Assert-True ((Check $r $id).status -eq 'missing') "Expected missing $id"
        }
        Assert-True ((Check $r 'repository').status -eq 'not_checked') 'No Git means unverified repository'
    }
    New-Stub (Join-Path $fakeBin 'node.exe') 'v22.0.0'
    New-Stub (Join-Path $fakeBin 'gh.exe') 'gh version 2.98.0 (test)'
    $toolPath = "$fakeBin;$gitBin"
    Run-Case 'Node alone, unborn repository, missing config' $toolPath {
        param($r, $code)
        Assert-True ($code -eq 1) 'Uninitialized repository must exit 1'
        Assert-True ((Check $r 'runtime').details.selected -eq 'tool.node') 'Node alone must suffice'
        Assert-True ((Check $r 'repository.history').reason -eq 'unborn_branch') 'Unborn branch detection'
        Assert-True ((Check $r 'repository.config').status -eq 'missing') 'Missing config'
    }
    New-Stub (Join-Path $skills 'gidd.tools/bun/bun.exe') '1.2.15'
    New-Stub (Join-Path $skills 'gidd.tools/gh/gh.exe') 'gh version 2.98.0 (test)'
    Run-Case 'Bun alone from managed tools' $gitOnly {
        param($r, $code)
        Assert-True ((Check $r 'runtime').details.selected -eq 'tool.bun') 'Managed Bun must suffice'
        Assert-True ((Check $r 'tool.gh').details.source -eq 'gidd.tools') 'Managed gh selected'
    }
    Run-Case 'PATH Node preferred over managed Bun' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'runtime').details.selected -eq 'tool.node') 'Existing PATH runtime must win'
    }
    New-Stub (Join-Path $fakeBin 'bun.exe') '1.2.15'
    Run-Case 'PATH Bun tie preference' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'runtime').details.selected -eq 'tool.bun') 'Bun wins equal source preference'
    }
    [IO.File]::WriteAllText((Join-Path $fakeBin 'node.exe.mode'), 'v18.0.0')
    [IO.File]::WriteAllText((Join-Path $fakeBin 'bun.exe.mode'), 'fail')
    [IO.File]::WriteAllText((Join-Path $fakeBin 'gh.exe.mode'), 'not gh')
    Run-Case 'old, failing and malformed PATH tools fall back' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'tool.node').status -eq 'invalid') 'Old Node rejected'
        Assert-True ((Check $r 'tool.bun').details.source -eq 'gidd.tools') 'Failed Bun falls back'
        Assert-True ((Check $r 'tool.gh').details.source -eq 'gidd.tools') 'Malformed gh falls back'
        Assert-True (($r | ConvertTo-Json -Depth 12) -notmatch 'private-test-secret') 'Do not expose tool stderr'
    }
    [IO.File]::WriteAllText((Join-Path $fakeBin 'gh.exe.mode'), 'hang')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Run-Case 'hung executable times out and falls back' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'tool.gh').details.rejected[0].reason -eq 'process_timeout') 'Timeout reason'
    }
    Assert-True ($timer.Elapsed.TotalSeconds -lt 20) 'Bounded tool probe'
    [IO.File]::WriteAllText((Join-Path $fakeBin 'gh.exe.mode'), 'gh version 2.98.0 (test)')
    [IO.File]::WriteAllText((Join-Path $fakeBin 'bun.exe'), 'not a Windows executable')
    Run-Case 'broken executable falls back' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'tool.bun').details.rejected[0].reason -eq 'process_start_failed') 'Broken executable reason'
    }
    Run-Case 'ordinary directory is not a repository' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'repository').status -eq 'invalid') 'Reject ordinary directory'
        Assert-True ((Check $r 'repository.config').status -eq 'not_checked') 'Cannot infer repository config'
    } $skills
    & $git -C $repository -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty --quiet -m fixture
    & $git -C $repository remote add origin https://github.com/SwawHQ/gidd.git
    & $git -C $repository remote add private https://username:private-test-secret@example.invalid/private.git
    $config = Join-Path $repository '.agents/skills/gidd/config.toml'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($config))
    [IO.File]::WriteAllText($config, 'deliberately invalid TOML = [')
    $env:GIT_DIR = Join-Path $fixture 'nonexistent-git-dir'
    Run-Case 'local readiness, explicit Git target and redacted remote' $toolPath {
        param($r, $code)
        Assert-True ($code -eq 0 -and $r.status -eq 'local_ready') 'Local readiness'
        Assert-True ((Check $r 'repository.config.validation').status -eq 'not_checked') 'Do not claim TOML validation'
        Assert-True ((Check $r 'github.identity').status -eq 'not_checked') 'No authentication claims'
        $remotes = (Check $r 'repository.remotes').details.remotes
        Assert-True (($remotes | Where-Object name -eq origin).github_repository -eq 'SwawHQ/gidd') 'GitHub slug'
        Assert-True (($r | ConvertTo-Json -Depth 12) -notmatch 'private-test-secret') 'Do not expose credential URL'
    }
    $env:GIT_DIR = $savedGitDir
    $nested = Join-Path $repository 'nested directory'
    [void][IO.Directory]::CreateDirectory($nested)
    Run-Case 'nested target resolves repository root' $toolPath {
        param($r, $code)
        Assert-True ((Check $r 'repository.config').details.path -eq $config) 'Config must be relative to Git root'
    } $nested
    Run-Case 'missing target directory' $toolPath {
        param($r, $code)
        Assert-True ($code -eq 1) 'Missing directory needs setup'
        Assert-True ((Check $r 'repository').reason -eq 'directory_missing') 'Missing target reason'
        Assert-True ((Check $r 'runtime').status -eq 'ready') 'Independent runtime check still runs'
    } (Join-Path $fixture 'not-created')
    Remove-Item -LiteralPath $config
    [void][IO.Directory]::CreateDirectory($config)
    Run-Case 'config path is a directory' $toolPath {
        param($r, $code)
        Assert-True ($code -eq 1) 'Config directory blocks local readiness'
        Assert-True ((Check $r 'repository.config').status -eq 'invalid') 'Config must be a file'
    }
    Remove-Item -LiteralPath $config
    [IO.File]::WriteAllText($config, '')
    if ($NodePath -and $BunPath -and $GhPath) {
        foreach ($runtime in @($NodePath, $BunPath)) {
            $realPath = ([IO.Path]::GetDirectoryName($runtime)) + ';' + ([IO.Path]::GetDirectoryName($GhPath)) + ';' + $gitBin
            Run-Case ('real runtime: ' + [IO.Path]::GetFileName($runtime)) $realPath {
                param($r, $code)
                Assert-True ($code -eq 0) 'Real tools must satisfy local checks'
                Assert-True ((Check $r 'runtime').details.path -eq $runtime) 'Select actual runtime'
            }
        }
    }
    Write-Output "Passed $script:passed diagnostic cases; fixture contents unchanged by every diagnostic."
} finally {
    $env:PATH = $savedPath
    $env:GIT_DIR = $savedGitDir
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedFixture) -match '^gidd-doctor-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
}
