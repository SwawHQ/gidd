using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class Tool {
    public static int Main(string[] args) {
        string exe = Assembly.GetExecutingAssembly().Location;
        string log = Environment.GetEnvironmentVariable("GIDD_TEST_PROBE_LOG");
        if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, exe + Environment.NewLine);
        string name = Path.GetFileNameWithoutExtension(exe);
        string mode = File.Exists(exe + ".mode") ? File.ReadAllText(exe + ".mode") :
            name == "node" ? "v24.19.0" : name == "gh" ? "gh version 2.98.0 (test)" : name == "git" ? "git version 2.55.0.windows.5" : "1.4.2";
        if (mode == "hang") { Thread.Sleep(30000); return 91; }
        if (mode == "fail") { Console.Error.WriteLine("private-test-secret"); return 9; }
        if (name == "gh" && args.Length > 0 && args[0] == "--test-git") {
            foreach (string arg in args) Console.WriteLine(arg);
            Console.WriteLine("GIT_EXEC_PATH=" + Environment.GetEnvironmentVariable("GIT_EXEC_PATH"));
            Console.WriteLine(Console.In.ReadToEnd());
            var start = new System.Diagnostics.ProcessStartInfo("git.exe", "--version");
            start.UseShellExecute = false;
            using (var child = System.Diagnostics.Process.Start(start)) {
                child.WaitForExit();
                return child.ExitCode == 0 ? 23 : child.ExitCode;
            }
        }
        if (args.Length != 1 || args[0] != "--version") return 90;
        Console.WriteLine(mode);
        return 0;
    }
}
