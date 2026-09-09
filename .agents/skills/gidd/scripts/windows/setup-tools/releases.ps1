function Read-GiddReleaseText {
    param([string]$Url)
    if (([uri]$Url).Scheme -ne 'https') { throw 'https_required' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
    $request.UserAgent = 'GIDD-bootstrap'
    $response = $null; $stream = $null
    $buffer = New-Object IO.MemoryStream
    try {
        $response = $request.GetResponse()
        if ($response.ResponseUri.Scheme -ne 'https') { throw 'https_redirect_required' }
        $stream = $response.GetResponseStream()
        $bytes = New-Object byte[] 65536
        while (($count = $stream.Read($bytes,0,$bytes.Length)) -gt 0) {
            if ($buffer.Length + $count -gt 4MB) { throw 'release_metadata_too_large' }
            $buffer.Write($bytes,0,$count)
        }
        $utf8 = New-Object Text.UTF8Encoding($false,$true)
        return $utf8.GetString($buffer.ToArray())
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
        $buffer.Dispose()
    }
}

function Get-GiddChecksum {
    param([string]$Text, [string]$Archive)
    $hashes = @()
    foreach ($line in ($Text -split "`n")) {
        if ($line.TrimEnd("`r") -match '^([a-fA-F0-9]{64})[ \t]+\*?(.+)$' -and $Matches[2] -ceq $Archive) {
            $hashes += $Matches[1].ToLowerInvariant()
        }
    }
    if ($hashes.Count -ne 1) { throw "missing_or_duplicate_release_checksum:$Archive" }
    return $hashes[0]
}

function Resolve-GiddRelease {
    param([string]$Name, $Settings, $PinnedDefinition = $null,
        [scriptblock]$ReadText = { param($url) Read-GiddReleaseText $url })
    if ($Name -notin @('node','bun')) { throw 'invalid_tool_name' }
    Assert-GiddToolSettings $Name $Settings
    $version = $Settings.version
    $source = $Settings.source
    # Bundled exact versions retain independently verified hashes.
    if ($PinnedDefinition -and $version -eq $PinnedDefinition.version) {
        $definition = $PinnedDefinition | ConvertTo-Json -Depth 10 | ConvertFrom-Json
        $tag = if ($Name -eq 'bun') { "bun-v$version" } else { "v$version" }
        $definition.url = if ($Name -eq 'node') { "$source/$tag/$($definition.archive)" }
            else { "$source/download/$tag/$($definition.archive)" }
        return $definition
    }
    $metadata = @()
    if ($Name -eq 'node') {
        if ($version -in @('latest','lts')) {
            $indexUrl = 'https://nodejs.org/dist/index.json'
            $metadata += $indexUrl
            $index = (& $ReadText $indexUrl) | ConvertFrom-Json
            $versions = @($index | Where-Object {
                $_.version -cmatch '^v\d+\.\d+\.\d+$' -and 'win-x64-zip' -in $_.files -and
                ($version -eq 'latest' -or ($_.lts -is [string] -and $_.lts))
            } | Sort-Object { [version]$_.version.Substring(1) } -Descending)
            if (-not $versions.Count) { throw 'node_release_unavailable' }
            $version = $versions[0].version.Substring(1)
        }
        $archive = "node-v$version-win-x64.zip"
        $checksumUrl = "https://nodejs.org/dist/v$version/SHASUMS256.txt"
        $metadata += $checksumUrl
        $hash = Get-GiddChecksum (& $ReadText $checksumUrl) $archive
        $files = @(@{entry="node-v$version-win-x64/node.exe";name='node.exe'}, @{entry="node-v$version-win-x64/LICENSE";name='LICENSE'})
        $url = "$source/v$version/$archive"
        $supplements = @()
    } else {
        $repo = 'oven-sh/bun'
        $tag = "bun-v$version"
        if ($version -eq 'latest') {
            $releaseUrl = "https://api.github.com/repos/$repo/releases/latest"
            $metadata += $releaseUrl
            $release = (& $ReadText $releaseUrl) | ConvertFrom-Json
            $pattern = '^bun-v(\d+\.\d+\.\d+)$'
            if ($release.draft -or $release.prerelease -or $release.tag_name -cnotmatch $pattern) { throw "invalid_stable_release:$Name" }
            $version = $Matches[1]; $tag = $release.tag_name
        }
        $archive = 'bun-windows-x64.zip'
        $checksumFile = 'SHASUMS256.txt'
        $checksumUrl = "https://github.com/$repo/releases/download/$tag/$checksumFile"
        $metadata += $checksumUrl
        $hash = Get-GiddChecksum (& $ReadText $checksumUrl) $archive
        $url = "$source/download/$tag/$archive"
        $supplements = @()
        $files = @(@{entry='bun-windows-x64/bun.exe';name='bun.exe'})
        $licenseUrl = "https://raw.githubusercontent.com/oven-sh/bun/$tag/LICENSE.md"
        $metadata += $licenseUrl
        $license = & $ReadText $licenseUrl
        if ([string]::IsNullOrWhiteSpace($license)) { throw 'empty_bun_license' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $licenseHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($license))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $supplements = @(@{name='LICENSE.md';url=$licenseUrl;sha256=$licenseHash})
    }
    return [pscustomobject]@{name=$Name;version=$version;archive=$archive;url=$url;sha256=$hash;files=$files;supplements=$supplements;metadata_sources=$metadata}
}
