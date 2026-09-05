function Invoke-DoctorProcess {
    param([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 5)

    # Internal execution helper, not a diagnostic domain.

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
    try {
        [void]$process.Start()
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
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
