using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class Tool {
    public static int Main(string[] args) {
        string exe = Assembly.GetExecutingAssembly().Location;
        string log = Environment.GetEnvironmentVariable("GIDD_TEST_PROBE_LOG");
        if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, exe + Environment.NewLine);
        if (args.Length != 1 || args[0] != "--version") return 90;
        string name = Path.GetFileNameWithoutExtension(exe);
        string mode = File.Exists(exe + ".mode") ? File.ReadAllText(exe + ".mode") :
            name == "node" ? "v24.19.0" : name == "gh" ? "gh version 2.98.0 (test)" : "1.4.2";
        if (mode == "hang") { Thread.Sleep(30000); return 91; }
        if (mode == "fail") { Console.Error.WriteLine("private-test-secret"); return 9; }
        Console.WriteLine(mode);
        return 0;
    }
}
