using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Wecommander.Center.Core;

// ---- WECOMMANDER's own scheduled tasks (stored on the server, not the OS task scheduler) ----

/// <summary>Where a task runs: an agent device, or a saved SSH host run by the Center that saved it.</summary>
public sealed class TaskTarget
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "device";
    [JsonPropertyName("deviceId")] public string? DeviceId { get; set; }
    [JsonPropertyName("centerId")] public string? CenterId { get; set; }
    [JsonPropertyName("hostId")] public string? HostId { get; set; }
    [JsonPropertyName("hostLabel")] public string? HostLabel { get; set; }

    public bool IsSsh => Kind == "ssh";

    public static TaskTarget Device(string deviceId) => new() { Kind = "device", DeviceId = deviceId };
    public static TaskTarget Ssh(string centerId, string hostId, string hostLabel) =>
        new() { Kind = "ssh", CenterId = centerId, HostId = hostId, HostLabel = hostLabel };

    public JsonObject ToJson() => IsSsh
        ? new JsonObject { ["kind"] = "ssh", ["centerId"] = CenterId, ["hostId"] = HostId, ["hostLabel"] = HostLabel }
        : new JsonObject { ["kind"] = "device", ["deviceId"] = DeviceId };

    public bool SameAs(TaskTarget? other) => other is not null && other.Kind == Kind &&
        (IsSsh ? other.CenterId == CenterId && other.HostId == HostId : other.DeviceId == DeviceId);
}

/// <summary>When a task runs: cron (5 fields), every N minutes, or once.</summary>
public sealed class TaskSchedule
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "cron";
    [JsonPropertyName("expr")] public string? Expr { get; set; }
    [JsonPropertyName("minutes")] public int? Minutes { get; set; }
    [JsonPropertyName("at")] public DateTimeOffset? At { get; set; }

    public static TaskSchedule Cron(string expr) => new() { Kind = "cron", Expr = expr.Trim() };
    public static TaskSchedule Interval(int minutes) => new() { Kind = "interval", Minutes = minutes };
    public static TaskSchedule Once(DateTimeOffset at) => new() { Kind = "once", At = at };
    /// <summary>Every day at <paramref name="time"/> (in the task's time zone).</summary>
    public static TaskSchedule Daily(TimeSpan time) => Cron($"{time.Minutes} {time.Hours} * * *");
    /// <summary>Every week on <paramref name="day"/> at <paramref name="time"/>.</summary>
    public static TaskSchedule Weekly(DayOfWeek day, TimeSpan time) => Cron($"{time.Minutes} {time.Hours} * * {(int)day}");

    public JsonObject ToJson() => Kind switch
    {
        "interval" => new JsonObject { ["kind"] = "interval", ["minutes"] = Minutes },
        "once" => new JsonObject { ["kind"] = "once", ["at"] = At?.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture) },
        _ => new JsonObject { ["kind"] = "cron", ["expr"] = Expr },
    };
}

/// <summary>One run of a task.</summary>
public sealed class TaskRun
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("taskId")] public string TaskId { get; set; } = "";
    [JsonPropertyName("scheduledFor")] public DateTimeOffset? ScheduledFor { get; set; }
    [JsonPropertyName("startedAt")] public DateTimeOffset? StartedAt { get; set; }
    [JsonPropertyName("finishedAt")] public DateTimeOffset? FinishedAt { get; set; }
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("exitCode")] public int? ExitCode { get; set; }
    [JsonPropertyName("output")] public string? Output { get; set; }
    [JsonPropertyName("runner")] public string? Runner { get; set; }
    [JsonPropertyName("trigger")] public string? Trigger { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

public sealed class ScheduledTask
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("target")] public TaskTarget Target { get; set; } = new();
    [JsonPropertyName("command")] public string Command { get; set; } = "";
    [JsonPropertyName("schedule")] public TaskSchedule Schedule { get; set; } = new();
    [JsonPropertyName("timezone")] public string? Timezone { get; set; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("timeoutSec")] public int TimeoutSec { get; set; } = ScheduledTaskDraft.DefaultTimeout;
    [JsonPropertyName("notify")] public string Notify { get; set; } = "failure";
    [JsonPropertyName("createdBy")] public string? CreatedBy { get; set; }
    [JsonPropertyName("createdAt")] public DateTimeOffset? CreatedAt { get; set; }
    [JsonPropertyName("updatedAt")] public DateTimeOffset? UpdatedAt { get; set; }
    [JsonPropertyName("nextRunAt")] public DateTimeOffset? NextRunAt { get; set; }
    [JsonPropertyName("lastRun")] public TaskRun? LastRun { get; set; }
}

