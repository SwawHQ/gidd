using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// Installed-entry tests use real Git and isolated bare repositories. Redirect
// only transport arguments so remote identity checks keep their native meaning.
public static class TransportGit {
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--version") {
            Console.WriteLine("git version 2.55.0.windows.5"); return 0;
        }
        var forwarded = new List<string>();
        if (Array.IndexOf(args, "ls-remote") >= 0 || Array.IndexOf(args, "fetch") >= 0 || Array.IndexOf(args, "push") >= 0) {
            forwarded.Add("-c");
            forwarded.Add("url." + Environment.GetEnvironmentVariable("GIDD_TEST_REMOTE").Replace('\\', '/') +
                ".insteadOf=https://github.com/test/repo");
        }
        forwarded.AddRange(args);
        var command = new StringBuilder();
        foreach (string arg in forwarded) command.Append(Quote(arg)).Append(' ');
        string git = Environment.GetEnvironmentVariable("GIDD_TEST_GIT");
        var start = new ProcessStartInfo(git, command.ToString());
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.EnvironmentVariables["PATH"] = Path.GetDirectoryName(git) + ";" + start.EnvironmentVariables["PATH"];
        start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        using (var child = Process.Start(start)) {
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
        }
    }
}
