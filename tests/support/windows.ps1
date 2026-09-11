param([string]$RequestPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$lock = $null
try {
    $request = [IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
    foreach ($file in @('lib/_process.ps1','lib/_managed.ps1','lib/_tools.ps1','lib/_configuration.ps1','setup-tools/_filesystem.ps1','setup-tools/download.ps1','setup-tools/releases.ps1','setup-tools/install.ps1')) {
        $source = Join-Path $request.codeRoot $file
        . $source
    }
    switch ($request.action) {
        'compile' {
            Add-Type -TypeDefinition ([IO.File]::ReadAllText($request.source)) -OutputAssembly $request.destination -OutputType ConsoleApplication
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
        'terminate-pipe-children' {
            foreach ($childId in $request.pids) {
                $child = Get-Process -Id $childId -ErrorAction SilentlyContinue
                if ($child -and $child.ProcessName -eq 'pipe-parent') {
                    $child.Kill(); $child.WaitForExit(); $child.Dispose()
                }
            }
        }
        'find' { Find-Tool $request.name ([version]$request.minimum) $request.pattern $request.managedPath | ConvertTo-Json -Depth 8 -Compress }
        'configuration' { Resolve-GiddToolStorage $request.repositoryRoot | ConvertTo-Json -Depth 8 -Compress }
        'bootstrap' {
            . (Join-Path $request.codeRoot 'lib/_bootstrap.ps1')
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
                return @{ response=$null; stream=[IO.File]::OpenRead([string]$property.Value) }
            }
            $yes = $request.PSObject.Properties['yes'] -and $request.yes
            $node = $request.PSObject.Properties['node'] -and $request.node
            $reinstall = $request.PSObject.Properties['reinstall'] -and $request.reinstall
            if ($request.PSObject.Properties['failPublish'] -and $request.failPublish) {
                function Write-GiddLauncher { throw 'fixture_publish_failed' }
            }
            if ($request.PSObject.Properties['failCleanup'] -and $request.failCleanup) {
                function Remove-GiddRuntimeBackup { throw 'fixture_cleanup_failed' }
            }
            Invoke-GiddBootstrap (Resolve-GiddToolStorage $request.repositoryRoot) -Yes:$yes -Node:$node -Reinstall:$reinstall | ConvertTo-Json -Depth 12 -Compress
        }
        'release' {
            $settings = @{ version=$request.version;source=$request.source }
            $pinned = if ($request.pinnedPath) { [IO.File]::ReadAllText($request.pinnedPath) | ConvertFrom-Json } else { $null }
            if ($null -eq $request.responses) {
                Resolve-GiddRelease $request.name $settings $pinned | ConvertTo-Json -Depth 10 -Compress
                break
            }
            $read = { param($url)
                $property = $request.responses.PSObject.Properties[$url]
                if (-not $property) { throw "unexpected_metadata_request:$url" }
                return [string]$property.Value
            }
            Resolve-GiddRelease $request.name $settings $pinned $read | ConvertTo-Json -Depth 10 -Compress
        }
        'validate' { Test-GiddManagedTool $request.root $request.name | ConvertTo-Json -Compress }
        'stage' { Remove-GiddStage $request.root $request.name }
        'guide' {
            $lock = Open-GiddInstallLock $request.root
            Write-GiddInstallationGuide $request.root
        }
        'legacy-lock' {
            $cache = Join-Path $request.root '.cache'
            [void][IO.Directory]::CreateDirectory($cache)
            $lock = [IO.File]::Open((Join-Path $cache 'install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            [IO.File]::WriteAllText(($RequestPath + '.locked'),'locked')
            Start-Sleep -Seconds 30
        }
        'install' {
            $definition = [IO.File]::ReadAllText($request.definitionPath) | ConvertFrom-Json
            if ($request.fixtureDirectory) {
                # Test-only transport: all copying, limits, hashes and installation
                # still use production code. Public installers always use HTTPS.
                $fixtureDownloads = @{}
                $fixtureDownloads[$definition.url] = Join-Path $request.fixtureDirectory $definition.archive
                foreach ($file in $definition.supplements) {
                    $fixtureDownloads[$file.url] = Join-Path $request.fixtureDirectory "$($definition.name)-$($definition.version)-$($file.name)"
                }
                function Open-GiddDownload {
                    param([string]$Url)
                    if (-not $fixtureDownloads.ContainsKey($Url)) { throw "unexpected_download:$Url" }
                    Assert-GiddPlainPath $fixtureDownloads[$Url]
                    return @{ response=$null; stream=[IO.File]::OpenRead($fixtureDownloads[$Url]) }
                }
            }
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
        'zip' {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            Add-Type -AssemblyName System.IO.Compression
            $zip = [IO.Compression.ZipFile]::Open($request.destination,[IO.Compression.ZipArchiveMode]::Create)
            try {
                foreach ($entry in $request.entries) {
                    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$entry.source,$entry.name)
                }
            } finally { $zip.Dispose() }
        }
        default { throw 'unknown_fixture_action' }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