/// <summary>A queued SSH run this Center claimed (GET /api/center/scheduled-runs/claim).</summary>
public sealed class ClaimedRun
{
    [JsonPropertyName("run")] public TaskRun Run { get; set; } = new();
    [JsonPropertyName("task")] public ScheduledTask Task { get; set; } = new();
}

/// <summary>What the Center reports for a run it executed.</summary>
public sealed record ScheduledRunResult(string Status, int? ExitCode, string Output, string? Error)
{
    /// <summary>Succeeded only when the command ran to the end with exit code 0.</summary>
    public static ScheduledRunResult From(RemoteExecResult r)
    {
        var ok = r.Error is null && !r.TimedOut && r.ExitCode == 0;
        return new ScheduledRunResult(ok ? "succeeded" : "failed", r.ExitCode, RunOutput.Cap(r.Output), r.Error);
    }

    public static ScheduledRunResult Failed(string error) => new("failed", null, "", error);

    public JsonObject ToJson()
    {
        var o = new JsonObject { ["status"] = Status, ["exitCode"] = ExitCode, ["output"] = Output };
        if (Error is not null) o["error"] = Error;
        return o;
    }
}

/// <summary>A command's result on a remote host: exit code (null when it never finished), its combined output and why it failed.</summary>
public sealed record RemoteExecResult(int? ExitCode, string Output, string? Error, bool TimedOut = false);

/// <summary>Runs one command on a saved SSH host without a terminal window (the app does it through wecommander-core).</summary>
public interface IRemoteExecutor
{
    Task<RemoteExecResult> RunAsync(string hostId, string command, TimeSpan timeout, CancellationToken ct);
}

/// <summary>The two Center calls of the runner (claim, result).</summary>
public interface IScheduledRunTransport
{
    Task<List<ClaimedRun>> ClaimAsync(CancellationToken ct);
    Task PostResultAsync(string runId, ScheduledRunResult result, CancellationToken ct);
}

public sealed class GatewayRunTransport(GatewayClient gateway, string token) : IScheduledRunTransport
{
    public Task<List<ClaimedRun>> ClaimAsync(CancellationToken ct) => gateway.ClaimScheduledRunsAsync(token, ct);
    public Task PostResultAsync(string runId, ScheduledRunResult result, CancellationToken ct) => gateway.PostScheduledRunResultAsync(token, runId, result, ct);
}

/// <summary>The task fields the create/edit dialog fills in.</summary>
public sealed class ScheduledTaskDraft
{
    public const int DefaultTimeout = 600;
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public TaskTarget? Target { get; set; }
    public string Command { get; set; } = "";
    public TaskSchedule Schedule { get; set; } = TaskSchedule.Daily(new TimeSpan(3, 0, 0));
    public string Timezone { get; set; } = ScheduleText.DefaultTimeZone();
    public bool Enabled { get; set; } = true;
    public int TimeoutSec { get; set; } = DefaultTimeout;
    public string Notify { get; set; } = "failure";

    public static ScheduledTaskDraft From(ScheduledTask t) => new()
    {
        Name = t.Name,
        Description = t.Description,
        Target = t.Target,
        Command = t.Command,
        Schedule = t.Schedule,
        Timezone = string.IsNullOrWhiteSpace(t.Timezone) ? ScheduleText.DefaultTimeZone() : t.Timezone!,
        Enabled = t.Enabled,
        TimeoutSec = t.TimeoutSec,
        Notify = t.Notify,
    };

    /// <summary>Why the draft cannot be saved (null: it can).</summary>
    public string? Validate(DateTimeOffset now)
    {
        var name = Name.Trim();
        if (name.Length is < 1 or > 80) return L.T("Ad 1 ile 80 karakter arasında olmalı.");
        if (Target is null) return L.T("Görevin çalışacağı hedefi seç.");
        if (Command.Trim().Length == 0) return L.T("Çalıştırılacak komutu yaz.");
        if (Command.Length > 4000) return L.T("Komut en fazla 4000 karakter olabilir.");
        if (TimeoutSec is < 10 or > 3600) return L.T("Zaman aşımı 10 ile 3600 saniye arasında olmalı.");
        if (Notify is not ("failure" or "always" or "never")) return L.T("Bildirim seçimi geçersiz.");
        switch (Schedule.Kind)
        {
            case "interval" when Schedule.Minutes is not (>= 5 and <= 10080):
                return L.T("Aralık 5 ile 10080 dakika arasında olmalı.");
            case "once" when Schedule.At is not { } at || at <= now:
                return L.T("Tek seferlik çalışma zamanı gelecekte olmalı.");
            case "cron" when !Cron.LooksValid(Schedule.Expr):
                return L.T("Cron ifadesi beş alandan oluşmalı (dakika saat gün ay haftanın günü).");
        }
        return null;
    }

