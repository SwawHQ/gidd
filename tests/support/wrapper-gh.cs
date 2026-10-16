using System;
using System.IO;
using System.Text;
public static class WrapperGh {
    static string Env(string key) { return Environment.GetEnvironmentVariable(key) ?? ""; }
    static void Emit(string key, string value) { Console.WriteLine(key + "=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value))); }
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("gh version 2.100.0"); return 0; }
        if (args.Length == 3 && args[0] == "lock-file") {
            using (var file = File.Open(args[1], FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                File.WriteAllText(args[2], "locked"); Console.ReadLine();
            }
            return 0;
        }
        if (Env("GIDD_AUTH_LOGIN") != "" && args.Length > 1) {
            string profile = Path.Combine(Env("GH_CONFIG_DIR"), "hosts.yml");
            if (args[0] == "auth" && args[1] == "login") {
                if (Env("GH_PROMPT_DISABLED") != "1" || Env("GH_TOKEN") != "" || Env("GITHUB_TOKEN") != "") return 96;
                Directory.CreateDirectory(Path.GetDirectoryName(profile));
                File.WriteAllText(profile, Env("GIDD_AUTH_LOGIN"));
                Console.WriteLine("fixture browser login progress"); return 0;
            }
            if (args[0] == "config" && args[1] == "get") {
                if (!File.Exists(profile)) return 1;
                Console.WriteLine(File.ReadAllText(profile)); return 0;
            }
        }
        if (args.Length > 1 && args[0] == "config" && args[1] == "get") { Console.WriteLine("Octocat"); return 0; }
        if (args.Length > 1 && args[0] == "auth" && args[1] == "token") {
            // Token selection must ignore all inherited authentication tokens.
            foreach (string key in new[] {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"})
                if (Env(key) != "") return 96;
            int userFlag = Array.IndexOf(args, "--user");
            string user = userFlag >= 0 ? args[userFlag + 1] : "Octocat";
            Console.WriteLine("fixture-" + user); return 0;
        }
        string token = Env("GH_TOKEN") + Env("GH_ENTERPRISE_TOKEN");
        if (args.Length > 0 && args[0] == "api" && Array.IndexOf(args, "user") >= 0) {
            if (!token.StartsWith("fixture-")) return 97;
            Console.WriteLine(token.Substring(8)); return 0;
        }
        if (args.Length > 0 && args[0] == "api" && args[args.Length - 1].Contains("/issues/") && Env("GIDD_ISSUE_FIXTURE") != "") {
            Console.Write(File.ReadAllText(Env("GIDD_ISSUE_FIXTURE"))); return 0;
        }
        if (args.Length > 0 && args[0] == "api" && args[args.Length - 1].EndsWith("/issues") &&
                Array.IndexOf(args, "POST") >= 0 && Env("GIDD_ISSUE_FIXTURE") != "") {
            if (Array.IndexOf(args, "--input") < 0) return 98;
            File.WriteAllText(Env("GIDD_ISSUE_INPUT"), Console.In.ReadToEnd(), new UTF8Encoding(false));
            Console.Write(File.ReadAllText(Env("GIDD_ISSUE_FIXTURE"))); return 0;
        }
        if (args.Length > 0 && args[0] == "--test-profile") {
            foreach (string key in new[] {"GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_PROMPT_DISABLED", "GH_EDITOR"})
                Emit(key, Env(key));
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
