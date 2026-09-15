function Receive-GiddFile {
    param([string]$Url, [string]$Destination, [string]$ExpectedHash)
    if ($ExpectedHash -notmatch '^[a-f0-9]{64}$') { throw 'invalid_expected_hash' }
    if (([uri]$Url).Scheme -ne 'https') { throw 'https_required' }
    Assert-GiddPlainPath $Destination
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $inputStream = $null; $response = $null
    try {
        $download = Open-GiddDownload $Url
        $response = $download.response
        $inputStream = $download.stream
        $buffer = New-Object byte[] 65536
        $total = 0L
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $count
            if ($total -gt 256MB) { throw 'download_too_large' }
            $output.Write($buffer, 0, $count)
        }
        $output.Flush($true)
    } finally {
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $output.Dispose()
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'download_hash_mismatch' }
}

function Open-GiddDownload {
    param([string]$Url)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
    $request.UserAgent = 'GIDD-bootstrap'
    $response = $request.GetResponse()
    try {
        if ($response.ResponseUri.Scheme -ne 'https') { throw 'https_redirect_required' }
        return @{ response=$response; stream=$response.GetResponseStream() }
    } catch { $response.Dispose(); throw }
}

function Expand-GiddPayload {
    param([string]$Archive, [string]$Destination, $Definition)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $nested = $Definition.name -eq 'git'; $names = @{}; $total = 0L
        if ($zip.Entries.Count -gt 10000) { throw 'too_many_payload_files' }
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -match '(^[/\\]|:|(^|[/\\])\.\.([/\\]|$))') { throw 'unsafe_zip_entry' }
            if ($entry.Length -gt 256MB) { throw 'zip_entry_too_large' }
            if ($nested) {
                $clean = $entry.FullName.TrimEnd('/')
                if (-not (Test-GiddPayloadName $clean) -or $names.ContainsKey($clean)) { throw 'unsafe_zip_entry' }
                $names[$clean] = $true
                $type = ($entry.ExternalAttributes -shr 16) -band 0xf000
                if ($type -notin @(0,0x4000,0x8000) -or ($type -eq 0x4000 -and -not $entry.FullName.EndsWith('/'))) { throw 'unsupported_zip_entry_type' }
                $total += $entry.Length
                if ($total -gt 512MB) { throw 'zip_payload_too_large' }
            }
        }
        $files = if ($nested) { @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { @{entry=$_.FullName;name=$_.FullName} }) } else { $Definition.files }
        if ($nested) {
            foreach ($required in @('cmd/git.exe','mingw64/bin/git.exe','LICENSE.txt')) {
                $found = @($zip.Entries | Where-Object { $_.FullName -ceq $required -and $_.Length -gt 0 })
                if ($found.Count -ne 1) { throw 'missing_git_payload' }
            }
        }
        foreach ($file in $files) {
            if (-not (Test-GiddPayloadName $file.name) -or (-not $nested -and $file.name.Contains('/'))) { throw 'invalid_payload_name' }
            $matches = @($zip.Entries | Where-Object { $_.FullName -ceq $file.entry })
            if ($matches.Count -ne 1 -or (-not $nested -and $matches[0].Length -eq 0)) { throw 'missing_or_duplicate_payload' }
            $target = Join-Path $Destination $file.name
            Assert-GiddPlainPath $target
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $inputStream = $matches[0].Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($output); $output.Flush($true) }
            finally { $inputStream.Dispose(); $output.Dispose() }
        }
    } finally { $zip.Dispose() }
}
