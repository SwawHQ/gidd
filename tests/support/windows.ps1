param([string]$RequestPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$lock = $null
try {
    $request = [IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
    foreach ($file in $request.modules) {
        $source = Join-Path $request.codeRoot $file
        . $source
    }
    if ($request.action -in @('prepare','bootstrap','install','release')) {
        function Read-GiddReleaseText {
            param([string]$Url)
            $property = $request.responses.PSObject.Properties[$Url]
            if (-not $property) { throw "unexpected_metadata_request:$Url" }
            return [string]$property.Value
        }
        function Open-GiddDownload {
            param([string]$Url)
            $property = $request.downloads.PSObject.Properties[$Url]
            if (-not $property) { throw "unexpected_download:$Url" }
            Assert-GiddPlainPath $property.Value
            return @{response=$null;stream=[IO.File]::OpenRead([string]$property.Value)}
        }
    }
    switch ($request.action) {
        'runtime' { Invoke-GiddRuntimeCompatibility $request.executable $request.name | ConvertTo-Json -Compress }
        'read-release' { Read-GiddReleaseText $request.url }
        'download-failure' {
            if ($request.PSObject.Properties['networkStatus']) {
                $failure = Get-GiddDownloadFailure ([Net.WebException]::new('private fixture error',
                    [IO.IOException]::new('private fixture inner error'),[Net.WebExceptionStatus]$request.networkStatus,$null))
            } else {
                $probe = [Net.HttpWebRequest]::Create($request.url)
                $probe.Proxy = $null; $probe.KeepAlive = $false
                try { $probe.GetResponse().Dispose(); throw 'expected_http_failure' }
                catch { $failure = Get-GiddDownloadFailure $_.Exception }
            }
            $native = Invoke-GiddPrepareTools (Resolve-GiddToolStorage) -Names @('gh') -ReadText { throw $failure }
            function Read-GiddReleaseText { throw $failure }
            try { [void](Invoke-GiddBootstrap (Resolve-GiddToolStorage) -Yes -Runtime bun) }
            catch { $runtime = New-GiddToolsReport @() $_.Exception.Message $_.Exception.Data['gidd_download'] }
            @{
                native = New-GiddToolsReport @(Convert-GiddNativeReport $native @('gh'))
                runtime = $runtime
            } | ConvertTo-Json -Depth 12 -Compress
        }
        'prepare' {
            $storage = Resolve-GiddToolStorage
            if ($request.PSObject.Properties['root']) { $storage.tools_root = $request.root }
            $checkOnly = $request.PSObject.Properties['checkOnly'] -and $request.checkOnly
            $force = $request.PSObject.Properties['force'] -and $request.force
            if ($request.PSObject.Properties['failRecovery'] -and $request.failRecovery) {
                function Restore-GiddInterruptedTool { throw 'fixture_recovery_failed' }
            }
            $result = Invoke-GiddPrepareTools $storage -Names $request.names -CheckOnly:$checkOnly -Force:$force -OnPhase {
                param($name,$phase)
                if ($request.PSObject.Properties['stopAt'] -and $phase -eq $request.stopAt) { [Diagnostics.Process]::GetCurrentProcess().Kill() }
            }
            if ($request.PSObject.Properties['publicReport'] -and $request.publicReport) {
                $result = New-GiddToolsReport @(Convert-GiddNativeReport $result $request.names)
            }
            $result | ConvertTo-Json -Depth 12 -Compress
            if ($result.status -ne 'ready') { exit 1 }
        }
        'extract' {
            Expand-GiddPayload $request.archivePath $request.destination ([IO.File]::ReadAllText($request.definitionPath) | ConvertFrom-Json)
        }
        'syntax' {
            foreach ($source in $request.paths) {
                $tokens=$null; $errors=$null
                [void][Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
                if ($errors.Count) { throw "Parse failed: $source $errors" }
            }
            @{ checked=@($request.paths).Count } | ConvertTo-Json -Compress
        }
        'process' {
            $timer = [Diagnostics.Stopwatch]::StartNew()
            $result = Invoke-GiddProcess $request.executable @($request.arguments) -TimeoutSeconds $request.timeout
            @{ result=$result; elapsed=$timer.Elapsed.TotalMilliseconds } | ConvertTo-Json -Depth 6 -Compress
        }
        'find' { Find-Tool $request.name ([version]$request.minimum) $request.pattern $request.managedPath | ConvertTo-Json -Depth 8 -Compress }
        'configuration' { Resolve-GiddToolStorage | ConvertTo-Json -Depth 8 -Compress }
        'bootstrap' {
            $yes = $request.PSObject.Properties['yes'] -and $request.yes
            $node = $request.PSObject.Properties['node'] -and $request.node
            $runtime = if ($request.PSObject.Properties['runtime']) { [string]$request.runtime } else { '' }
            $reinstall = $request.PSObject.Properties['reinstall'] -and $request.reinstall
            if ($request.PSObject.Properties['failPublish'] -and $request.failPublish) {
                function Write-GiddLauncher { throw 'fixture_publish_failed' }
            }
            if ($request.PSObject.Properties['failCleanup'] -and $request.failCleanup) {
                function Remove-GiddRuntimeBackup { throw 'fixture_cleanup_failed' }
            }
            $result = Invoke-GiddBootstrap (Resolve-GiddToolStorage) -Yes:$yes -Node:$node -Reinstall:$reinstall -Runtime $runtime
            if ($request.PSObject.Properties['publicReport'] -and $request.publicReport) {
                $result = New-GiddToolsReport @(Convert-GiddRuntimeReport $result $runtime)
            }
            $result | ConvertTo-Json -Depth 12 -Compress
        }
        'release' {
            $settings = @{ version=$request.version;source=$request.source }
            $pinned = if ($request.pinnedPath) { [IO.File]::ReadAllText($request.pinnedPath) | ConvertFrom-Json } else { $null }
            Resolve-GiddRelease $request.name $settings $pinned | ConvertTo-Json -Depth 10 -Compress
        }
        'validate' { Test-GiddManagedTool $request.root $request.name | ConvertTo-Json -Compress }
        'stage' { Remove-GiddStage $request.root $request.name }
        'guide' {
            $lock = Open-GiddInstallLock $request.root
            Write-GiddInstallationGuide $request.root
        }
        'install' {
            $definition = [IO.File]::ReadAllText($request.definitionPath) | ConvertFrom-Json
            $lock = Open-GiddInstallLock $request.root
            if ($request.stopAt -eq 'locked') {
                [IO.File]::WriteAllText(($RequestPath + '.locked'),'locked')
                Start-Sleep -Seconds 30
            }
            $replace = $request.PSObject.Properties['replace'] -and $request.replace
            Install-GiddTool $request.root $definition {
                param($phase)
                if ($phase -eq $request.stopAt) { [Diagnostics.Process]::GetCurrentProcess().Kill() }
            } -Replace:$replace | ConvertTo-Json -Compress
        }
        default { throw 'unknown_fixture_action' }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
