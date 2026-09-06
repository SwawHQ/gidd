param([switch]$Download, [string]$ArchiveDirectory = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $Download -and -not $ArchiveDirectory) { throw 'Choose -Download or an explicit offline -ArchiveDirectory.' }
$code = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../skills/gidd/scripts/windows'))
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gidd-live-' + [guid]::NewGuid().ToString('N'))
$shellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$savedPath = $env:PATH
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    $skills = Join-Path $fixture '技能 tools'
    $env:PATH = ''
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $shellPath
    $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $code 'setup-tools.ps1') + '" -UserSkillsRoot "' + $skills + '"'
    if ($ArchiveDirectory) { $start.Arguments += ' -ArchiveDirectory "' + $ArchiveDirectory + '"' }
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $process=[Diagnostics.Process]::Start($start)
    $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(300000)) { $process.Kill(); throw 'Live download timed out' }
    $out=$stdout.GetAwaiter().GetResult(); $err=$stderr.GetAwaiter().GetResult()
    $exitCode=$process.ExitCode; $process.Dispose()
    if ($exitCode -ne 0) { throw "Live setup failed: $out $err" }
    $result=$out | ConvertFrom-Json
    if ($result.status -ne 'ready' -or @($result.tools | Where-Object action -eq installed).Count -ne 2) { throw 'Expected both tools installed' }
    $json = & $shellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $code 'doctor.ps1') -RepositoryPath $fixture -UserSkillsRoot $skills
    $diagnosis = $json | ConvertFrom-Json
    foreach ($id in @('tool.bun','tool.gh','runtime')) {
        if (@($diagnosis.checks | Where-Object id -eq $id)[0].status -ne 'ready') { throw "Doctor failed $id" }
    }
    $json = & $shellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $code 'setup-tools.ps1') -UserSkillsRoot $skills -ArchiveDirectory (Join-Path $fixture 'missing')
    if ($LASTEXITCODE -ne 0 -or @((($json | ConvertFrom-Json).tools) | Where-Object action -ne reused).Count) { throw 'Repeat must be offline reuse' }
    Write-Output ('PASS official Bun/gh payloads, post-install doctor and offline reuse ({0:N1}s)' -f $timer.Elapsed.TotalSeconds)
} finally {
    $env:PATH=$savedPath
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if ([IO.Path]::GetFullPath($fixture).StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fixture) -match '^gidd-live-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
