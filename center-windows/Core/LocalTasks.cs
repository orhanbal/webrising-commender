using System.Globalization;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace Wecommander.Center.Core;

// Zamanlayıcılar: this computer's Windows Task Scheduler. The app runs
// schtasks.exe (no shell, every value its own argument); everything here is
// plain and tested: reading its output, the command lines, the checks on what
// the owner types and the rules that keep other programs' tasks safe.
//
// schtasks prints its table in the Windows display language, so nothing is
// read from a column title or a translated word: the task definitions come
// from "/query /xml ONE" (the same in every language) and the times and the
// last result from the verbose CSV by column position.

/// <summary>Ready, turned off, or running now.</summary>
public enum LocalTaskState { Ready, Disabled, Running }

/// <summary>What starts a task.</summary>
/// <param name="Kind">The XML element name: TimeTrigger, CalendarTrigger, LogonTrigger, BootTrigger, ...</param>
/// <param name="Schedule">For CalendarTrigger: daily, weekly or monthly.</param>
/// <param name="Interval">Every n days / weeks.</param>
public sealed record LocalTaskTrigger(string Kind, string? Schedule, DateTime? Start, int Interval, IReadOnlyList<DayOfWeek> Days, string? Repeat);

/// <summary>What a task does: a program with its arguments (Exec), or another kind (COM handler, e-mail).</summary>
public sealed record LocalTaskAction(string Kind, string Command, string? Arguments, string? WorkingDirectory)
{
    public string Display => Kind == "Exec"
        ? (Command.Contains(' ') && !Command.StartsWith('"') ? $"\"{Command}\"" : Command) + (string.IsNullOrWhiteSpace(Arguments) ? "" : " " + Arguments)
        : $"{Kind}: {Command}";
}

/// <summary>One line of a task's history (Task Scheduler's operational log).</summary>
public sealed record LocalTaskEvent(DateTime? At, int Id, string Text, int? Result);

