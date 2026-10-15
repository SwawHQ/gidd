using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Test-only owner: start suspended so descendants cannot escape the job before
// assignment. Closing the owner also terminates the job after a forced exit.
public static class TestProcess {
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int size; public IntPtr reserved, desktop, title;
        public int x, y, width, height, xChars, yChars, fill, flags;
        public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread; public int processId, threadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorking, maxWorking; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits basic;
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        string control = args[3];
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            ExtendedLimits limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
            Startup startup = new Startup();
            startup.size = Marshal.SizeOf(startup); startup.flags = 0x100;
            startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
            string command = "\"" + args[0] + "\" " + args[1];
            if (!CreateProcess(args[0], new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
                0x08000004, IntPtr.Zero, null, ref startup, out child)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, child.process)) throw new Win32Exception();
            if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception();
            var watch = System.Diagnostics.Stopwatch.StartNew();
            long timeout = Int64.Parse(args[2]);
            bool cancelled = false, timedOut = false;
            while (WaitForSingleObject(child.process, 25) == 258) {
                cancelled = File.Exists(control + ".cancel");
                timedOut = timeout > 0 && watch.ElapsedMilliseconds >= timeout;
                if (cancelled || timedOut) break;
            }
            uint code;
            if (timedOut) File.WriteAllText(control + ".timeout", "timeout");
            if (cancelled || timedOut) code = timedOut ? 124u : 130u;
            else if (!GetExitCodeProcess(child.process, out code)) throw new Win32Exception();
            // A completed command must not leave a helper holding test files or pipes.
            if (!TerminateJobObject(job, code)) throw new Win32Exception();
            var cleanup = System.Diagnostics.Stopwatch.StartNew();
            while (true) {
                Accounting accounting;
                if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                    throw new Win32Exception();
                if (accounting.activeProcesses == 0) break;
                if (cleanup.ElapsedMilliseconds > 10000) throw new Exception("Test helpers did not stop within 10 seconds");
                Thread.Sleep(10);
            }
            if (code != 0) File.WriteAllText(control + ".exit", code.ToString());
            return unchecked((int)code);
        } catch (Exception error) {
            var native = error as Win32Exception;
            File.WriteAllText(control + ".error", native == null ? error.Message : native.NativeErrorCode.ToString());
            Console.Error.WriteLine("Test process failed: " + error.Message);
            return 125;
        } finally {
            if (child.process != IntPtr.Zero) {
                TerminateProcess(child.process, 125);
                WaitForSingleObject(child.process, 5000);
                CloseHandle(child.process);
            }
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
