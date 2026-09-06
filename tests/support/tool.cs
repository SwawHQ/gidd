using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class Tool {
    public static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "--version") return 90;
        string exe = Assembly.GetExecutingAssembly().Location;
        string name = Path.GetFileNameWithoutExtension(exe);
        string mode = File.Exists(exe + ".mode") ? File.ReadAllText(exe + ".mode") :
            name == "node" ? "v24.0.0" : name == "gh" ? "gh version 2.98.0 (test)" : "1.2.15";
        if (mode == "hang") { Thread.Sleep(30000); return 91; }
        if (mode == "fail") { Console.Error.WriteLine("private-test-secret"); return 9; }
        Console.WriteLine(mode);
        return 0;
    }
}
