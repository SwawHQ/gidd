function Get-GiddRuntimeRequirements {
    $requirements = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../../assets/runtime-requirements.json')) | ConvertFrom-Json
    if ($requirements.schema -ne 'gidd.runtime-requirements/v1') { throw 'invalid_runtime_requirements' }
    foreach ($name in @('bun','node')) {
        if ($requirements.minimum.$name -notmatch '^\d+\.\d+\.\d+$') { throw 'invalid_runtime_requirements' }
    }
    return $requirements.minimum
}

function Find-GiddBootstrapRuntime {
    param($Storage, $Minimum, [switch]$IgnorePins)
    $order = if ($Storage.bootstrap.runtime -eq 'node') { @('node','bun') } else { @('bun','node') }
    foreach ($source in @('managed','path')) {
        foreach ($name in $order) {
            $pattern = if ($name -eq 'bun') { '^(\d+\.\d+\.\d+)$' } else { '^v(\d+\.\d+\.\d+)$' }
            $requested = if ($IgnorePins) { '' } else { $Storage.tools[$name].version }
            $candidate = Find-Tool $name ([version]$Minimum.$name) $pattern (Join-Path $Storage.tools_root "$name/$name.exe") $requested -Source $source
            if ($candidate.status -eq 'ready') { return $candidate }
        }
    }
    return $null
}

function Resolve-GiddBootstrapRuntime {
    param($Storage, $Minimum, [switch]$IgnorePins)
    $candidate = Find-GiddBootstrapRuntime $storage $minimum -IgnorePins:$IgnorePins
    if (-not $candidate) {
        $lock = Open-GiddInstallLock $storage.tools_root
        try {
            # Recheck under the shared lock after a concurrent installer exits.
            $candidate = Find-GiddBootstrapRuntime $storage $minimum -IgnorePins:$IgnorePins
            if (-not $candidate) {
                $name = $storage.bootstrap.runtime
                if (Test-Path -LiteralPath (Join-Path $storage.tools_root $name)) { throw "occupied_or_version_conflicting_target:$name" }
                if ($storage.tools[$name].version -match '^\d+\.\d+\.\d+$' -and [version]$storage.tools[$name].version -lt [version]$minimum.$name) { throw "configured_version_below_minimum:$name" }
                Write-GiddInstallationGuide $storage.tools_root
                $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../../assets/runtimes.json')) | ConvertFrom-Json
                $pinned = @($manifest.tools | Where-Object name -eq $name) | Select-Object -First 1
                $definition = Resolve-GiddRelease $name $storage.tools[$name] $pinned
                if ([version]$definition.version -lt [version]$minimum.$name) { throw "configured_version_below_minimum:$name" }
                [void](Install-GiddTool $storage.tools_root $definition { param($phase) [Console]::Error.WriteLine("GIDD bootstrap: $phase") })
                $candidate = Find-GiddBootstrapRuntime $storage $minimum -IgnorePins:$IgnorePins
                if (-not $candidate) { throw 'bootstrap_runtime_unusable' }
            }
        } finally { $lock.Dispose() }
    }
    return $candidate
}

function Start-GiddJavaScript {
    param([string]$RepositoryPath, [object[]]$Arguments, [switch]$IgnorePins)
    foreach ($file in @('_process.ps1','_managed.ps1','_tools.ps1','_configuration.ps1')) { . (Join-Path $PSScriptRoot $file) }
    foreach ($file in @('_filesystem.ps1','download.ps1','releases.ps1','install.ps1')) { . (Join-Path $PSScriptRoot "../setup-tools/$file") }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'unsupported_platform' }
    $minimum = Get-GiddRuntimeRequirements
    $root = if ($RepositoryPath) { Get-GiddRepositoryRoot $RepositoryPath } else { $null }
    $storage = Resolve-GiddToolStorage $root
    $candidate = Resolve-GiddBootstrapRuntime $storage $minimum -IgnorePins:$IgnorePins
    # Encoding preserves empty strings, quotes and trailing slashes across PS 5.1.
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($Arguments) -Compress)))
    & $candidate.details.path (Join-Path $PSScriptRoot '../../gidd.mjs') '--encoded-arguments' $encoded
    exit $LASTEXITCODE
}
