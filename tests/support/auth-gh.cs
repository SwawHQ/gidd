using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class AuthGh {
    public static int Main(string[] args) {
        string exe = Assembly.GetExecutingAssembly().Location;
        string mode = File.ReadAllText(exe + ".mode");
        if (args.Length == 1 && args[0] == "--version") {
            Console.WriteLine(mode == "old" ? "gh version 2.97.0" : "gh version 2.98.0"); return 0;
        }
        if (args.Length == 5 && args[0] == "repo" && args[1] == "view") {
            Console.WriteLine("{\"url\":\"" + args[2] + "\"}"); return 0;
        }
        if (args.Length > 1 && args[0] == "auth" && args[1] == "token") {
            if (File.Exists(exe + ".hostname") && (args.Length != 6 || args[2] != "--hostname" || args[3] != File.ReadAllText(exe + ".hostname") || args[4] != "--user" || args[5] != File.ReadAllText(exe + ".account"))) return 96;
            if (mode.StartsWith("existing") || File.Exists(exe + ".logged")) { Console.WriteLine("fixture-token"); return 0; }
            return 1;
        }
        if (args[0] == "api") {
            if (File.Exists(exe + ".hostname") && (args.Length < 3 || args[1] != "--hostname" || args[2] != File.ReadAllText(exe + ".hostname"))) return 97;
            if (mode == "existing") { Console.WriteLine("Octocat"); return 0; }
            if (mode == "existing-mismatch") { Console.WriteLine("OtherAccount"); return 0; }
            if (!File.Exists(exe + ".logged") || mode == "verify-fail") { Console.Error.WriteLine("ghp_PRIVATE_TOKEN"); return 1; }
            Console.WriteLine(mode == "mismatch" ? "OtherAccount" : "Octocat"); return 0;
        }
        if (String.Join(" ", args) != "auth login --hostname github.com --web --skip-ssh-key --clipboard=false") return 93;
        File.WriteAllText(exe + ".started", "started");
        if (!Console.IsInputRedirected || !Console.IsOutputRedirected || Environment.GetEnvironmentVariable("GH_PROMPT_DISABLED") != "1") return 94;
        if (Console.ReadLine() != null) return 95;
        if (mode != "no-challenge") {
            Console.Error.Write("! First copy your one-time co"); Console.Error.Flush(); Thread.Sleep(20);
            Console.Error.WriteLine("de: ABCD-EFGH");
            Console.Error.WriteLine("Open this URL to continue in your web browser: " +
                (mode == "bad-url" ? "https://github.com/login/oauth/authorize?secret=PRIVATE_TOKEN" : "https://github.com/login/device"));
            Console.Error.Flush();
        }
        if (mode == "hang" || mode == "bad-url") { Thread.Sleep(10000); return 92; }
        if (mode == "failure") { Console.WriteLine("PRIVATE_TOKEN"); Console.Error.WriteLine("ghp_PRIVATE_TOKEN"); return 1; }
        File.WriteAllText(exe + ".logged", "logged");
        if (mode == "plaintext") Console.Error.WriteLine("! Authentication credentials saved in plain text");
        return 0;
    }
}