    /// <summary>The POST /api/scheduled-tasks body (PATCH takes the same fields).</summary>
    public JsonObject ToJson() => new()
    {
        ["name"] = Name.Trim(),
        ["description"] = string.IsNullOrWhiteSpace(Description) ? null : Description.Trim(),
        ["target"] = Target?.ToJson(),
        ["command"] = Command,
        ["schedule"] = Schedule.ToJson(),
        ["timezone"] = Timezone,
        ["enabled"] = Enabled,
        ["timeoutSec"] = TimeoutSec,
        ["notify"] = Notify,
    };
}

public static class Cron
{
    private static readonly Regex Field = new(@"^[\d*/,\-A-Za-z?]+$", RegexOptions.Compiled);

    /// <summary>A quick shape check (five fields); the server validates fully and the preview shows its message.</summary>
    public static bool LooksValid(string? expr)
    {
        if (string.IsNullOrWhiteSpace(expr)) return false;
        var parts = expr.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 5 && parts.All(p => Field.IsMatch(p));
    }
}

/// <summary>Schedules in words, run statuses and time zones for the scheduled tasks page.</summary>
public static class ScheduleText
{
    private static readonly Regex Number = new(@"^\d{1,2}$", RegexOptions.Compiled);

    /// <summary>The day name used in "Her {0} saat {1}" (0 = Sunday, as in cron).</summary>
    public static string Day(DayOfWeek day) => day switch
    {
        DayOfWeek.Monday => L.T("pazartesi"),
        DayOfWeek.Tuesday => L.T("salı"),
        DayOfWeek.Wednesday => L.T("çarşamba"),
        DayOfWeek.Thursday => L.T("perşembe"),
        DayOfWeek.Friday => L.T("cuma"),
        DayOfWeek.Saturday => L.T("cumartesi"),
        _ => L.T("pazar"),
    };

    /// <summary>Days in the week picker order (Monday first).</summary>
    public static readonly DayOfWeek[] WeekOrder =
        [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday, DayOfWeek.Saturday, DayOfWeek.Sunday];

    private static string Clock(int hour, int minute) => $"{hour:00}:{minute:00}";

