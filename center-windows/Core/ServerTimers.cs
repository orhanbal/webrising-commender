using System.Text;

namespace Wecommander.Center.Core;

// Scheduled tasks on a server (server.timers and friends in the core):
// systemd timers, disabled ones included, and cron read only.

/// <summary>What WECOMMANDER wrote into a timer it created: the form's fields.</summary>
public sealed record ManagedTimer(string Name, string Description, string Command, string User, string Calendar);

/// <summary>One systemd timer and the service it starts. Times are unix seconds.</summary>
public sealed record ServerTimer(
    string Unit, string Scope, string Description, string UnitFileState, string ActiveState, string SubState,
    List<string> Calendar, List<string> Monotonic, string Schedule, long? NextRun, long? LastRun,
    string Service, string ServiceDescription, string Command, string User, string Result, int? ExitStatus, long? LastExit,
    string ServiceState, string FragmentPath, bool Persistent, ManagedTimer? Managed = null)
{
    public bool IsSystem => Scope != "user";
    public bool IsManaged => Managed is not null;
    public bool IsActive => ActiveState == "active";
    public bool IsEnabled => UnitFileState is "enabled" or "enabled-runtime" or "linked" or "linked-runtime" or "alias";
    public bool IsMasked => UnitFileState.StartsWith("masked", StringComparison.Ordinal);
    public bool IsStatic => UnitFileState is "static" or "generated" or "transient" or "indirect";
}

/// <summary>One cron line, or a script in /etc/cron.daily and the like (schedule "daily").</summary>
public sealed record CronEntry(string Source, string Schedule, string User, string Command)
{
    /// <summary>A file in /etc/cron.d this user may not read.</summary>
    public bool Unreadable => Schedule.Length == 0 && Command.Length == 0;
}

/// <param name="Crontab">The login user's crontab: ok, empty, not-readable, missing.</param>
public sealed record ServerTimers(string Privilege, string LoginUser, bool Systemd, List<ServerTimer> Timers, List<CronEntry> Cron,
    string Crontab, string CrontabMessage)
{
    public bool CanChange => Privilege is "root" or "sudo";
}

/// <summary>What a change did: the exact commands that ran and their output.</summary>
public sealed record TimerResult(string Command, bool Ok, string Output);
public sealed record TimerLogs(string Command, List<string> Lines, string Note);

/// <summary>The create / edit form.</summary>
public sealed record TimerSpec(string Name, string Description, string Command, string User, string Calendar);

/// <summary>What the timers page shows, the checks of its form, and the commands it confirms (the same the core runs).</summary>
public static class TimerView
{
    public const string ManagedMark = "# Managed by WECOMMANDER";
    private const string UnitDir = "/etc/systemd/system";

    /// <summary>active, passive, failed or masked: the badge.</summary>
    public static string State(ServerTimer t) =>
        t.IsMasked ? "masked" : t.ActiveState == "failed" ? "failed" : t.IsActive ? "active" : "passive";

    public static string StateText(ServerTimer t) => State(t) switch
    {
        "active" => L.T("Etkin"),
        "failed" => L.T("Hatalı"),
        "masked" => L.T("Maskeli"),
        _ => L.T("Pasif"),
    };

    /// <summary>Enable is offered unless it is enabled and running already (never for masked or static ones).</summary>
    public static bool CanEnable(ServerTimer t) => t.IsSystem && !t.IsMasked && !t.IsStatic && !(t.IsEnabled && t.IsActive);
    public static bool CanDisable(ServerTimer t) => t.IsSystem && !t.IsMasked && (t.IsEnabled || t.IsActive);
    public static bool CanRunNow(ServerTimer t) => t.IsSystem && !t.IsMasked;
    public static bool CanStop(ServerTimer t) => t.IsSystem && t.ServiceState is "active" or "activating" or "reloading";

