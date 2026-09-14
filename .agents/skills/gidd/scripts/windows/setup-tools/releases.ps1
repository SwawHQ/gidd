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
    if ($Name -eq 'git') { return Resolve-GiddGitRelease $ReadText }
    if ($Name -notin @('node','bun','gh')) { throw 'invalid_tool_name' }
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
        $repo = if ($Name -eq 'bun') { 'oven-sh/bun' } else { 'cli/cli' }
        $tag = if ($Name -eq 'bun') { "bun-v$version" } else { "v$version" }
        if ($version -eq 'latest') {
            $releaseUrl = "https://api.github.com/repos/$repo/releases/latest"
            $metadata += $releaseUrl
            $release = (& $ReadText $releaseUrl) | ConvertFrom-Json
            $pattern = if ($Name -eq 'bun') { '^bun-v(\d+\.\d+\.\d+)$' } else { '^v(\d+\.\d+\.\d+)$' }
            if (($release.PSObject.Properties['draft'] -and $release.draft) -or ($release.PSObject.Properties['prerelease'] -and $release.prerelease) -or $release.tag_name -cnotmatch $pattern) { throw "invalid_stable_release:$Name" }
            $version = $Matches[1]; $tag = $release.tag_name
        }
        $archive = if ($Name -eq 'bun') { 'bun-windows-x64.zip' } else { "gh_${version}_windows_amd64.zip" }
        $checksumFile = if ($Name -eq 'bun') { 'SHASUMS256.txt' } else { "gh_${version}_checksums.txt" }
        $checksumUrl = "https://github.com/$repo/releases/download/$tag/$checksumFile"
        $metadata += $checksumUrl
        $hash = Get-GiddChecksum (& $ReadText $checksumUrl) $archive
        $url = "$source/download/$tag/$archive"
        $supplements = @()
        $files = @(@{entry='bin/gh.exe';name='gh.exe'}, @{entry='LICENSE';name='LICENSE'})
        if ($Name -eq 'bun') {
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
    }
    return [pscustomobject]@{name=$Name;version=$version;archive=$archive;url=$url;sha256=$hash;files=$files;supplements=$supplements;metadata_sources=$metadata}
}

function Resolve-GiddGitRelease {
    param([scriptblock]$ReadText = { param($url) Read-GiddReleaseText $url })
    $metadata = 'https://api.github.com/repos/git-for-windows/git/releases/latest'
    $release = (& $ReadText $metadata) | ConvertFrom-Json
    if (($release.PSObject.Properties['draft'] -and $release.draft) -or ($release.PSObject.Properties['prerelease'] -and $release.prerelease) -or
        $release.tag_name -cnotmatch '^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.windows\.([1-9]\d*)$') { throw 'invalid_stable_release:git' }
    $version = $Matches[1]; $revision = $Matches[2]
    $suffix = if ($revision -eq '1') { '' } else { ".$revision" }
    $archive = "MinGit-$version$suffix-64-bit.zip"
    $url = "https://github.com/git-for-windows/git/releases/download/$($release.tag_name)/$archive"
    $assets = @($release.assets | Where-Object name -CEQ $archive)
    if ($assets.Count -ne 1 -or $assets[0].browser_download_url -cne $url -or $assets[0].digest -cnotmatch '^sha256:[a-f0-9]{64}$' -or
        $assets[0].size -le 0 -or $assets[0].size -gt 256MB -or $assets[0].size -ne [Math]::Truncate($assets[0].size)) { throw 'git_release_asset_or_checksum_missing' }
    return [pscustomobject]@{name='git';version=$version;archive=$archive;url=$url;sha256=$assets[0].digest.Substring(7);
        reported_version="$version.windows.$revision";release_tag=$release.tag_name;metadata_sources=@($metadata);supplements=@()}
}