    /// <summary>"Her gün saat 03:00", "Her 15 dakikada bir", "Bir kez: 20.11.2026 09:00"; anything else as the cron text.</summary>
    public static string Describe(TaskSchedule s, TimeZoneInfo? local = null)
    {
        switch (s.Kind)
        {
            case "interval":
                var m = s.Minutes ?? 0;
                if (m >= 60 && m % 1440 == 0) return L.F("Her {0} günde bir", m / 1440);
                if (m >= 60 && m % 60 == 0) return L.F("Her {0} saatte bir", m / 60);
                return L.F("Her {0} dakikada bir", m);
            case "once":
                return s.At is { } at
                    ? L.F("Bir kez: {0}", TimeZoneInfo.ConvertTime(at, local ?? TimeZoneInfo.Local).ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture))
                    : L.T("Bir kez");
        }
        var expr = (s.Expr ?? "").Trim();
        var f = expr.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (f.Length != 5) return L.F("Gelişmiş (cron): {0}", expr);
        var fixedTime = Number.IsMatch(f[0]) && Number.IsMatch(f[1]) && int.Parse(f[0]) < 60 && int.Parse(f[1]) < 24;
        if (fixedTime && f[3] == "*")
        {
            var time = Clock(int.Parse(f[1]), int.Parse(f[0]));
            if (f[2] == "*" && f[4] == "*") return L.F("Her gün saat {0}", time);
            if (f[2] == "*" && f[4] is "1-5") return L.F("Hafta içi her gün saat {0}", time);
            if (f[2] == "*" && f[4] is "0,6" or "6,0") return L.F("Hafta sonu her gün saat {0}", time);
            if (f[2] == "*" && Number.IsMatch(f[4]) && int.Parse(f[4]) <= 7) return L.F("Her {0} saat {1}", Day((DayOfWeek)(int.Parse(f[4]) % 7)), time);
            if (f[4] == "*" && Number.IsMatch(f[2]) && int.Parse(f[2]) is >= 1 and <= 31) return L.F("Her ayın {0}. günü saat {1}", int.Parse(f[2]), time);
        }
        if (f[1] == "*" && f[2] == "*" && f[3] == "*" && f[4] == "*")
        {
            if (f[0].StartsWith("*/", StringComparison.Ordinal) && int.TryParse(f[0][2..], out var every) && every > 0) return L.F("Her {0} dakikada bir", every);
            if (Number.IsMatch(f[0]) && int.Parse(f[0]) < 60) return L.F("Her saat, {0}. dakikada", int.Parse(f[0]));
        }
        return L.F("Gelişmiş (cron): {0}", expr);
    }

    /// <summary>The badge text for a run status.</summary>
    public static string Status(string? status) => status switch
    {
        "succeeded" => L.T("Başarılı"),
        "failed" => L.T("Başarısız"),
        "missed" => L.T("Kaçırıldı"),
        "running" => L.T("Çalışıyor"),
        "queued" => L.T("Sırada"),
        "skipped" => L.T("Atlandı"),
        "cancelled" => L.T("İptal edildi"),
        null or "" => L.T("Henüz çalışmadı"),
        _ => status,
    };

    /// <summary>Badge colour family: good, bad, warn, busy or none.</summary>
    public static string Tone(string? status) => status switch
    {
        "succeeded" => "good",
        "failed" => "bad",
        "missed" or "skipped" or "cancelled" => "warn",
        "running" or "queued" => "busy",
        _ => "none",
    };

    public static string NotifyLabel(string notify) => notify switch
    {
        "always" => L.T("Her çalışmada bildir"),
        "never" => L.T("Bildirme"),
        _ => L.T("Yalnız başarısız olunca bildir"),
    };

    public static readonly string[] NotifyValues = ["failure", "always", "never"];

    /// <summary>This computer's IANA time zone (the server needs IANA names); Europe/Istanbul when it has none.</summary>
    public static string DefaultTimeZone() => IanaName(TimeZoneInfo.Local) ?? "Europe/Istanbul";

    public static string? IanaName(TimeZoneInfo zone)
    {
        if (zone.HasIanaId) return zone.Id;
        return TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana) ? iana : null;
    }

    /// <summary>"20.11 03:00" in this computer's time; "—" when none.</summary>
    public static string LocalTime(DateTimeOffset? at, TimeZoneInfo? local = null) => at is { } t
        ? TimeZoneInfo.ConvertTime(t, local ?? TimeZoneInfo.Local).ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture)
        : "—";

    /// <summary>The form's fields for an existing schedule (mode 0 daily, 1 weekly, 2 interval, 3 once, 4 cron).</summary>
    public static (int Mode, TimeSpan Time, DayOfWeek Day, int Minutes, DateTimeOffset? At, string Expr) Form(TaskSchedule s)
    {
        var defaultTime = new TimeSpan(3, 0, 0);
        switch (s.Kind)
        {
            case "interval": return (2, defaultTime, DayOfWeek.Monday, s.Minutes ?? 60, null, "");
            case "once": return (3, defaultTime, DayOfWeek.Monday, 60, s.At, "");
        }
        var expr = (s.Expr ?? "").Trim();
        var f = expr.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (f.Length == 5 && Number.IsMatch(f[0]) && Number.IsMatch(f[1]) && f[2] == "*" && f[3] == "*"
            && int.Parse(f[0]) < 60 && int.Parse(f[1]) < 24)
        {
            var time = new TimeSpan(int.Parse(f[1]), int.Parse(f[0]), 0);
            if (f[4] == "*") return (0, time, DayOfWeek.Monday, 60, null, expr);
            if (Number.IsMatch(f[4]) && int.Parse(f[4]) <= 7) return (1, time, (DayOfWeek)(int.Parse(f[4]) % 7), 60, null, expr);
        }
        return (4, defaultTime, DayOfWeek.Monday, 60, null, expr);
    }
}

