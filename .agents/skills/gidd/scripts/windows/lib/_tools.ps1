function New-Check {
    param([string]$Id, [string]$Status, [string]$Reason, [hashtable]$Details = @{})
    return [ordered]@{ id = $Id; status = $Status; reason = $Reason; details = $Details }
}

function Find-Tool {
    param([string]$Name, [version]$Minimum, [string]$Pattern, [string]$ManagedPath, [string]$RequestedVersion = '', [ValidateSet('auto','managed','path')][string]$Source = 'auto', [switch]$CheckCompatibility, [string[]]$ExtraPaths = @())
    $managedFullPath = if ($ManagedPath) { [IO.Path]::GetFullPath($ManagedPath) } else { '' }
    $managedRoot = if ($ManagedPath) { [IO.Path]::GetDirectoryName($managedFullPath) } else { '' }
    if ($Name -eq 'git' -and $managedRoot) { $managedRoot = [IO.Path]::GetDirectoryName($managedRoot) }
    $candidates = @()
    if ($Source -ne 'path' -and $ManagedPath -and (Test-Path -LiteralPath $ManagedPath)) {
        $candidates += @{ path = $ManagedPath; source = 'managed' }
    }
    if ($Source -ne 'managed') {
        foreach ($path in $ExtraPaths) { if ([IO.File]::Exists($path)) { $candidates += @{path=$path;source='path'} } }
        foreach ($command in @(Get-Command "$Name.exe" -CommandType Application -All -ErrorAction SilentlyContinue)) {
            $candidates += @{ path = $command.Source; source = 'path' }
        }
    }
    $attempts = @()
    foreach ($candidate in $candidates) {
        $isManaged = $candidate.source -eq 'managed' -or ($managedFullPath -and
            ([string]::Equals([IO.Path]::GetFullPath($candidate.path), $managedFullPath, [StringComparison]::OrdinalIgnoreCase) -or
            ($Name -eq 'git' -and [IO.Path]::GetFullPath($candidate.path).StartsWith($managedRoot + '\',[StringComparison]::OrdinalIgnoreCase))))
        if ($isManaged -and
            -not (Test-GiddManagedTool $managedRoot $Name)) {
            $attempts += @{ path = $candidate.path; source = $candidate.source; reason = 'managed_integrity_failed'; version = $null }
            continue
        }
        if ($isManaged) { $candidate.path = $managedFullPath; $candidate.source = 'managed' }
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
    param([string]$Executable, [ValidateSet('bun','node')][string]$Name)
    $policy = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../runtime-policy.json')) | ConvertFrom-Json
    if ($policy.schema -ne 'gidd.runtime-policy/v1') { throw 'invalid_runtime_policy' }
    $minimum = $policy.minimums.$Name
    if ($minimum -cnotmatch '^\d+\.\d+\.\d+$') { throw 'invalid_runtime_policy' }
    $probe = Invoke-GiddProcess $Executable @('--version') -TimeoutSeconds 10
    $pattern = if ($Name -eq 'node') { '^v(\d+\.\d+\.\d+)$' } else { '^(\d+\.\d+\.\d+)$' }
    $version = ''; $compatible = $false
    if ($probe.ok -and $probe.text -cmatch $pattern) {
        $version = $Matches[1]; $parsed = $null
        $compatible = [version]::TryParse($version,[ref]$parsed) -and $parsed -ge [version]$minimum
    }
    return @{schema='gidd.runtime-compat/v1';status=$(if ($compatible) {'compatible'} else {'incompatible'});
        name=$Name;version=$version;minimum=$minimum}
}
