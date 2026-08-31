using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Windows-only process owner for long-lived provider transports. The provider is created inside
// an unnamed Job Object at process-creation time, before its primary thread can run. The helper
// keeps the only job handle, so helper death cannot orphan the provider or any descendant.
internal static class Program
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectBasicAccountingInformationClass = 1;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint Infinite = 0xffffffff;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint WaitFailed = 0xffffffff;
    private const uint ProcessSynchronize = 0x00100000;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const long ProcThreadAttributeHandleList = 0x00020002;
    private const long ProcThreadAttributeJobList = 0x0002000d;
    private const int MaximumArguments = 256;
    private const int MaximumFieldBytes = 64 * 1024;
    private const int CleanupTimeoutMilliseconds = 5000;

    public static int Main(string[] encodedArguments)
    {
        try
        {
            if (encodedArguments.Length < 3 || encodedArguments.Length > MaximumArguments + 3)
                return Fail("arguments", 0);

            int ownerProcessId;
            if (!Int32.TryParse(
                Decode(encodedArguments[0]),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out ownerProcessId) || ownerProcessId <= 0)
                return Fail("owner", 0);

            string executable = Decode(encodedArguments[1]);
            string workingDirectory = Decode(encodedArguments[2]);
            var arguments = new string[encodedArguments.Length - 3];
            for (int index = 3; index < encodedArguments.Length; index++)
                arguments[index - 3] = Decode(encodedArguments[index]);

            if (!Path.IsPathRooted(executable) || !File.Exists(executable))
                return Fail("executable", 0);
            string extension = Path.GetExtension(executable);
            if (!String.Equals(extension, ".exe", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase))
                return Fail("executable_type", 0);
            if (!Path.IsPathRooted(workingDirectory) || !Directory.Exists(workingDirectory))
                return Fail("working_directory", 0);

            return Run(ownerProcessId, executable, workingDirectory, arguments);
        }
        catch (FormatException)
        {
            return Fail("configuration", 0);
        }
        catch (ArgumentException)
        {
            return Fail("configuration", 0);
        }
        catch
        {
            return Fail("internal", Marshal.GetLastWin32Error());
        }
    }

    private static int Run(
        int ownerProcessId,
        string executable,
        string workingDirectory,
        string[] arguments)
    {
        IntPtr ownerProcess = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr inheritedHandles = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        var processInformation = new ProcessInformation();

        try
        {
            ownerProcess = OpenProcess(ProcessSynchronize, false, (uint)ownerProcessId);
            if (!ValidHandle(ownerProcess))
                return Fail("open_owner", Marshal.GetLastWin32Error());
            uint ownerState = WaitForSingleObject(ownerProcess, 0);
            if (ownerState == WaitObject0)
                return Fail("owner_exited", 0);
            if (ownerState != WaitTimeout)
                return Fail("owner_wait", Marshal.GetLastWin32Error());

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                return Fail("create_job", Marshal.GetLastWin32Error());

            var limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
                return Fail("configure_job", Marshal.GetLastWin32Error());

            IntPtr standardInput = GetStdHandle(StdInputHandle);
            IntPtr standardOutput = GetStdHandle(StdOutputHandle);
            IntPtr standardError = GetStdHandle(StdErrorHandle);
            if (!ValidHandle(standardInput) || !ValidHandle(standardOutput) || !ValidHandle(standardError))
                return Fail("standard_handles", Marshal.GetLastWin32Error());

            var uniqueHandles = UniqueHandles(standardInput, standardOutput, standardError);
            foreach (IntPtr handle in uniqueHandles)
            {
                if (!SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit))
                    return Fail("inherit_handles", Marshal.GetLastWin32Error());
            }

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero)
                return Fail("attribute_size", Marshal.GetLastWin32Error());
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeListSize))
                return Fail("attribute_init", Marshal.GetLastWin32Error());

            inheritedHandles = Marshal.AllocHGlobal(IntPtr.Size * uniqueHandles.Count);
            for (int index = 0; index < uniqueHandles.Count; index++)
                Marshal.WriteIntPtr(inheritedHandles, index * IntPtr.Size, uniqueHandles[index]);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeHandleList),
                inheritedHandles,
                new IntPtr(IntPtr.Size * uniqueHandles.Count),
                IntPtr.Zero,
                IntPtr.Zero))
                return Fail("handle_attribute", Marshal.GetLastWin32Error());

            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeJobList),
                jobList,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
                return Fail("job_attribute", Marshal.GetLastWin32Error());

            var startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = StartfUseStdHandles;
            startup.StartupInfo.hStdInput = standardInput;
            startup.StartupInfo.hStdOutput = standardOutput;
            startup.StartupInfo.hStdError = standardError;
            startup.AttributeList = attributeList;

            string applicationName = executable;
            string rawCommandLine;
            if (String.Equals(Path.GetExtension(executable), ".cmd", StringComparison.OrdinalIgnoreCase))
            {
                string commandInterpreter = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "cmd.exe");
                if (!File.Exists(commandInterpreter) || !SafeCmdValue(executable))
                    return Fail("command_interpreter", 0);
                foreach (string argument in arguments)
                {
                    if (!SafeCmdValue(argument))
                        return Fail("command_argument", 0);
                }
                applicationName = commandInterpreter;
                rawCommandLine = BuildCmdCommandLine(commandInterpreter, executable, arguments);
            }
            else
            {
                rawCommandLine = BuildCommandLine(executable, arguments);
            }
            var commandLine = new StringBuilder(rawCommandLine);
            uint creationFlags = CreateSuspended | CreateUnicodeEnvironment |
                ExtendedStartupInfoPresent | CreateNoWindow;
            if (!CreateProcess(
                applicationName,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                creationFlags,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out processInformation))
                return Fail("create_provider", Marshal.GetLastWin32Error());

            ownerState = WaitForSingleObject(ownerProcess, 0);
            if (ownerState != WaitTimeout)
                return FailAfterCreate(job, processInformation.ProcessHandle, "owner_exited", 0);
            if (!WriteControl(standardError, "ADJH/1 READY " + processInformation.ProcessId + "\n"))
                return FailAfterCreate(job, processInformation.ProcessHandle, "ready", Marshal.GetLastWin32Error());
            if (ResumeThread(processInformation.ThreadHandle) == UInt32.MaxValue)
                return FailAfterCreate(job, processInformation.ProcessHandle, "resume", Marshal.GetLastWin32Error());

            var waitHandles = new[] { processInformation.ProcessHandle, ownerProcess };
            uint waitResult = WaitForMultipleObjects((uint)waitHandles.Length, waitHandles, false, Infinite);
            if (waitResult == WaitObject0 + 1)
            {
                if (!TerminateJobObject(job, 1))
                    return Fail("terminate_orphaned_job", Marshal.GetLastWin32Error());
                if (!WaitForJobEmpty(job, CleanupTimeoutMilliseconds))
                    return Fail("reap_orphaned_job", Marshal.GetLastWin32Error());
                return 125;
            }
            if (waitResult != WaitObject0)
                return FailAfterCreate(
                    job,
                    processInformation.ProcessHandle,
                    "wait_provider",
                    waitResult == WaitFailed ? Marshal.GetLastWin32Error() : 0);
            uint providerExitCode;
            if (!GetExitCodeProcess(processInformation.ProcessHandle, out providerExitCode))
                return FailAfterCreate(job, processInformation.ProcessHandle, "provider_exit", Marshal.GetLastWin32Error());

            if (!TerminateJobObject(job, 1))
                return Fail("terminate_job", Marshal.GetLastWin32Error());
            if (!WaitForJobEmpty(job, CleanupTimeoutMilliseconds))
                return Fail("reap_job", Marshal.GetLastWin32Error());

            return unchecked((int)providerExitCode);
        }
        finally
        {
            if (processInformation.ThreadHandle != IntPtr.Zero)
                CloseHandle(processInformation.ThreadHandle);
            if (processInformation.ProcessHandle != IntPtr.Zero)
                CloseHandle(processInformation.ProcessHandle);
            if (attributeList != IntPtr.Zero)
                DeleteProcThreadAttributeList(attributeList);
            if (jobList != IntPtr.Zero)
                Marshal.FreeHGlobal(jobList);
            if (inheritedHandles != IntPtr.Zero)
                Marshal.FreeHGlobal(inheritedHandles);
            if (attributeList != IntPtr.Zero)
                Marshal.FreeHGlobal(attributeList);
            if (job != IntPtr.Zero)
                CloseHandle(job);
            if (ownerProcess != IntPtr.Zero)
                CloseHandle(ownerProcess);
        }
    }

    private static int FailAfterCreate(IntPtr job, IntPtr process, string stage, int error)
    {
        TerminateJobObject(job, 1);
        WaitForSingleObject(process, CleanupTimeoutMilliseconds);
        WaitForJobEmpty(job, CleanupTimeoutMilliseconds);
        return Fail(stage, error);
    }

    private static bool WaitForJobEmpty(IntPtr job, int timeoutMilliseconds)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        while (true)
        {
            var accounting = new JobObjectBasicAccountingInformation();
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformationClass,
                ref accounting,
                (uint)Marshal.SizeOf(typeof(JobObjectBasicAccountingInformation)),
                IntPtr.Zero))
                return false;
            if (accounting.ActiveProcesses == 0)
                return true;
            if (DateTime.UtcNow >= deadline)
                return false;
            Thread.Sleep(10);
        }
    }

    private static List<IntPtr> UniqueHandles(params IntPtr[] handles)
    {
        var unique = new List<IntPtr>();
        foreach (IntPtr handle in handles)
        {
            if (!unique.Contains(handle))
                unique.Add(handle);
        }
        return unique;
    }

    private static string Decode(string encoded)
    {
        byte[] bytes = Convert.FromBase64String(encoded);
        if (bytes.Length > MaximumFieldBytes)
            throw new ArgumentException("field too large");
        string value = new UTF8Encoding(false, true).GetString(bytes);
        if (value.IndexOf('\0') >= 0)
            throw new ArgumentException("invalid field");
        return value;
    }

    private static string BuildCommandLine(string executable, string[] arguments)
    {
        var commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine.ToString();
    }

    private static string BuildCmdCommandLine(
        string commandInterpreter,
        string executable,
        string[] arguments)
    {
        var commandLine = new StringBuilder(QuoteArgument(commandInterpreter));
        commandLine.Append(" /d /v:off /s /c \"");
        commandLine.Append(EscapeCmdCommand(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(EscapeCmdArgument(argument));
        }
        commandLine.Append('"');
        return commandLine.ToString();
    }

    // cmd.exe treats CR/LF as command separators even inside quotes. Every other non-NUL value is
    // escaped below; reject only the two characters that cannot be transported without ambiguity.
    private static bool SafeCmdValue(string value)
    {
        foreach (char character in value)
        {
            if (character == '\r' || character == '\n')
                return false;
        }
        return true;
    }

    private static string EscapeCmdCommand(string value)
    {
        return EscapeCmdMetacharacters(value);
    }

    // Port of the battle-tested cross-spawn/qntm cmd.exe quoting algorithm. A .cmd file commonly
    // expands %* through a second parsing pass, so metacharacters are escaped twice.
    private static string EscapeCmdArgument(string value)
    {
        return EscapeCmdMetacharacters(EscapeCmdMetacharacters(QuoteArgument(value)));
    }

    private static string EscapeCmdMetacharacters(string value)
    {
        var escaped = new StringBuilder();
        foreach (char character in value)
        {
            if (IsCmdMetacharacter(character))
                escaped.Append('^');
            escaped.Append(character);
        }
        return escaped.ToString();
    }

    private static bool IsCmdMetacharacter(char character)
    {
        return character == '(' || character == ')' || character == '[' || character == ']' ||
            character == '%' || character == '!' || character == '^' || character == '"' ||
            character == '`' || character == '<' || character == '>' || character == '&' ||
            character == '|' || character == ';' || character == ',' || character == ' ' ||
            character == '*' || character == '?';
    }

    // Inverse of the CommandLineToArgvW quoting rules used by native Windows executables.
    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static bool ValidHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != new IntPtr(-1);
    }

    private static int Fail(string stage, int win32Error)
    {
        IntPtr standardError = GetStdHandle(StdErrorHandle);
        if (ValidHandle(standardError))
            WriteControl(standardError, "ADJH/1 ERROR " + stage + " " + win32Error + "\n");
        return 125;
    }

    private static bool WriteControl(IntPtr handle, string value)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(value);
        uint written;
        return WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero) &&
            written == bytes.Length;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int dwFlags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr ProcessHandle;
        public IntPtr ThreadHandle;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobObjectBasicAccountingInformation information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count,
        IntPtr[] handles,
        bool waitAll,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped);
}
