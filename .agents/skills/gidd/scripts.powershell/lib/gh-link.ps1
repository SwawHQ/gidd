# Published beside gh.link.cmd. No JS runtime or repository initialization is needed.
$ErrorActionPreference = 'Stop'
try {
    # Keep the native argument string, including empty arguments and escaped quotes.
    # PowerShell's $args and native argument reconstruction would change it.
    $prefix = [regex]::Match([Environment]::CommandLine,
        '\A"[^"]+"\s+-NoLogo -NoProfile -ExecutionPolicy Bypass -File "[^"]+" --gidd-forward(?: |$)')
    if (-not $prefix.Success) { throw 'invalid_gh_launcher' }
    $arguments = [Environment]::CommandLine.Substring($prefix.Length)

    if (-not $env:GH_CONFIG_DIR) {
        # Git resolves the local repository, including linked worktrees and subdirectories.
        # The first porcelain record is the main worktree. Do not inspect gh arguments.
        $probe = New-Object Diagnostics.ProcessStartInfo
        $probe.FileName = $env:GIDD_GH_GIT
        $probe.Arguments = 'worktree list --porcelain -z'
        $probe.UseShellExecute = $false
        $probe.CreateNoWindow = $true
        $probe.RedirectStandardInput = $true
        $probe.RedirectStandardOutput = $true
        $probe.RedirectStandardError = $true
        $probe.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
        $git = $null
        try {
            $git = [Diagnostics.Process]::Start($probe)
            $git.StandardInput.Close()
            $output = $git.StandardOutput.ReadToEndAsync()
            $errors = $git.StandardError.ReadToEndAsync()
            if (-not $git.WaitForExit(10000)) { $git.Kill(); $git.WaitForExit() }
            if ($git.ExitCode -eq 0) {
                $first = ($output.Result -split "`0`0", 2)[0] -split "`0"
                if ($first[0].StartsWith('worktree ') -and $first -notcontains 'bare') {
                    $profile = Join-Path ($first[0].Substring(9) + '.gidd') 'gh'
                    if ([IO.Directory]::Exists($profile)) { $env:GH_CONFIG_DIR = $profile }
                }
            }
        } catch {
            # Discovery is optional. Missing Git or a non-repository cwd keeps gh defaults.
        } finally { if ($git) { $git.Dispose() } }
    }

    $native = New-Object Diagnostics.ProcessStartInfo
    $native.FileName = $env:GIDD_JS_EXEC
    $native.Arguments = $arguments
    $native.UseShellExecute = $false
    # Inherit all three handles; gh owns interaction, output and its exit status.
    $child = [Diagnostics.Process]::Start($native)
    try { $child.WaitForExit(); exit $child.ExitCode }
    finally { $child.Dispose() }
} catch {
    [Console]::Error.WriteLine('GIDD: gh_launcher_failed.')
    exit 2
}
