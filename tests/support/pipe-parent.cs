using System;
using System.IO;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
public static class PipeParent {
    public static int Main(string[] args) {
        if (args[0] == "child") { Thread.Sleep(10000); return 0; }
        if (args[0] == "normal") { Console.WriteLine("complete output"); Console.Error.WriteLine("private stderr"); return 0; }
        if (args[0] == "hang") { Thread.Sleep(10000); return 0; }
        var info = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "child");
        info.UseShellExecute = false; info.CreateNoWindow = true;
        var child = Process.Start(info);
        File.WriteAllText(args[1], child.Id.ToString());
        Thread.Sleep(Int32.Parse(args[0]));
        Console.WriteLine("parent exited");
        return 0;
    }
}
