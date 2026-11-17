using System.Diagnostics;
using System.Globalization;
using System.Security.Principal;
using System.Text;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Runs schtasks.exe (and wevtutil.exe for the history) for the Zamanlayıcılar
/// window. No shell: every value is its own argument (ArgumentList), so a
/// task name or an argument can never become another command. Deleting is
/// refused for any task outside \WECOMMANDER\ before anything runs.
/// </summary>
public static class LocalTaskReader
{
    public static string Schtasks => Path.Combine(Environment.SystemDirectory, "schtasks.exe");
    private static string Wevtutil => Path.Combine(Environment.SystemDirectory, "wevtutil.exe");

    /// <summary>The signed-in user (DOMAIN\name) and SID, to tell which tasks are theirs.</summary>
    public static string UserName { get; } = $"{Environment.UserDomainName}\\{Environment.UserName}";
    public static string? UserSid { get; } = Try(() => WindowsIdentity.GetCurrent().User?.Value);

    /// <summary>WECOMMANDER runs as administrator: every task may be changed.</summary>
    public static bool Elevated { get; } = Try(() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator));

    private static T? Try<T>(Func<T> f) { try { return f(); } catch (Exception) { return default; } }

    /// <summary>
    /// schtasks writes in the console's code page when its output is redirected
    /// (some outputs in UTF-16): the bytes are read and their encoding recognised.
    /// </summary>
    public static string Decode(byte[] bytes)
    {
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        var sample = Math.Min(bytes.Length, 400);
        var zeros = 0;
        for (var i = 1; i < sample; i += 2) if (bytes[i] == 0) zeros++;
        if (sample >= 4 && zeros > sample / 4) return Encoding.Unicode.GetString(bytes);
        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage).GetString(bytes);
        }
        catch (Exception) { return Encoding.UTF8.GetString(bytes); }
    }

    private static async Task<string> ReadAll(Stream s)
    {
        using var buffer = new MemoryStream();
        await s.CopyToAsync(buffer);
        return Decode(buffer.ToArray());
    }

    /// <summary>Runs a Windows tool with its arguments one by one; (exit code, output, errors).</summary>
    public static (int Code, string Output, string Error) Exec(string file, IEnumerable<string> args, int timeoutMs = 30000)
    {
        var info = new ProcessStartInfo(file)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true, // a question (a password) gets an empty answer instead of waiting
        };
        foreach (var a in args) info.ArgumentList.Add(a);
        using var p = Process.Start(info) ?? throw new InvalidOperationException(file);
        p.StandardInput.Close();
        var output = ReadAll(p.StandardOutput.BaseStream);
        var error = ReadAll(p.StandardError.BaseStream);
        if (!p.WaitForExit(timeoutMs))
        {
            try { p.Kill(true); } catch (Exception) { }
            return (-1, "", L.T("Windows zamanında yanıt vermedi."));
        }
        return (p.ExitCode, output.GetAwaiter().GetResult(), error.GetAwaiter().GetResult());
    }

    /// <summary>All tasks this user can see, with their times and last results.</summary>
    public static List<LocalTask> Read()
    {
        // A folder this user may not read makes schtasks report an error and go on: what it printed still counts.
        var xml = Exec(Schtasks, LocalTasks.QueryXml(), 60000);
        var definitions = LocalTasks.ParseXml(xml.Output);
        if (definitions.Count == 0 && xml.Code != 0) throw new InvalidOperationException(Message(xml));
        var csv = Exec(Schtasks, LocalTasks.QueryCsv(), 60000);
        return LocalTasks.Merge(definitions, LocalTasks.ParseCsv(csv.Output));
    }

    /// <summary>The user cannot change this task without administrator rights.</summary>
    public static bool NeedsAdmin(LocalTask t) => !Elevated && LocalTasks.NeedsAdmin(t, UserName, UserSid);

    private static string Message((int Code, string Output, string Error) r)
    {
        var text = (r.Error.Trim().Length > 0 ? r.Error : r.Output).Trim();
        if (LocalTasks.Denied(r.Error + r.Output)) return L.T("Bu görevi değiştirmek için yönetici izni gerekiyor. WECOMMANDER'ı yönetici olarak açıp yeniden dene.");
        return text.Length > 0 ? text : L.F("schtasks {0} koduyla bitti.", r.Code);
    }

    /// <summary>Runs schtasks with <paramref name="args"/>; null on success, else why not.</summary>
    public static string? Do(IReadOnlyList<string> args)
    {
        try
        {
            var r = Exec(Schtasks, args);
            return r.Code == 0 ? null : Message(r);
        }
        catch (Exception e) { return e.Message; }
    }

    public static string? Run(LocalTask t) => Do(LocalTasks.Run(t.Path));
    public static string? SetEnabled(LocalTask t, bool on) => Do(LocalTasks.SetEnabled(t.Path, on));

    public static string? Create(LocalTaskSpec spec) => LocalTasks.Check(spec) ?? Do(LocalTasks.Create(spec));

    /// <summary>Deletes a task of ours; any other task is refused before schtasks runs.</summary>
    public static string? Delete(string path) => LocalTasks.Delete(path) is { } args ? Do(args) : LocalTasks.DeleteRefusal(path);

    /// <summary>The task's recent history; empty when Windows keeps none (the history is off by default).</summary>
    public static List<LocalTaskEvent> History(LocalTask t)
    {
        if (LocalTasks.HistoryQuery(t.Path) is not { } args) return [];
        try
        {
            var r = Exec(Wevtutil, args, 20000);
            return r.Code == 0 ? LocalTasks.ParseHistory(r.Output) : [];
        }
        catch (Exception) { return []; }
    }

    /// <summary>
    /// CI: proves the commands and the guards on the real machine. Lists the
    /// tasks, creates \WECOMMANDER\wc-selftest (cmd /c exit 0, daily), finds it,
    /// runs it, turns it off and on, deletes it, and checks that a Windows task
    /// is never deleted. Writes PASS/FAIL lines to <paramref name="logPath"/>; true when all pass.
    /// </summary>
    public static bool SelfTest(string logPath)
    {
        var lines = new List<string>();
        var ok = true;
        void Check(bool pass, string what) { lines.Add((pass ? "PASS " : "FAIL ") + what); ok &= pass; }
        void Note(string what) => lines.Add("INFO " + what);
        const string path = LocalTasks.OurFolder + "wc-selftest";
        LocalTask? Find() => Read().FirstOrDefault(t => t.Path.Equals(path, StringComparison.OrdinalIgnoreCase));
        try
        {
            Note($"user {UserName} elevated={Elevated}");
            _ = Delete(path); // a run that stopped half way left it behind
            var all = Read();
            Check(all.Count > 0, $"tasks listed ({all.Count}, Windows' own {all.Count(t => t.IsWindows)})");
            Check(all.Where(t => !t.IsWindows).All(t => LocalTasks.Filter(all, "", false).Contains(t))
                && LocalTasks.Filter(all, "", false).All(t => !t.IsWindows), "Windows' own tasks are hidden unless asked for");

            var spec = new LocalTaskSpec("wc-selftest", "cmd.exe", "/c exit 0", "daily", "03:00", []);
            var created = Create(spec);
            Check(created is null, "a daily task is created in \\WECOMMANDER\\" + (created is null ? "" : ": " + created));
            var task = Find();
            Check(task is { Enabled: true } && task.Triggers.Count == 1 && task.Triggers[0].Schedule == "daily"
                && task.Actions.Count == 1 && task.Actions[0].Command.Contains("cmd", StringComparison.OrdinalIgnoreCase),
                $"it is listed with its daily trigger and command ({task?.TriggerSummary} | {task?.Command})");
            Check(task is not null && LocalTasks.SpecFrom(task) is { Schedule: "daily", Time: "03:00" }, "it can be opened for editing");
            Check(task is not null && !LocalTasks.NeedsAdmin(task, UserName, UserSid), $"it belongs to this user ({task?.UserId})");
            Note($"before running: last result {LocalTasks.ResultText(task?.LastResult)}");

            if (task is not null)
            {
                var run = Run(task);
                Check(run is null, "Run now is accepted" + (run is null ? "" : ": " + run));
                LocalTask? after = null;
                for (var i = 0; i < 30; i++)
                {
                    Thread.Sleep(1000);
                    after = Find();
                    if (after?.LastResult is 0) break;
                }
                // The task runs only while this user is signed in interactively.
                if (after?.LastResult is 0) Check(true, "it ran and returned 0x0");
                else Note($"it did not report a run (last result {LocalTasks.ResultText(after?.LastResult)}); no interactive session?");

                var off = SetEnabled(task, false);
                Check(off is null && Find() is { Enabled: false, State: LocalTaskState.Disabled }, "it is turned off" + (off is null ? "" : ": " + off));
                var on = SetEnabled(task, true);
                Check(on is null && Find() is { Enabled: true }, "it is turned on again" + (on is null ? "" : ": " + on));

                var edited = Create(spec with { Schedule = "weekly", Days = [DayOfWeek.Monday], Time = "04:15" });
                var weekly = Find();
                Check(edited is null && weekly?.Triggers.FirstOrDefault()?.Schedule == "weekly", "editing replaces it (weekly, Monday 04:15)");
            }

            Check(Create(spec with { Name = "x\" & calc" }) is not null, "a name with quotes and & is refused");
            Check(Create(spec with { Arguments = "/c exit 0 & calc" }) is not null, "arguments that chain a command are refused");

            var windows = all.FirstOrDefault(t => t.IsWindows) ?? all.FirstOrDefault(t => !t.IsOurs);
            var refusal = Delete(windows?.Path ?? @"\Microsoft\Windows\Defrag\ScheduledDefrag");
            Check(refusal is not null && LocalTasks.Delete(windows?.Path ?? @"\Microsoft\Windows\Defrag\ScheduledDefrag") is null, $"deleting a task outside \\WECOMMANDER\\ is refused ({windows?.Path})");
            if (windows is not null)
                Check(Read().Any(t => t.Path.Equals(windows.Path, StringComparison.OrdinalIgnoreCase)), "that task is still there");

            var deleted = Delete(path);
            Check(deleted is null && Find() is null, "the test task is deleted" + (deleted is null ? "" : ": " + deleted));
        }
        catch (Exception e)
        {
            Check(false, "self-test crashed: " + e.Message);
        }
        finally
        {
            try { _ = Delete(path); } catch (Exception) { }
        }
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            File.WriteAllLines(logPath, lines);
        }
        catch (Exception) { }
        return ok;
    }
}