/// <summary>Output kept for a run: at most 64 KiB of UTF-8, the end kept (the error is usually last).</summary>
public static class RunOutput
{
    public const int MaxBytes = 64 * 1024;
    private static readonly Regex Ansi = new(@"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])", RegexOptions.Compiled);

    public static string Cap(string text, int maxBytes = MaxBytes)
    {
        if (Encoding.UTF8.GetByteCount(text) <= maxBytes) return text;
        const string marker = "…\n";
        var budget = maxBytes - Encoding.UTF8.GetByteCount(marker);
        // Walk back from the end until the budget is used (never splitting a surrogate pair).
        var used = 0;
        var start = text.Length;
        while (start > 0)
        {
            var step = start >= 2 && char.IsLowSurrogate(text[start - 1]) && char.IsHighSurrogate(text[start - 2]) ? 2 : 1;
            var bytes = Encoding.UTF8.GetByteCount(text.AsSpan(start - step, step));
            if (used + bytes > budget) break;
            used += bytes;
            start -= step;
        }
        return marker + text[start..];
    }

    /// <summary>Terminal output as plain text: colour and cursor codes removed, CRLF as LF.</summary>
    public static string Plain(string text) =>
        Ansi.Replace(text, "").Replace("\r\n", "\n").Replace('\r', '\n');
}

/// <summary>
/// One command run through a login shell (wecommander-core has no plain
/// "exec" call): the typed line replaces the shell with <c>sh -c</c>, prints a
/// begin marker, runs the command with stdin closed and prints an end marker
/// with the exit code. The markers are built by printf from two words, so the
/// shell's echo of the typed line never contains them.
/// </summary>
public sealed class MarkedCommand
{
    private const string Begin = "__WC_B_";
    private const string End = "__WC_E_";
    /// <summary>Raw text kept before the begin marker shows up, and around the body (the end is kept).</summary>
    private const int PreambleLimit = 16 * 1024;
    private const int BodyLimit = 512 * 1024;

    private readonly Decoder _decoder = new UTF8Encoding(false).GetDecoder();
    private readonly StringBuilder _pre = new();
    private readonly StringBuilder _body = new();
    private readonly Regex _end;
    private bool _begun, _trimmed;

    public string Nonce { get; }
    public bool Finished { get; private set; }
    public int? ExitCode { get; private set; }

    public MarkedCommand(string? nonce = null)
    {
        Nonce = nonce ?? Guid.NewGuid().ToString("N")[..12];
        _end = new Regex(@"(?:\r?\n)?" + Regex.Escape(End + Nonce) + @"_(\d+)", RegexOptions.Compiled);
    }

    /// <summary>Single quotes for POSIX shells (also fine in bash, zsh and fish).</summary>
    public static string Quote(string text) => "'" + text.Replace("'", "'\\''") + "'";

    /// <summary>The line typed into the shell (ends with Enter).</summary>
    public string Line(string command)
    {
        var body = command.Replace("\r\n", "\n").Replace('\r', '\n');
        var script = $"printf '\\n%s%s\\n' {Begin} {Nonce}; ( {body}\n) </dev/null 2>&1; printf '\\n%s%s_%s\\n' {End} {Nonce} $?";
        return " exec sh -c " + Quote(script) + "\r";
    }

    public void Append(byte[] bytes)
    {
        var chars = new char[_decoder.GetCharCount(bytes, 0, bytes.Length)];
        _decoder.GetChars(bytes, 0, bytes.Length, chars, 0);
        Append(new string(chars));
    }

    public void Append(string text)
    {
        if (Finished) return;
        if (!_begun)
        {
            _pre.Append(text);
            var all = _pre.ToString();
            var i = all.IndexOf(Begin + Nonce, StringComparison.Ordinal);
            if (i < 0)
            {
                if (_pre.Length > PreambleLimit) _pre.Remove(0, _pre.Length - PreambleLimit);
                return;
            }
            _begun = true;
            var rest = all[(i + Begin.Length + Nonce.Length)..];
            // The newline printed after the marker.
            if (rest.StartsWith("\r\n", StringComparison.Ordinal)) rest = rest[2..];
            else if (rest.StartsWith('\n')) rest = rest[1..];
            _pre.Clear();
            text = rest;
        }
        _body.Append(text);
        var body = _body.ToString();
        var m = _end.Match(body);
        if (m.Success && body.IndexOf('\n', m.Index + m.Length) is var nl && (nl >= 0 || body.Length > m.Index + m.Length))
        {
            ExitCode = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            _body.Length = m.Index;
            Finished = true;
            return;
        }
        if (_body.Length > BodyLimit)
        {
            _body.Remove(0, _body.Length - BodyLimit / 2);
            _trimmed = true;
        }
    }