/// <summary>A scheduled task of this computer.</summary>
/// <param name="Path">Full path: \Folder\Name.</param>
/// <param name="NextRun">As Windows wrote it (in its language); null: none.</param>
/// <param name="LastResult">The last run's result code; null: not read.</param>
public sealed record LocalTask(
    string Path, string? Author, string? Description, bool Enabled,
    string? UserId, string? GroupId, string? RunLevel,
    IReadOnlyList<LocalTaskTrigger> Triggers, IReadOnlyList<LocalTaskAction> Actions,
    string? NextRun = null, string? LastRun = null, int? LastResult = null, bool RunningNow = false)
{
    public string Name => Path[(Path.LastIndexOf('\\') + 1)..];
    public string Folder => Path.LastIndexOf('\\') <= 0 ? "\\" : Path[..Path.LastIndexOf('\\')];
    public LocalTaskState State => !Enabled ? LocalTaskState.Disabled
        : RunningNow || LastResult == LocalTasks.CodeRunning ? LocalTaskState.Running : LocalTaskState.Ready;
    /// <summary>Windows' own tasks (\Microsoft\Windows\...).</summary>
    public bool IsWindows => Path.StartsWith(@"\Microsoft\", StringComparison.OrdinalIgnoreCase);
    /// <summary>Created from WECOMMANDER (its own folder): only these are edited or deleted here.</summary>
    public bool IsOurs => LocalTasks.InOurFolder(Path);
    public string Command => Actions.Count == 0 ? "" : string.Join(" ; ", Actions.Select(a => a.Display));
    public string TriggerSummary => Triggers.Count == 0 ? L.T("Tetikleyici yok (yalnız elle)") : string.Join(" · ", Triggers.Select(LocalTasks.Describe));
}

/// <summary>A task the owner creates or edits here (always in \WECOMMANDER\, for the signed-in user).</summary>
/// <param name="Schedule">once, daily, weekly or logon.</param>
/// <param name="Time">HH:mm (24 hours); not used at logon.</param>
public sealed record LocalTaskSpec(string Name, string Program, string Arguments, string Schedule, string Time, IReadOnlyList<DayOfWeek> Days);

public static class LocalTasks
{
    public const string OurFolder = @"\WECOMMANDER\";
    public const int CodeRunning = 0x41301;
    public const int CodeNotYetRun = 0x41303;
    public const int MaxTaskRun = 261; // schtasks /tr limit

    public static readonly string[] Schedules = ["once", "daily", "weekly", "logon"];

    public static bool InOurFolder(string path) =>
        path.StartsWith(OurFolder, StringComparison.OrdinalIgnoreCase) && path.Length > OurFolder.Length
        && !path.Contains("..", StringComparison.Ordinal) && !path.Contains('/');

    // ---- reading ----

    private static string? Child(XElement? e, string name) => e?.Elements().FirstOrDefault(x => x.Name.LocalName == name)?.Value.Trim();
    private static XElement? El(XElement? e, string name) => e?.Elements().FirstOrDefault(x => x.Name.LocalName == name);

    /// <summary>
    /// The output of <c>schtasks /query /xml ONE</c>: every task's definition,
    /// each after a comment with its path. Times and results are not in it.
    /// </summary>
    public static List<LocalTask> ParseXml(string xml)
    {
        // Each task on its own: one that cannot be read (an error line in the
        // middle, a cut-off end) does not lose the others.
        var result = new List<LocalTask>();
        if (string.IsNullOrEmpty(xml)) return result;
        var at = 0;
        while (true)
        {
            var open = xml.IndexOf("<!--", at, StringComparison.Ordinal);
            if (open < 0) break;
            var close = xml.IndexOf("-->", open + 4, StringComparison.Ordinal);
            if (close < 0) break;
            var path = xml[(open + 4)..close].Trim();
            at = close + 3;
            var start = xml.IndexOf("<Task", at, StringComparison.Ordinal);
            var next = xml.IndexOf("<!--", at, StringComparison.Ordinal);
            if (start < 0 || (next >= 0 && next < start) || !path.StartsWith('\\')) continue;
            var end = xml.IndexOf("</Task>", start, StringComparison.Ordinal);
            if (end < 0) break;
            at = end + "</Task>".Length;
            try { result.Add(FromDefinition(path, XElement.Parse(xml[start..at]))); }
            catch (XmlException) { }
        }
        return result;
    }

    /// <summary>One task's XML definition (a &lt;Task&gt; element).</summary>
    public static LocalTask FromDefinition(string path, XElement task)
    {
        var reg = El(task, "RegistrationInfo");
        var settings = El(task, "Settings");
        var principal = El(El(task, "Principals"), "Principal");
        var enabled = !string.Equals(Child(settings, "Enabled"), "false", StringComparison.OrdinalIgnoreCase);
        var triggers = (El(task, "Triggers")?.Elements() ?? []).Select(Trigger).ToList();
        var actions = new List<LocalTaskAction>();
        foreach (var a in El(task, "Actions")?.Elements() ?? [])
        {
            switch (a.Name.LocalName)
            {
                case "Exec": actions.Add(new LocalTaskAction("Exec", Child(a, "Command") ?? "", Child(a, "Arguments"), Child(a, "WorkingDirectory"))); break;
                case "ComHandler": actions.Add(new LocalTaskAction("COM", Child(a, "ClassId") ?? "", Child(a, "Data"), null)); break;
                default: actions.Add(new LocalTaskAction(a.Name.LocalName, Child(a, "Subject") ?? Child(a, "Title") ?? "", null, null)); break;
            }
        }
        return new LocalTask(path, Child(reg, "Author"), Child(reg, "Description"), enabled,
            Child(principal, "UserId"), Child(principal, "GroupId"), Child(principal, "RunLevel"), triggers, actions);
    }

    private static LocalTaskTrigger Trigger(XElement t)
    {
        DateTime? start = null;
        if (Child(t, "StartBoundary") is { } s && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) start = d;
        var repeat = Child(El(t, "Repetition"), "Interval");
        string? schedule = null;
        var interval = 1;
        var days = new List<DayOfWeek>();
        if (El(t, "ScheduleByDay") is { } byDay)
        {
            schedule = "daily";
            if (int.TryParse(Child(byDay, "DaysInterval"), out var n) && n > 0) interval = n;
        }
        else if (El(t, "ScheduleByWeek") is { } byWeek)
        {
            schedule = "weekly";
            if (int.TryParse(Child(byWeek, "WeeksInterval"), out var n) && n > 0) interval = n;
            foreach (var day in El(byWeek, "DaysOfWeek")?.Elements() ?? [])
                if (Enum.TryParse<DayOfWeek>(day.Name.LocalName, out var w)) days.Add(w);
        }
        else if (El(t, "ScheduleByMonth") is not null || El(t, "ScheduleByMonthDayOfWeek") is not null) schedule = "monthly";
        return new LocalTaskTrigger(t.Name.LocalName, schedule, start, interval, days, repeat);
    }

    /// <summary>A trigger in words.</summary>
    public static string Describe(LocalTaskTrigger t)
    {
        var time = t.Start?.ToString("HH:mm", CultureInfo.InvariantCulture) ?? "";
        var text = t.Kind switch
        {
            "TimeTrigger" => L.F("Bir kez: {0}", t.Start?.ToString("g", L.Culture) ?? "?"),
            "CalendarTrigger" => t.Schedule switch
            {
                "daily" => t.Interval == 1 ? L.F("Her gün {0}", time) : L.F("{0} günde bir {1}", t.Interval, time),
                "weekly" => L.F("Her hafta {0} {1}", string.Join(", ", t.Days.Select(d => L.Culture.DateTimeFormat.AbbreviatedDayNames[(int)d])), time),
                "monthly" => L.F("Her ay {0}", time),
                _ => L.F("Takvime göre {0}", time),
            },
            "LogonTrigger" => L.T("Oturum açılınca"),
            "BootTrigger" => L.T("Bilgisayar açılınca"),
            "IdleTrigger" => L.T("Bilgisayar boştayken"),
            "EventTrigger" => L.T("Bir olay kaydedilince"),
            "RegistrationTrigger" => L.T("Görev kaydedilince"),
            "SessionStateChangeTrigger" => L.T("Oturum durumu değişince"),
            "WnfStateChangeTrigger" => L.T("Windows durumu değişince"),
            _ => t.Kind,
        };
        if (t.Repeat is { Length: > 0 } r)
        {
            try { text += L.F(" · {0} aralıkla tekrar", Span(XmlConvert.ToTimeSpan(r))); } catch (FormatException) { }
        }
        return text;
    }

    private static string Span(TimeSpan s) =>
        s.TotalDays >= 1 && s.TotalDays % 1 == 0 ? L.F("{0} gün", (int)s.TotalDays)
        : s.TotalHours >= 1 && s.TotalHours % 1 == 0 ? L.F("{0} sa", (int)s.TotalHours)
        : L.F("{0} dk", (int)Math.Max(1, s.TotalMinutes));

    /// <summary>A CSV line split into fields (quotes, doubled quotes inside).</summary>
    public static List<string> SplitCsv(string line)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var ch = line[i];
            if (quoted)
            {
                if (ch == '"' && i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i++; }
                else if (ch == '"') quoted = false;
                else sb.Append(ch);
            }
            else if (ch == '"') quoted = true;
            else if (ch == ',') { fields.Add(sb.ToString()); sb.Clear(); }
            else sb.Append(ch);
        }
        fields.Add(sb.ToString());
        return fields;
    }

    /// <summary>Times and the last result of each task, from <c>schtasks /query /fo csv /v /nh</c>.</summary>
    /// <remarks>
    /// Columns by position: 0 host, 1 task name, 2 next run, 3 status, 4 logon
    /// mode, 5 last run, 6 last result (a decimal number in every language).
    /// A task with several triggers has several lines; the first one counts.
    /// </remarks>
    public static Dictionary<string, (string? Next, string? Last, int? Result, bool Running)> ParseCsv(string csv)
    {
        var result = new Dictionary<string, (string?, string?, int?, bool)>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in csv.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            var f = SplitCsv(line);
            if (f.Count < 7 || !f[1].StartsWith('\\') || result.ContainsKey(f[1])) continue;
            int? code = int.TryParse(f[6].Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) ? n : null;
            result[f[1]] = (Time(f[2]), Time(f[5]), code, f[3].Trim().Equals("Running", StringComparison.OrdinalIgnoreCase));
        }
        return result;
    }

    // "N/A", "Yok", "Nicht zutreffend"...: only a value with a digit is a time.
    private static string? Time(string value)
    {
        var v = value.Trim();
        return v.Any(char.IsDigit) ? v : null;
    }

    /// <summary>The definitions with their times and results.</summary>
    public static List<LocalTask> Merge(IEnumerable<LocalTask> definitions, IReadOnlyDictionary<string, (string? Next, string? Last, int? Result, bool Running)> times) =>
        definitions.Select(t => times.TryGetValue(t.Path, out var r)
            ? t with { NextRun = r.Next, LastRun = r.Last, LastResult = r.Result, RunningNow = r.Running }
            : t).ToList();

    /// <summary>Tasks matching the search; Windows' own only when asked for. Sorted by folder, then name.</summary>
    public static List<LocalTask> Filter(IEnumerable<LocalTask> tasks, string? query, bool showWindows)
    {
        var q = (query ?? "").Trim();
        return tasks
            .Where(t => showWindows || !t.IsWindows)
            .Where(t => q.Length == 0 || t.Path.Contains(q, StringComparison.OrdinalIgnoreCase)
                || t.Command.Contains(q, StringComparison.OrdinalIgnoreCase)
                || (t.Author?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false))
            .OrderBy(t => t.IsOurs ? 0 : t.IsWindows ? 2 : 1)
            .ThenBy(t => t.Folder, StringComparer.OrdinalIgnoreCase)
            .ThenBy(t => t.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public static string StateText(LocalTaskState s) => s switch
    {
        LocalTaskState.Disabled => L.T("Devre dışı"),
        LocalTaskState.Running => L.T("Çalışıyor"),
        _ => L.T("Hazır"),
    };

    /// <summary>A result code as Windows shows it (0x41303) with its meaning.</summary>
    public static string ResultText(int? code)
    {
        if (code is not { } c) return "—";
        var hex = "0x" + unchecked((uint)c).ToString("X", CultureInfo.InvariantCulture);
        var meaning = unchecked((uint)c) switch
        {
            0x0 => L.T("başarılı"),
            0x1 => L.T("hatalı işlev ya da program 1 ile çıktı"),
            0x2 => L.T("dosya bulunamadı ya da program 2 ile çıktı"),
            0x41300 => L.T("sonraki çalışmaya hazır"),
            0x41301 => L.T("şu anda çalışıyor"),
            0x41302 => L.T("görev devre dışı"),
            0x41303 => L.T("henüz hiç çalışmadı"),
            0x41306 => L.T("görev sonlandırıldı"),
            0x8004131F => L.T("görevin bir örneği zaten çalışıyor"),
            0x800710E0 => L.T("çalıştırma isteği reddedildi (oturum ya da izin)"),
            0x80070002 => L.T("program dosyası bulunamadı"),
            0x80070005 => L.T("erişim engellendi"),
            0xC000013A => L.T("program Ctrl+C ile kapatıldı"),
            _ => L.T("programın çıkış kodu"),
        };
        return $"{hex} · {meaning}";
    }

    /// <summary>
    /// The task runs as another account (SYSTEM, a service, another user, a
    /// group) or with the highest rights: a normal user cannot change it.
    /// </summary>
    public static bool NeedsAdmin(LocalTask t, string userName, string? userSid)
    {
        if (t.GroupId is { Length: > 0 }) return true;
        if (string.Equals(t.RunLevel, "HighestAvailable", StringComparison.OrdinalIgnoreCase)) return true;
        if (t.UserId is not { Length: > 0 } id) return false;
        if (userSid is not null && id.Equals(userSid, StringComparison.OrdinalIgnoreCase)) return false;
        var bare = userName.Contains('\\') ? userName[(userName.LastIndexOf('\\') + 1)..] : userName;
        return !(id.Equals(userName, StringComparison.OrdinalIgnoreCase) || id.Equals(bare, StringComparison.OrdinalIgnoreCase)
            || id.EndsWith("\\" + bare, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>schtasks said access is denied (its message is in the Windows language, the code is not always shown).</summary>
    public static bool Denied(string output) =>
        output.Contains("0x80070005", StringComparison.OrdinalIgnoreCase)
        || new[] { "Access is denied", "Zugriff verweigert", "Acc\u00e8s refus\u00e9", "Acceso denegado", "Acesso negado", "Eri\u015fim engellendi" }
            .Any(w => output.Contains(w, StringComparison.OrdinalIgnoreCase));

    // ---- what the owner types ----

    /// <summary>Why the task name cannot be used; null when it can (letters, digits, space, - _ . only).</summary>
    public static string? CheckName(string name)
    {
        var n = name.Trim();
        if (n.Length == 0) return L.T("Görev adı boş olamaz.");
        if (n.Length > 64) return L.T("Görev adı en çok 64 karakter olabilir.");
        if (n.StartsWith('.') || n.Contains("..", StringComparison.Ordinal) || !n.All(c => char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' or '.'))
            return L.T("Görev adında yalnız harf, rakam, boşluk ve - _ . kullanılabilir.");
        return null;
    }

    /// <summary>Why the program cannot be used; null when it can (a full path or a bare file name, no quotes or shell characters).</summary>
    public static string? CheckProgram(string program)
    {
        var p = program.Trim();
        if (p.Length == 0) return L.T("Çalıştırılacak programı yaz.");
        if (p.Length > 200) return L.T("Program yolu çok uzun.");
        if (p.Any(c => char.IsControl(c) || c is '"' or '<' or '>' or '|' or '&' or '^' or '%' or '*' or '?'))
            return L.T("Program yolunda tırnak ve & | < > ^ % * ? karakterleri kullanılamaz.");
        if (p.Contains(':') && !(p.Length > 2 && char.IsAsciiLetter(p[0]) && p[1] == ':' && p[2] == '\\' && p.IndexOf(':', 2) < 0))
            return L.T("Program tam bir yol (C:\\...\\program.exe) ya da yalnız dosya adı olmalı.");
        if (p.StartsWith('\\') && !p.StartsWith(@"\\", StringComparison.Ordinal))
            return L.T("Program tam bir yol (C:\\...\\program.exe) ya da yalnız dosya adı olmalı.");
        return null;
    }

    /// <summary>Why the arguments cannot be used; null when they can (one line, no shell redirection or chaining).</summary>
    public static string? CheckArguments(string arguments)
    {
        if (arguments.Any(char.IsControl)) return L.T("Argümanlar tek satır olmalı.");
        if (arguments.IndexOfAny(['&', '|', '<', '>', '^', '%', '`']) >= 0)
            return L.T("Argümanlarda & | < > ^ % ` karakterleri kullanılamaz (komut zinciri ve yönlendirme yok).");
        if (arguments.Count(c => c == '"') % 2 != 0) return L.T("Argümanlardaki tırnaklar eşleşmiyor.");
        return null;
    }

    /// <summary>HH:mm in 24 hours.</summary>
    public static bool ValidTime(string time) =>
        time.Length == 5 && TimeSpan.TryParseExact(time, @"hh\:mm", CultureInfo.InvariantCulture, out var t) && t < TimeSpan.FromDays(1);

    /// <summary>All checks of a new or edited task; null when it can be created.</summary>
    public static string? Check(LocalTaskSpec s)
    {
        if ((CheckName(s.Name) ?? CheckProgram(s.Program) ?? CheckArguments(s.Arguments)) is { } error) return error;
        if (!Schedules.Contains(s.Schedule)) return L.T("Zamanlamayı seç.");
        if (s.Schedule != "logon" && !ValidTime(s.Time)) return L.T("Başlangıç saatini SS:dd biçiminde yaz (ör. 03:30).");
        if (s.Schedule == "weekly" && s.Days.Count == 0) return L.T("Haftalık görev için en az bir gün seç.");
        if (TaskRun(s).Length > MaxTaskRun) return L.F("Program ve argümanlar birlikte en çok {0} karakter olabilir.", MaxTaskRun);
        return null;
    }

    /// <summary>The /tr value: the program (quoted when it has spaces) and its arguments.</summary>
    public static string TaskRun(LocalTaskSpec s)
    {
        var program = s.Program.Trim();
        var args = s.Arguments.Trim();
        var head = program.Contains(' ') ? $"\"{program}\"" : program;
        return args.Length == 0 ? head : head + " " + args;
    }

    // ---- the commands (arguments for schtasks.exe, one value each) ----

    public static List<string> QueryXml() => ["/query", "/xml", "ONE"];
    public static List<string> QueryCsv() => ["/query", "/fo", "csv", "/v", "/nh"];
    public static List<string> Run(string path) => ["/run", "/tn", path];
    public static List<string> SetEnabled(string path, bool on) => ["/change", "/tn", path, on ? "/enable" : "/disable"];

    private static readonly string[] DayCodes = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

    /// <summary>
    /// Creates (or with /f replaces) the task in \WECOMMANDER\ for the signed-in
    /// user (/it: runs while that user is signed in, no password stored). It keeps
    /// running on schedule when WECOMMANDER is closed.
    /// </summary>
    public static List<string> Create(LocalTaskSpec s)
    {
        var args = new List<string> { "/create", "/tn", OurFolder + s.Name.Trim(), "/tr", TaskRun(s) };
        switch (s.Schedule)
        {
            case "once": args.AddRange(["/sc", "ONCE", "/st", s.Time]); break;
            case "daily": args.AddRange(["/sc", "DAILY", "/st", s.Time]); break;
            case "weekly": args.AddRange(["/sc", "WEEKLY", "/d", string.Join(",", s.Days.Distinct().Order().Select(d => DayCodes[(int)d])), "/st", s.Time]); break;
            default: args.AddRange(["/sc", "ONLOGON"]); break;
        }
        args.AddRange(["/it", "/f"]);
        return args;
    }

    /// <summary>Deletes a task; only one in \WECOMMANDER\ (null: refused, see <see cref="DeleteRefusal"/>).</summary>
    public static List<string>? Delete(string path) => DeleteRefusal(path) is null ? ["/delete", "/tn", path, "/f"] : null;

    /// <summary>Why the task may not be deleted from here; null when it may.</summary>
    public static string? DeleteRefusal(string path) => InOurFolder(path) && CheckName(path[OurFolder.Length..]) is null
        ? null
        : L.T("Yalnız WECOMMANDER'ın oluşturduğu görevler (\\WECOMMANDER\\ klasörü) silinebilir.");

    /// <summary>A task of ours back as the form's values (null: it has a shape the form cannot show).</summary>
    public static LocalTaskSpec? SpecFrom(LocalTask t)
    {
        if (!t.IsOurs || t.Actions.Count != 1 || t.Actions[0].Kind != "Exec" || t.Triggers.Count != 1) return null;
        var a = t.Actions[0];
        var tr = t.Triggers[0];
        var time = tr.Start?.ToString("HH:mm", CultureInfo.InvariantCulture) ?? "09:00";
        var schedule = tr.Kind switch
        {
            "TimeTrigger" => "once",
            "LogonTrigger" => "logon",
            "CalendarTrigger" when tr.Schedule == "daily" && tr.Interval == 1 => "daily",
            "CalendarTrigger" when tr.Schedule == "weekly" && tr.Interval == 1 => "weekly",
            _ => null,
        };
        if (schedule is null) return null;
        return new LocalTaskSpec(t.Name, a.Command.Trim('"'), a.Arguments ?? "", schedule, time, tr.Days);
    }

    /// <summary>A command as the confirmation shows it (exactly what runs).</summary>
    public static string CommandLine(string program, IEnumerable<string> args) =>
        program + " " + string.Join(" ", args.Select(a => a.Length == 0 || a.Any(c => c is ' ' or '"') ? "\"" + a.Replace("\"", "\\\"") + "\"" : a));

    // ---- history (Microsoft-Windows-TaskScheduler/Operational) ----

    /// <summary>wevtutil arguments for the last <paramref name="count"/> events of a task (null: a path the query cannot hold).</summary>
    public static List<string>? HistoryQuery(string path, int count = 30)
    {
        if (path.IndexOfAny(['\'', '"', '<', '>', '&', ']', '[']) >= 0) return null;
        return ["qe", "Microsoft-Windows-TaskScheduler/Operational", $"/q:*[EventData[Data[@Name='TaskName']='{path}']]", $"/c:{count}", "/rd:true", "/f:xml"];
    }

    /// <summary>The events wevtutil printed (one &lt;Event&gt; after another), newest first.</summary>
    public static List<LocalTaskEvent> ParseHistory(string xml)
    {
        var list = new List<LocalTaskEvent>();
        if (string.IsNullOrWhiteSpace(xml)) return list;
        XElement root;
        try { root = XElement.Parse("<Events>" + xml + "</Events>"); }
        catch (XmlException) { return list; }
        foreach (var e in root.Elements().Where(x => x.Name.LocalName == "Event"))
        {
            var system = El(e, "System");
            if (!int.TryParse(Child(system, "EventID"), out var id)) continue;
            DateTime? at = null;
            var created = El(system, "TimeCreated")?.Attribute("SystemTime")?.Value;
            if (created is not null && DateTime.TryParse(created, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t)) at = t;
            int? result = null;
            foreach (var d in El(e, "EventData")?.Elements() ?? [])
            {
                var name = d.Attribute("Name")?.Value;
                if (name is "ResultCode" or "ActionResult" && int.TryParse(d.Value.Trim(), out var r)) result = r;
            }
            list.Add(new LocalTaskEvent(at, id, EventText(id), result));
        }
        return list.OrderByDescending(x => x.At).ToList();
    }

    public static string EventText(int id) => id switch
    {
        100 => L.T("Görev başladı"),
        101 => L.T("Görev başlatılamadı"),
        102 => L.T("Görev tamamlandı"),
        103 => L.T("Eylem başlatılamadı"),
        106 => L.T("Görev kaydedildi"),
        107 => L.T("Zamanlayıcı tetikledi"),
        108 => L.T("Olay tetikledi"),
        110 => L.T("Elle çalıştırıldı"),
        111 => L.T("Görev sonlandırıldı"),
        119 => L.T("Oturum açılınca tetiklendi"),
        129 => L.T("Program başlatıldı"),
        140 => L.T("Görev güncellendi"),
        141 => L.T("Görev silindi"),
        142 => L.T("Görev devre dışı bırakıldı"),
        200 => L.T("Eylem başladı"),
        201 => L.T("Eylem tamamlandı"),
        202 => L.T("Eylem başarısız oldu"),
        322 => L.T("Görev zaten çalıştığı için başlatılmadı"),
        _ => L.F("Olay {0}", id),
    };
}
