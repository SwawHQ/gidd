# Public output is a summary of the final state, not a dump of discovery probes.
function Get-GiddToolFailure {
    param($Check)
    $details = [ordered]@{code=$Check.reason}
    $facts = if ($Check.details) { $Check.details } else { @{} }
    foreach ($key in @('http_status','retry_at')) {
        if ($facts.ContainsKey($key)) { $details[$key] = $facts[$key] }
    }
    if ($facts['rejected'] -and $facts['rejected'].Count) {
        if ($facts['minimum']) { $details.minimum = $facts['minimum'] }
        $details.candidates = @($facts['rejected'] | ForEach-Object {
            $item = [ordered]@{path=$_.path;code=$_.reason}
            if ($_.version) { $item.version = $_.version }
            $item
        })
    }
    return $details
}

function Convert-GiddRuntimeReport {
    param($Report, [string]$Tool = '')
    $candidate = $Report.runtime
    $name = if ($candidate) { $candidate.id.Substring(5) } else { $Tool }
    $row = [ordered]@{name=$name;status=$Report.status}
    if ($candidate) {
        $row.version = $candidate.details.version
        $row.path = $candidate.details.path
    }
    $row.launcher = $Report.launcher
    if ($Report.status -eq 'ready') {
        if (-not $Report.read_only) { $row.action = $Report.runtime_action }
        if ($Report['cleanup_pending']) {
            $row.details = [ordered]@{code='installation_cleanup_pending';path=(Join-Path ([IO.Path]::GetDirectoryName($Report.launcher)) '.cache')}
        }
    } elseif ($candidate) {
        $row.status = 'invalid'
        $row.details = [ordered]@{code='bootstrap_required'}
    } else {
        $rejected = @($Report.attempts | Where-Object { $_.details['rejected'] -and $_.details['rejected'].Count })
        $row.status = if ($rejected.Count) { 'invalid' } else { 'missing' }
        $row.details = [ordered]@{code='no_usable_candidate'}
        if ($rejected.Count) {
            $check = @{reason='no_usable_candidate';details=@{
                minimum=$rejected[0].details.minimum
                rejected=@($rejected | ForEach-Object { $_.details.rejected })
            }}
            $row.details = Get-GiddToolFailure $check
        }
    }
    return $row
}

function Convert-GiddNativeReport {
    param($Report, [string[]]$Names)
    foreach ($name in $Names) {
        $checks = @($Report.checks | Where-Object { $_.id -in @("tool.$name","binding.$name","recovery.$name") })
        $candidate = @($checks | Where-Object { $_.id -eq "tool.$name" -and $_.details['path'] }) | Select-Object -Last 1
        $failures = @($checks | Where-Object status -NE 'ready')
        $row = [ordered]@{name=$name;status='ready'}
        if ($candidate) {
            $row.version = $candidate.details.version
            $row.path = $candidate.details.path
        }
        $row.launcher = Join-Path $Report.tools_root "$name.link.cmd"
        $action = @($Report.tools | Where-Object name -EQ $name) | Select-Object -Last 1
        if (-not $Report.read_only -and $action) { $row.action = $action.action }
        if ($failures.Count) {
            # A failed discovery is more useful than the consequent missing binding.
            $failure = @($failures | Where-Object id -NE "recovery.$name") | Select-Object -First 1
            if (-not $failure) { $failure = $failures[0] }
            $row.status = $failure.status
            $row.details = Get-GiddToolFailure $failure
            $recovery = @($failures | Where-Object id -EQ "recovery.$name") | Select-Object -Last 1
            if ($recovery -and $recovery -ne $failure) { $row.details.recovery = Get-GiddToolFailure $recovery }
        }
        $row
    }
}

function New-GiddToolsReport {
    param([object[]]$Tools, [string]$ErrorCode = '', [hashtable]$ErrorDetails = @{})
    $status = if ($ErrorCode) { 'error' } elseif (@($Tools | Where-Object status -NE 'ready').Count) { 'needs_tools' } else { 'ready' }
    $report = [ordered]@{schema='gidd.tools/v1';status=$status;tools=@($Tools)}
    if ($ErrorCode) { $report.details = Get-GiddToolFailure @{reason=$ErrorCode;details=$ErrorDetails} }
    return $report
}
