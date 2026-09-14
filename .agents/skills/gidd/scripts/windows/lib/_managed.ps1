function Assert-GiddPlainPath {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse_path' }
        }
        $current = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
    }
}

function Get-GiddExecutableName {
    param([string]$Name)
    if ($Name -eq 'git') { return 'cmd/git.exe' }
    return "$Name.exe"
}

function Test-GiddPayloadName {
    param([string]$Name)
    if (-not $Name -or $Name.Length -gt 240) { return $false }
    foreach ($part in $Name.Split('/')) {
        if ($part -notmatch '^[a-z0-9_.+@-]+$' -or $part -in @('.','..','install.json','skill.md','config.toml','.git') -or
            $part -match '[. ]$|^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)') { return $false }
    }
    return $true
}

function Test-GiddManagedTool {
    param([string]$Root, [string]$Name, [switch]$AllowDamaged)
    try {
        Assert-GiddPlainPath $Root
        $recordPath = Join-Path $Root 'install.json'
        Assert-GiddPlainPath $recordPath
        $limit = if ($Name -eq 'git') { 4MB } else { 64KB }
        if (-not [IO.File]::Exists($recordPath) -or (Get-Item -LiteralPath $recordPath).Length -gt $limit) { return $false }
        $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json
        $schema = if ($Name -eq 'git') { 'gidd.install/v2' } else { 'gidd.install/v1' }
        if ($record.schema -ne $schema -or $record.name -ne $Name -or $record.platform -ne 'windows-x64' -or
            $record.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $record.archive_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $record.files -isnot [array] -or $record.files.Count -gt 10000) { return $false }
        $names = @{}; $directories = @{}
        foreach ($file in $record.files) {
            if (-not (Test-GiddPayloadName $file.name) -or ($Name -ne 'git' -and $file.name.Contains('/')) -or $names.ContainsKey($file.name) -or
                $file.length -lt 0 -or $file.length -ne [Math]::Truncate($file.length) -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { return $false }
            $names[$file.name] = $true
            $parent = [IO.Path]::GetDirectoryName($file.name.Replace('/','\'))
            while ($parent) { $directories[$parent.Replace('\','/')] = $true; $parent = [IO.Path]::GetDirectoryName($parent) }
            $path = Join-Path $Root $file.name; Assert-GiddPlainPath $path
            if ($AllowDamaged -and -not (Test-Path -LiteralPath $path)) { continue }
            if (-not [IO.File]::Exists($path)) { return $false }
            if (-not $AllowDamaged -and ((Get-Item -LiteralPath $path).Length -ne $file.length -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256)) { return $false }
        }
        if (-not $names.ContainsKey((Get-GiddExecutableName $Name))) { return $false }
        $canonicalRoot = (Get-Item -LiteralPath $Root -Force).FullName
        $pending = New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($canonicalRoot)
        $prefix = $canonicalRoot.TrimEnd('\') + '\'
        while ($pending.Count) {
            foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
                $relative = $item.FullName.Substring($prefix.Length).Replace('\','/')
                if ($relative -eq 'install.json' -and -not $item.PSIsContainer) { continue }
                if ($item.PSIsContainer) {
                    if (-not $directories.ContainsKey($relative)) { return $false }; $pending.Push($item.FullName)
                } elseif (-not $names.ContainsKey($relative)) { return $false }
            }
        }
        return $true
    } catch { return $false }
}
