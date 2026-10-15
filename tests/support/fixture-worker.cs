using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
public static class FixtureWorker {
    public static int Main(string[] args) {
        if (args[0] == "status") return Int32.Parse(args[1]);
        if (args[0] == "child") {
            using (var stream = new FileStream(args[1], FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                File.WriteAllText(args[1] + ".locked", "locked");
                Thread.Sleep(60000);
            }
            return 0;
        }
        var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "child \"" + args[1] + "\"");
        start.UseShellExecute = false; start.CreateNoWindow = true;
        var child = Process.Start(start);
        File.WriteAllText(args[1] + ".pid", child.Id.ToString());
        while (!File.Exists(args[1] + ".locked")) Thread.Sleep(10);
        if (args[0] != "orphan") Thread.Sleep(60000);
        return 0;
    }
}