    /// <summary>The shell ended: an end marker at the very end of the output still counts.</summary>
    public void Close()
    {
        if (Finished || !_begun) return;
        var body = _body.ToString();
        var m = _end.Match(body);
        if (!m.Success) return;
        ExitCode = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        _body.Length = m.Index;
        Finished = true;
    }

    /// <summary>Whether the command started (its begin marker was seen).</summary>
    public bool Started => _begun;

    /// <summary>The command's own output so far, as plain text (capped, end kept).</summary>
    public string Output => RunOutput.Cap((_trimmed ? "…\n" : "") + RunOutput.Plain(_body.ToString()));
}

/// <summary>
/// The Center side of scheduled tasks on saved SSH hosts: claims queued runs,
/// runs each on its host and reports the result. Never throws to its caller;
/// problems go to <c>log</c>.
/// </summary>
public sealed class ScheduledRunner(IRemoteExecutor executor, Action<Exception>? log = null)
{
    public static readonly TimeSpan PollEvery = TimeSpan.FromSeconds(30);
    private readonly Dictionary<string, Task> _active = [];
    private readonly object _gate = new();
    private int _polling;

    /// <summary>Runs going on now.</summary>
    public int Active { get { lock (_gate) return _active.Count; } }

    /// <summary>Claims once and starts every claimed run in the background; returns how many started.</summary>
    public async Task<int> PollOnceAsync(IScheduledRunTransport transport, CancellationToken ct = default)
    {
        if (Interlocked.Exchange(ref _polling, 1) == 1) return 0;
        try
        {
            List<ClaimedRun> items;
            try { items = await transport.ClaimAsync(ct).ConfigureAwait(false); }
            catch (GatewayException) { return 0; } // offline, signed out or an older server: next poll tries again
            var started = 0;
            foreach (var item in items)
            {
                var id = item.Run.Id;
                if (string.IsNullOrEmpty(id)) continue;
                lock (_gate)
                {
                    if (_active.ContainsKey(id)) continue;
                    var task = Task.Run(() => RunOneAsync(transport, item, ct), CancellationToken.None);
                    _active[id] = task;
                    _ = task.ContinueWith(_ => { lock (_gate) _active.Remove(id); }, TaskScheduler.Default);
                }
                started++;
            }
            return started;
        }
        catch (Exception e) { log?.Invoke(e); return 0; }
        finally { Interlocked.Exchange(ref _polling, 0); }
    }

    /// <summary>Waits for the runs going on now (tests, sign-out).</summary>
    public Task WhenIdle()
    {
        lock (_gate) return Task.WhenAll(_active.Values.ToArray());
    }

    private async Task RunOneAsync(IScheduledRunTransport transport, ClaimedRun item, CancellationToken ct)
    {
        ScheduledRunResult result;
        try
        {
            var task = item.Task;
            if (!task.Target.IsSsh || string.IsNullOrEmpty(task.Target.HostId))
                result = ScheduledRunResult.Failed(L.T("Bu çalışma bir SSH sunucusu için değil; Yönetim Merkezi çalıştırmadı."));
            else
            {
                var timeout = TimeSpan.FromSeconds(Math.Clamp(task.TimeoutSec, 10, 3600));
                result = ScheduledRunResult.From(await executor.RunAsync(task.Target.HostId!, task.Command, timeout, ct).ConfigureAwait(false));
            }
        }
        catch (Exception e)
        {
            log?.Invoke(e);
            result = ScheduledRunResult.Failed(L.T("Komut çalıştırılamadı: ") + e.Message);
        }
        // The result matters (otherwise the run stays "running" until its lease ends): a few tries.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                await transport.PostResultAsync(item.Run.Id, result, ct).ConfigureAwait(false);
                return;
            }
            catch (GatewayException e) when (e.Kind == GatewayErrorKind.Network)
            {
                if (attempt == 2) return;
                try { await Task.Delay(TimeSpan.FromSeconds(attempt == 0 ? 2 : 10), ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
            }
            catch (GatewayException) { return; } // refused (run no longer ours, signed out): nothing to retry
            catch (Exception e)
            {
                log?.Invoke(e);
                return;
            }
        }
    }
}
