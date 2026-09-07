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
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -match '(^[/\\]|:|(^|[/\\])\.\.([/\\]|$))') { throw 'unsafe_zip_entry' }
            if ($entry.Length -gt 256MB) { throw 'zip_entry_too_large' }
        }
        foreach ($file in $Definition.files) {
            if ($file.name -notmatch '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$') { throw 'invalid_payload_name' }
            $matches = @($zip.Entries | Where-Object { $_.FullName -ceq $file.entry })
            if ($matches.Count -ne 1 -or $matches[0].Length -eq 0) { throw 'missing_or_duplicate_payload' }
            $target = Join-Path $Destination $file.name
            Assert-GiddPlainPath $target
            $inputStream = $matches[0].Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($output); $output.Flush($true) }
            finally { $inputStream.Dispose(); $output.Dispose() }
        }
    } finally { $zip.Dispose() }
}
