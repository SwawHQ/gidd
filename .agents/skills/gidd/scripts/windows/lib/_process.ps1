function Invoke-GiddProcess {
    param([string]$Executable, [string[]]$Arguments, [ValidateRange(1, 3600)][int]$TimeoutSeconds = 5)

    # Shared by diagnosis and installation; not a diagnostic domain.

    # ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
    $quoted = foreach ($argument in $Arguments) {
        '"' + [regex]::Replace([regex]::Replace($argument, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $quoted -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $start.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'
    # Repository discovery must describe the explicit target, not inherited Git overrides.
    foreach ($key in @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES')) {
        $start.EnvironmentVariables.Remove($key)
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $budgetMs = $TimeoutSeconds * 1000
    try {
        [void]$process.Start()
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $remainingMs = [int][Math]::Max(0, $budgetMs - $timer.ElapsedMilliseconds)
        $exited = $process.WaitForExit($remainingMs)
        $drained = $false
        if ($exited) {
            # Descendants may retain the pipes after their parent exits. Both EOFs
            # must arrive within the original deadline, not a fresh timeout.
            $remainingMs = [int][Math]::Max(0, $budgetMs - $timer.ElapsedMilliseconds)
            $drained = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), $remainingMs)
        }
        if (-not $exited -or -not $drained) {
            if (-not $process.HasExited) { $process.Kill() }
            return @{ ok = $false; reason = 'process_timeout'; text = '' }
        }
        # Do not expose arbitrary stderr, which may contain private URLs or credentials.
        [void]$stderr.GetAwaiter().GetResult()
        $output = $stdout.GetAwaiter().GetResult()
        return @{ ok = ($process.ExitCode -eq 0); reason = 'process_exit'; text = $output.Trim() }
    } catch {
        return @{ ok = $false; reason = 'process_start_failed'; text = '' }
    } finally {
        $process.Dispose()
    }
}
