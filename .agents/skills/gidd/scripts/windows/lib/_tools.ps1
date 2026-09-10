function New-Check {
    param([string]$Id, [string]$Status, [string]$Reason, [hashtable]$Details = @{})
    return [ordered]@{ id = $Id; status = $Status; reason = $Reason; details = $Details }
}

function Find-Tool {
    param([string]$Name, [version]$Minimum, [string]$Pattern, [string]$ManagedPath, [string]$RequestedVersion = '', [ValidateSet('auto','managed','path')][string]$Source = 'auto', [switch]$CheckCompatibility)
    $managedFullPath = if ($ManagedPath) { [IO.Path]::GetFullPath($ManagedPath) } else { '' }
    $candidates = @()
    if ($Source -ne 'path' -and $ManagedPath -and (Test-Path -LiteralPath $ManagedPath)) {
        $candidates += @{ path = $ManagedPath; source = 'managed' }
    }
    if ($Source -ne 'managed') {
        foreach ($command in @(Get-Command "$Name.exe" -CommandType Application -All -ErrorAction SilentlyContinue)) {
            $candidates += @{ path = $command.Source; source = 'path' }
        }
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
        if ($CheckCompatibility) {
            $result = Invoke-GiddRuntimeCompatibility $candidate.path $Name
            if ($result.status -eq 'compatible') {
                return New-Check "tool.$Name" 'ready' 'compatible' @{
                    path = $candidate.path; source = $candidate.source; version = $result.version
                    minimum = $result.minimum; rejected = $attempts
                }
            }
            $attempts += @{ path=$candidate.path; source=$candidate.source; reason='runtime_incompatible'; version=$null }
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

function Invoke-GiddRuntimeCompatibility {
    param([string]$Executable, [string]$Name)
    $probe = Invoke-GiddProcess $Executable @((Join-Path $PSScriptRoot '../../runtime-compat.mjs')) -TimeoutSeconds 10
    if ($probe.ok) {
        try {
            $report = $probe.text | ConvertFrom-Json
            if ($report.schema -eq 'gidd.runtime-compat/v1' -and $report.status -eq 'compatible' -and
                $report.name -eq $Name -and $report.version -match '^\d+\.\d+\.\d+$') { return $report }
        } catch { }
    }
    return @{ status='incompatible' }
}
