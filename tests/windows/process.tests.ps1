param([string]$HelperPath = '', [string]$FunctionName = 'Invoke-DoctorProcess')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $HelperPath) { $HelperPath = Join-Path $PSScriptRoot '../../skills/gidd/scripts/windows/doctor/_process.ps1' }
foreach ($path in @($HelperPath, $PSCommandPath)) {
    $bytes = [IO.File]::ReadAllBytes($path)
    if ($bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) { throw 'Missing PowerShell UTF-8 BOM' }
    $tokens=$null; $errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'PowerShell parse failed' }
}
. $HelperPath
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gidd-process-' + [guid]::NewGuid().ToString('N'))
$children = @()
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    $code = @'
using System;
using System.IO;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
public static class PipeParent {
    public static int Main(string[] args) {
        if (args[0] == "child") { Thread.Sleep(10000); return 0; }
        if (args[0] == "normal") { Console.WriteLine("complete output"); Console.Error.WriteLine("private stderr"); return 0; }
        if (args[0] == "hang") { Thread.Sleep(10000); return 0; }
        var info = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "child");
        info.UseShellExecute = false; info.CreateNoWindow = true;
        var child = Process.Start(info);
        File.WriteAllText(args[1], child.Id.ToString());
        Thread.Sleep(Int32.Parse(args[0]));
        Console.WriteLine("parent exited");
        return 0;
    }
}
'@
    $exe = Join-Path $fixture 'pipe-parent.exe'
    Add-Type -TypeDefinition $code -OutputAssembly $exe -OutputType ConsoleApplication
    $result = & $FunctionName $exe @('normal') -TimeoutSeconds 2
    if (-not $result.ok -or $result.text -ne 'complete output') { throw 'Completed stdout capture failed' }
    Write-Output 'PASS completed process and drained pipes'
    foreach ($delay in @(0, 1400)) {
        $pidFile = Join-Path $fixture "$delay.pid"
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $result = & $FunctionName $exe @([string]$delay, $pidFile) -TimeoutSeconds 2
        $elapsed = $timer.Elapsed.TotalMilliseconds
        if (Test-Path -LiteralPath $pidFile) { $children += [int][IO.File]::ReadAllText($pidFile) }
        if ($result.ok -or $result.reason -ne 'process_timeout' -or $result.text -ne '') { throw 'Inherited output pipe must time out' }
        if ($elapsed -gt 2800 -or $elapsed -lt 1800) { throw "Deadline was not shared: $elapsed ms" }
        Write-Output ('PASS inherited pipes, parent delay {0}ms: {1:N0}ms total' -f $delay, $elapsed)
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $result = & $FunctionName $exe @('hang') -TimeoutSeconds 1
    if ($result.ok -or $result.reason -ne 'process_timeout' -or $timer.Elapsed.TotalMilliseconds -gt 1800) { throw 'Running parent timeout regressed' }
    Write-Output 'PASS running parent timeout'
} finally {
    foreach ($childId in $children) {
        $child = Get-Process -Id $childId -ErrorAction SilentlyContinue
        if ($child -and $child.ProcessName -eq 'pipe-parent') { $child.Kill(); $child.WaitForExit(); $child.Dispose() }
    }
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if ([IO.Path]::GetFullPath($fixture).StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fixture) -match '^gidd-process-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
