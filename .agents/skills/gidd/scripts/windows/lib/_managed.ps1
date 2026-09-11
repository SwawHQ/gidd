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

function Test-GiddManagedTool {
    param([string]$Root, [string]$Name)
    try {
        Assert-GiddPlainPath $Root
        $recordPath = Join-Path $Root 'install.json'
        Assert-GiddPlainPath $recordPath
        if (-not [IO.File]::Exists($recordPath) -or (Get-Item -LiteralPath $recordPath).Length -gt 64KB) { return $false }
        $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json
        if ($record.schema -ne 'gidd.install/v1' -or $record.name -ne $Name -or $record.platform -ne 'windows-x64') { return $false }
        if ($record.version -notmatch '^\d+\.\d+\.\d+$' -or $record.archive_sha256 -notmatch '^[0-9a-f]{64}$') { return $false }
        $names = @()
        foreach ($file in @($record.files)) {
            if ($file.name -notmatch '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$' -or $file.name -in $names -or $file.name -eq 'install.json') { return $false }
            $names += $file.name
            $path = Join-Path $Root $file.name
            Assert-GiddPlainPath $path
            if (-not [IO.File]::Exists($path) -or (Get-Item -LiteralPath $path).Length -ne $file.length) { return $false }
            if ($file.sha256 -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) { return $false }
        }
        if ("$Name.exe" -notin $names) { return $false }
        $actual = @(Get-ChildItem -LiteralPath $Root -Force)
        if ($actual.Count -ne $names.Count + 1) { return $false }
        foreach ($item in $actual) { if ($item.Name -notin ($names + @('install.json')) -or $item.PSIsContainer) { return $false } }
        return $true
    } catch { return $false }
}
