using System;
using System.IO;
using System.Text;
using System.Diagnostics;
public static class WrapperGh {
    static string Env(string key) { return Environment.GetEnvironmentVariable(key) ?? ""; }
    static void Emit(string key, string value) { Console.WriteLine(key + "=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value))); }
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("gh version 2.100.0"); return 0; }
        if (args.Length > 1 && args[0] == "auth" && args[1] == "token") {
            // Token selection must ignore all inherited authentication tokens.
            foreach (string key in new[] {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"})
                if (Env(key) != "") return 96;
            string user = args[args.Length - 1];
            if (user == "missing") { Console.Error.WriteLine("PRIVATE_TOKEN"); return 1; }
            Console.WriteLine("fixture-" + (user == "mismatch" ? "other" : user)); return 0;
        }
        string token = Env("GH_TOKEN") + Env("GH_ENTERPRISE_TOKEN");
        if (args.Length > 0 && args[0] == "api" && Array.IndexOf(args, "user") >= 0) {
            if (!token.StartsWith("fixture-")) return 97;
            Console.WriteLine(token.Substring(8)); return 0;
        }
        if (args.Length > 1 && args[0] == "auth" && args[1] == "git-credential") {
            Console.In.ReadToEnd();
            Console.WriteLine("username=x-access-token\npassword=" + token + "\n"); return 0;
        }
        if (args.Length > 0 && args[0] == "child-git") {
            var start = new ProcessStartInfo("git.exe", "config --get user.name");
            start.UseShellExecute = false;
            using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        }
        foreach (string arg in args) Emit("arg", arg);
        Emit("cwd", Environment.CurrentDirectory);
        Emit("host", Env("GH_HOST")); Emit("repo", Env("GH_REPO"));
        Emit("account", token.StartsWith("fixture-") ? token.Substring(8) : "");
        Emit("input", Console.In.ReadToEnd());
        Console.Error.Write("native stderr\n");
        return 23;
    }
}
