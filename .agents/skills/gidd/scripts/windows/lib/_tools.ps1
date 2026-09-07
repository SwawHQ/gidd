function New-Check {
    param([string]$Id, [string]$Status, [string]$Reason, [hashtable]$Details = @{})
    return [ordered]@{ id = $Id; status = $Status; reason = $Reason; details = $Details }
}

function Find-Tool {
    param([string]$Name, [version]$Minimum, [string]$Pattern, [string]$ManagedPath, [string]$RequestedVersion = '')
    $managedFullPath = if ($ManagedPath) { [IO.Path]::GetFullPath($ManagedPath) } else { '' }
    $candidates = @()
    foreach ($command in @(Get-Command "$Name.exe" -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $candidates += @{ path = $command.Source; source = 'path' }
    }
    if ($ManagedPath -and (Test-Path -LiteralPath $ManagedPath)) {
        $candidates += @{ path = $ManagedPath; source = 'managed' }
    }
    $attempts = @()
    foreach ($candidate in $candidates) {
        $isManaged = $candidate.source -eq 'managed' -or ($managedFullPath -and
            [string]::Equals([IO.Path]::GetFullPath($candidate.path), $managedFullPath, [StringComparison]::OrdinalIgnoreCase))
        if ($isManaged -and
            -not (Test-GiddManagedTool ([IO.Path]::GetDirectoryName($candidate.path)) $Name)) {
            $attempts += @{ path = $candidate.path; source = $candidate.source; reason = 'managed_integrity_failed'; version = $null }
            continue
        }
        $result = Invoke-GiddProcess $candidate.path @('--version')
        $version = $null
        $reason = $result.reason
        if ($result.ok) {
            if ($result.text -match $Pattern) {
                $version = $Matches[1]
                $reason = 'version_below_minimum'
                $matchesRequest = $RequestedVersion -notmatch '^\d+\.\d+\.\d+$' -or $version -eq $RequestedVersion
                if (-not $matchesRequest) { $reason = 'configured_version_mismatch' }
                if ([version]$version -ge $Minimum -and $matchesRequest) {
                    return New-Check "tool.$Name" 'ready' 'usable' @{
                        path = $candidate.path; source = $candidate.source; version = $version
                        minimum = $Minimum.ToString(); requested_version = $RequestedVersion; rejected = $attempts
                    }
                }
            } else { $reason = 'unrecognized_version' }
        }
        $attempts += @{ path = $candidate.path; source = $candidate.source; reason = $reason; version = $version }
    }
    $status = if ($candidates.Count) { 'invalid' } else { 'missing' }
    return New-Check "tool.$Name" $status 'no_usable_candidate' @{
        minimum = $Minimum.ToString(); requested_version = $RequestedVersion; rejected = $attempts
    }
}
