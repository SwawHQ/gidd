function Get-DoctorPlatformCheck {
    $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
    if (-not $architecture) { $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
    $supported = [Environment]::OSVersion.Platform -eq 'Win32NT' -and $architecture -eq 'AMD64'
    $platformStatus = if ($supported) { 'ready' } else { 'invalid' }
    New-Check 'platform' $platformStatus 'windows_x64_initial_target' @{ architecture = $architecture }

}