    /// <summary>The schedule in words: calendar expressions as they are, monotonic ones explained.</summary>
    public static string Schedule(ServerTimer t)
    {
        var parts = new List<string>();
        parts.AddRange(t.Calendar);
        foreach (var m in t.Monotonic)
        {
            var eq = m.IndexOf('=');
            if (eq < 0) { parts.Add(m); continue; }
            var (key, value) = (m[..eq], m[(eq + 1)..]);
            parts.Add(key switch
            {
                "OnBootUSec" => L.F("açılıştan {0} sonra", value),
                "OnStartupUSec" => L.F("systemd başladıktan {0} sonra", value),
                "OnActiveUSec" => L.F("zamanlayıcı başladıktan {0} sonra", value),
                "OnUnitActiveUSec" => L.F("son başlangıçtan {0} sonra", value),
                "OnUnitInactiveUSec" => L.F("son çalışma bitince {0} sonra", value),
                _ => m,
            });
        }
        return parts.Count == 0 ? (t.Schedule.Length > 0 ? t.Schedule : "—") : string.Join(" · ", parts);
    }

    /// <summary>A unix time in local time ("17.11.2026 14:30"); "—" for never.</summary>
    public static string Time(long? unix, TimeZoneInfo? zone = null)
    {
        if (unix is not { } u || u <= 0) return "—";
        var local = TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeSeconds(u), zone ?? TimeZoneInfo.Local);
        return local.ToString("g", L.Culture);
    }

    /// <summary>"in 2 h 5 min" / "3 min ago" next to a time.</summary>
    public static string Relative(long? unix, DateTimeOffset now)
    {
        if (unix is not { } u || u <= 0) return "";
        var diff = u - now.ToUnixTimeSeconds();
        return diff >= 0 ? L.F("{0} sonra", Sizes.Duration((ulong)diff)) : L.F("{0} önce", Sizes.Duration((ulong)(-diff)));
    }

    /// <summary>The last run's result: "success", "exit-code (1)".</summary>
    public static string Result(ServerTimer t)
    {
        if (string.IsNullOrEmpty(t.Result)) return "—";
        return t.ExitStatus is { } code && (code != 0 || t.Result != "success") ? $"{t.Result} ({code})" : t.Result;
    }

    /// <summary>System timers first, then the login user's; by name.</summary>
    public static List<ServerTimer> Ordered(IEnumerable<ServerTimer> timers, string filter = "")
    {
        var f = filter.Trim();
        return timers
            .Where(t => f.Length == 0 || t.Unit.Contains(f, StringComparison.OrdinalIgnoreCase) || t.Description.Contains(f, StringComparison.OrdinalIgnoreCase)
                || t.Command.Contains(f, StringComparison.OrdinalIgnoreCase) || t.User.Contains(f, StringComparison.OrdinalIgnoreCase))
            .OrderBy(t => t.IsSystem ? 0 : 1)
            .ThenBy(t => t.Unit, StringComparer.Ordinal)
            .ToList();
    }

    // ---- the form ----

    /// <summary>Why the form cannot be sent, or null (the core checks the same, and the calendar with systemd-analyze).</summary>
    public static string? Check(TimerSpec s)
    {
        var name = s.Name.Trim();
        if (name.Length is 0 or > 64 || !(char.IsAsciiLetterLower(name[0]) || char.IsAsciiDigit(name[0]))
            || !name.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '_' or '.' or '-')
            || name.EndsWith(".timer", StringComparison.Ordinal) || name.EndsWith(".service", StringComparison.Ordinal) || name.EndsWith('.'))
            return L.T("Ad geçersiz: küçük harf, rakam, nokta, alt çizgi ve tire kullanılabilir; harf ya da rakamla başlar, en çok 64 karakter.");
        var d = s.Description.Trim();
        if (d.Length > 200 || d.Any(char.IsControl) || d.EndsWith('\\'))
            return L.T("Açıklama tek satır olmalı (en çok 200 karakter).");
        var c = s.Command.Trim();
        if (c.Length is 0 or > 2000 || c.Any(char.IsControl))
            return L.T("Komut boş olamaz ve tek satır olmalı (en çok 2000 karakter).");
        var u = s.User.Trim();
        if (u.Length is 0 or > 32 || !(char.IsAsciiLetterLower(u[0]) || u[0] == '_') || !u.All(ch => char.IsAsciiLetterLower(ch) || char.IsAsciiDigit(ch) || ch is '_' or '-'))
            return L.T("Kullanıcı adı geçersiz.");
        var cal = s.Calendar.Trim();
        if (cal.Length is 0 or > 200 || cal.StartsWith('-') || !cal.All(ch => char.IsAsciiLetterOrDigit(ch) || " *-:,./~+_".Contains(ch)))
            return L.T("Takvim ifadesi geçersiz (örnek: daily, hourly, Mon *-*-* 03:00, *-*-* 04:30:00).");
        return null;
    }

    public static TimerSpec Trimmed(TimerSpec s) => new(s.Name.Trim(), s.Description.Trim(), s.Command.Trim(), s.User.Trim(), s.Calendar.Trim());

    // ---- commands (the same text the core runs and returns) ----

    public static string Quote(string s) => "'" + s.Replace("'", "'\\''") + "'";

    /// <summary>A unit as one shell word: plain when safe, else quoted.</summary>
    public static string Word(string unit) =>
        unit.All(c => char.IsAsciiLetterOrDigit(c) || c is '@' or '.' or '_' or ':' or '-') ? unit : Quote(unit);

    /// <summary>enable, disable, start-now (runs the service now), stop (stops the running service).</summary>
    public static string ActionCommand(ServerTimer t, string action) => action switch
    {
        "enable" => "systemctl enable --now " + Word(t.Unit),
        "disable" => "systemctl disable --now " + Word(t.Unit),
        "start-now" => "systemctl start --no-block " + Word(t.Service),
        "stop" => "systemctl stop " + Word(t.Service),
        _ => throw new ArgumentException("unknown action", nameof(action)),
    };

    public static string LogsCommand(ServerTimer t, int lines) => $"journalctl -u {Word(t.Service)} -n {lines} --no-pager -o short-iso";

    /// <summary>ExecStart= for a command: run by /bin/sh -c, escaped for systemd's quoting, $ and % specifiers.</summary>
    public static string ExecStart(string command)
    {
        var b = new StringBuilder("/bin/sh -c \"");
        foreach (var c in command)
            b.Append(c switch { '\\' => "\\\\", '"' => "\\\"", '$' => "$$", '%' => "%%", _ => c.ToString() });
        return b.Append('"').ToString();
    }

    public static string ServiceFile(TimerSpec s) =>
        $"{ManagedMark}\n[Unit]\nDescription={s.Description.Replace("%", "%%")}\n\n[Service]\nType=oneshot\nUser={s.User}\nExecStart={ExecStart(s.Command)}\n";

    public static string TimerFile(TimerSpec s) =>
        $"{ManagedMark}\n[Unit]\nDescription={s.Description.Replace("%", "%%")}\n\n[Timer]\nOnCalendar={s.Calendar}\nPersistent=true\nUnit={s.Name}.service\n\n[Install]\nWantedBy=timers.target\n";

    /// <summary>What a create (or edit) runs: write both files, reload, then enable --now (edit: try-restart).</summary>
    public static string WriteCommand(TimerSpec spec, bool edit)
    {
        var s = Trimmed(spec);
        var lines = new List<string>
        {
            $"printf '%s' {Quote(ServiceFile(s))} | tee {UnitDir}/{s.Name}.service >/dev/null",
            $"printf '%s' {Quote(TimerFile(s))} | tee {UnitDir}/{s.Name}.timer >/dev/null",
            "systemctl daemon-reload",
            edit ? $"systemctl try-restart {s.Name}.timer" : $"systemctl enable --now {s.Name}.timer",
        };
        return string.Join("\n", lines);
    }

    /// <summary>What deleting a WECOMMANDER timer runs.</summary>
    public static string DeleteCommand(string name) =>
        $"systemctl disable --now {name}.timer\nrm -f {UnitDir}/{name}.timer {UnitDir}/{name}.service\nsystemctl daemon-reload";

    /// <summary>The name of a WECOMMANDER timer, from its unit.</summary>
    public static string NameOf(ServerTimer t) => t.Managed?.Name ?? (t.Unit.EndsWith(".timer", StringComparison.Ordinal) ? t.Unit[..^6] : t.Unit);

    /// <summary>The crontab's state in words; empty when it was read.</summary>
    public static string CrontabNote(ServerTimers s) => s.Crontab switch
    {
        "empty" => L.F("{0} kullanıcısının crontab'ı boş.", s.LoginUser),
        "not-readable" => L.F("{0} kullanıcısının crontab'ı okunamadı (izin yok).", s.LoginUser),
        "missing" => L.T("Sunucuda crontab komutu yok."),
        _ => "",
    };
}
