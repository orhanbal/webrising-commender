using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Wecommander.Center.Core;
using Xunit;

public class ScheduledTasksTests
{
    private const string TaskId = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    private const string RunId = "11111111-2222-4333-8444-555555555555";

    private sealed class FakeHandler(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> respond) : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Url, string? Auth, string? Body)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Calls.Add((request.Method, request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(), body));
            var (status, json) = respond(request, body);
            return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }

    private static (GatewayClient, FakeHandler) Client(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> respond)
    {
        var handler = new FakeHandler(respond);
        return (new GatewayClient(new HttpClient(handler), "https://wecommander.app/"), handler);
    }

    private const string TaskJson = $$$"""
        {"id":"{{{TaskId}}}","name":"Yedek","target":{"kind":"ssh","centerId":"c1","hostId":"h1","hostLabel":"web-1"},
         "command":"/usr/local/bin/backup.sh","schedule":{"kind":"cron","expr":"0 3 * * *"},"timezone":"Europe/Istanbul",
         "enabled":true,"timeoutSec":900,"notify":"always","nextRunAt":"2026-11-18T00:00:00Z",
         "lastRun":{"id":"{{{RunId}}}","taskId":"{{{TaskId}}}","scheduledFor":"2026-11-17T00:00:00Z","status":"failed","exitCode":2,"runner":"center","trigger":"schedule"}}
        """;

    [Fact]
    public async Task ListsTasksWithTargetScheduleAndLastRun()
    {
        var (g, h) = Client((_, _) => (HttpStatusCode.OK, $$$"""{"items":[{{{TaskJson}}}]}"""));
        var items = await g.ScheduledTasksAsync("tok");
        Assert.Equal(("https://wecommander.app/api/scheduled-tasks", "Bearer tok"), (h.Calls[0].Url, h.Calls[0].Auth));
        var t = Assert.Single(items);
        Assert.True(t.Target.IsSsh);
        Assert.Equal(("c1", "h1", "web-1"), (t.Target.CenterId, t.Target.HostId, t.Target.HostLabel));
        Assert.Equal("0 3 * * *", t.Schedule.Expr);
        Assert.Equal(900, t.TimeoutSec);
        Assert.Equal(new DateTimeOffset(2026, 11, 18, 0, 0, 0, TimeSpan.Zero), t.NextRunAt);
        Assert.Equal(("failed", 2), (t.LastRun!.Status, t.LastRun.ExitCode));
    }

    [Fact]
    public async Task CreateUpdateDeleteRunAndRunsUseTheContractRoutes()
    {
        var (g, h) = Client((req, _) => req.RequestUri!.AbsolutePath switch
        {
            var p when p.EndsWith("/run") => (HttpStatusCode.OK, $$$"""{"run":{"id":"{{{RunId}}}","taskId":"{{{TaskId}}}","status":"queued","trigger":"manual"}}"""),
            var p when p.EndsWith("/runs") => (HttpStatusCode.OK, $$$"""{"items":[{"id":"{{{RunId}}}","taskId":"{{{TaskId}}}","status":"succeeded","exitCode":0,"output":"ok"}]}"""),
            _ when req.Method == HttpMethod.Delete => (HttpStatusCode.OK, """{"ok":true}"""),
            _ => (HttpStatusCode.OK, $$$"""{"item":{{{TaskJson}}}}"""),
        });
        var draft = new ScheduledTaskDraft
        {
            Name = "  Yedek ",
            Target = TaskTarget.Ssh("c1", "h1", "web-1"),
            Command = "/usr/local/bin/backup.sh",
            Schedule = TaskSchedule.Daily(new TimeSpan(3, 5, 0)),
            Timezone = "Europe/Istanbul",
            TimeoutSec = 900,
            Notify = "always",
        };
        var created = await g.CreateScheduledTaskAsync("tok", draft);
        Assert.Equal(TaskId, created.Id);
        var body = JsonNode.Parse(h.Calls[0].Body!)!;
        Assert.Equal(HttpMethod.Post, h.Calls[0].Method);
        Assert.Equal("Yedek", (string?)body["name"]);
        Assert.Equal("ssh", (string?)body["target"]!["kind"]);
        Assert.Equal("h1", (string?)body["target"]!["hostId"]);
        Assert.Equal("c1", (string?)body["target"]!["centerId"]);
        Assert.Equal("5 3 * * *", (string?)body["schedule"]!["expr"]);
        Assert.Equal(900, (int?)body["timeoutSec"]);
        Assert.Equal("always", (string?)body["notify"]);
        Assert.Equal(true, (bool?)body["enabled"]);

        await g.UpdateScheduledTaskAsync("tok", TaskId, new JsonObject { ["enabled"] = false });
        Assert.Equal(HttpMethod.Patch, h.Calls[1].Method);
        Assert.Equal($"https://wecommander.app/api/scheduled-tasks/{TaskId}", h.Calls[1].Url);
        Assert.Equal("""{"enabled":false}""", h.Calls[1].Body);

        var run = await g.RunScheduledTaskAsync("tok", TaskId);
        Assert.Equal(("queued", "manual"), (run.Status, run.Trigger));
        Assert.Equal($"https://wecommander.app/api/scheduled-tasks/{TaskId}/run", h.Calls[2].Url);

        var runs = await g.ScheduledTaskRunsAsync("tok", TaskId);
        Assert.Equal("ok", Assert.Single(runs).Output);
        Assert.Equal($"https://wecommander.app/api/scheduled-tasks/{TaskId}/runs?limit=50", h.Calls[3].Url);

        await g.DeleteScheduledTaskAsync("tok", TaskId);
        Assert.Equal(HttpMethod.Delete, h.Calls[4].Method);

        // An id that is not a uuid never reaches the URL.
        await Assert.ThrowsAsync<GatewayException>(() => g.DeleteScheduledTaskAsync("tok", "../devices"));
        Assert.Equal(5, h.Calls.Count);
    }

    [Fact]
    public async Task PreviewReturnsFiveTimesAndExplainsAnInvalidSchedule()
    {
        var (g, h) = Client((_, body) => body!.Contains("\"bad\"")
            ? (HttpStatusCode.BadRequest, """{"error":"invalid_schedule","message":"cron: expected 5 fields"}""")
            : (HttpStatusCode.OK, """{"next":["2026-11-18T00:00:00Z","2026-11-19T00:00:00Z","2026-11-20T00:00:00Z","2026-11-21T00:00:00Z","2026-11-22T00:00:00Z"]}"""));
        var next = await g.PreviewScheduleAsync("tok", TaskSchedule.Interval(30), "Europe/Istanbul");
        Assert.Equal(5, next.Count);
        var body = JsonNode.Parse(h.Calls[0].Body!)!;
        Assert.Equal("interval", (string?)body["schedule"]!["kind"]);
        Assert.Equal(30, (int?)body["schedule"]!["minutes"]);
        Assert.Equal("Europe/Istanbul", (string?)body["timezone"]);

        var e = await Assert.ThrowsAsync<GatewayException>(() => g.PreviewScheduleAsync("tok", TaskSchedule.Cron("bad"), "UTC"));
        Assert.Equal(400, e.Status);
        Assert.Equal("cron: expected 5 fields", e.ServerMessage);
    }

    [Fact]
    public async Task ViewerGetsAClearForbiddenMessage()
    {
        var (g, _) = Client((_, _) => (HttpStatusCode.Forbidden, """{"error":"forbidden"}"""));
        var e = await Assert.ThrowsAsync<GatewayException>(() => g.RunScheduledTaskAsync("tok", TaskId));
        Assert.Equal(403, e.Status);
        Assert.Contains("yönetici", e.Message);
    }

    [Fact]
    public async Task ClaimAndResultUseTheCenterRoutes()
    {
        var (g, h) = Client((req, _) => req.Method == HttpMethod.Get
            ? (HttpStatusCode.OK, $$$"""{"items":[{"run":{"id":"{{{RunId}}}","taskId":"{{{TaskId}}}","status":"running"},"task":{{{TaskJson}}}}]}""")
            : (HttpStatusCode.OK, """{"ok":true}"""));
        var claimed = Assert.Single(await g.ClaimScheduledRunsAsync("tok"));
        Assert.Equal(RunId, claimed.Run.Id);
        Assert.Equal("/usr/local/bin/backup.sh", claimed.Task.Command);
        Assert.Equal("https://wecommander.app/api/center/scheduled-runs/claim", h.Calls[0].Url);

        await g.PostScheduledRunResultAsync("tok", RunId, new ScheduledRunResult("failed", 1, "boom", "exit 1"));
        Assert.Equal($"https://wecommander.app/api/center/scheduled-runs/{RunId}/result", h.Calls[1].Url);
        var body = JsonNode.Parse(h.Calls[1].Body!)!;
        Assert.Equal(("failed", 1, "boom", "exit 1"), ((string?)body["status"], (int?)body["exitCode"], (string?)body["output"], (string?)body["error"]));
    }

    [Theory]
    [InlineData("0 3 * * *", "Her gün saat 03:00")]
    [InlineData("30 22 * * 1", "Her pazartesi saat 22:30")]
    [InlineData("0 9 * * 0", "Her pazar saat 09:00")]
    [InlineData("0 9 * * 7", "Her pazar saat 09:00")]
    [InlineData("15 8 * * 1-5", "Hafta içi her gün saat 08:15")]
    [InlineData("0 4 1 * *", "Her ayın 1. günü saat 04:00")]
    [InlineData("*/10 * * * *", "Her 10 dakikada bir")]
    [InlineData("5 * * * *", "Her saat, 5. dakikada")]
    [InlineData("0 0 1 1 *", "Gelişmiş (cron): 0 0 1 1 *")]
    [InlineData("0 3 * *", "Gelişmiş (cron): 0 3 * *")]
    public void CronSchedulesInWords(string expr, string expected)
    {
        Assert.Equal(expected, ScheduleText.Describe(TaskSchedule.Cron(expr)));
    }

    [Fact]
    public void IntervalAndOnceInWords()
    {
        Assert.Equal("Her 15 dakikada bir", ScheduleText.Describe(TaskSchedule.Interval(15)));
        Assert.Equal("Her 2 saatte bir", ScheduleText.Describe(TaskSchedule.Interval(120)));
        Assert.Equal("Her 1 günde bir", ScheduleText.Describe(TaskSchedule.Interval(1440)));
        Assert.Equal("Her 90 dakikada bir", ScheduleText.Describe(TaskSchedule.Interval(90)));
        var at = new DateTimeOffset(2026, 11, 20, 6, 0, 0, TimeSpan.Zero);
        Assert.Equal("Bir kez: 20.11.2026 09:00", ScheduleText.Describe(TaskSchedule.Once(at), TimeZoneInfo.CreateCustomTimeZone("tr", TimeSpan.FromHours(3), "tr", "tr")));
        Assert.Equal("""{"kind":"once","at":"2026-11-20T06:00:00Z"}""", TaskSchedule.Once(at).ToJson().ToJsonString());
    }

    [Fact]
    public void TheFormReadsBackWhatItWrote()
    {
        var weekly = ScheduleText.Form(TaskSchedule.Weekly(DayOfWeek.Wednesday, new TimeSpan(7, 45, 0)));
        Assert.Equal((1, new TimeSpan(7, 45, 0), DayOfWeek.Wednesday), (weekly.Mode, weekly.Time, weekly.Day));
        var daily = ScheduleText.Form(TaskSchedule.Daily(new TimeSpan(23, 5, 0)));
        Assert.Equal((0, new TimeSpan(23, 5, 0)), (daily.Mode, daily.Time));
        Assert.Equal((2, 45), (ScheduleText.Form(TaskSchedule.Interval(45)).Mode, ScheduleText.Form(TaskSchedule.Interval(45)).Minutes));
        Assert.Equal(3, ScheduleText.Form(TaskSchedule.Once(DateTimeOffset.UtcNow)).Mode);
        var advanced = ScheduleText.Form(TaskSchedule.Cron("0 0 1 1 *"));
        Assert.Equal((4, "0 0 1 1 *"), (advanced.Mode, advanced.Expr));
    }

    [Fact]
    public void RunStatusBadges()
    {
        Assert.Equal("Başarılı", ScheduleText.Status("succeeded"));
        Assert.Equal("Başarısız", ScheduleText.Status("failed"));
        Assert.Equal("Kaçırıldı", ScheduleText.Status("missed"));
        Assert.Equal("Çalışıyor", ScheduleText.Status("running"));
        Assert.Equal("bad", ScheduleText.Tone("failed"));
        Assert.Equal("none", ScheduleText.Tone(null));
    }

    [Fact]
    public void DraftValidation()
    {
        var now = new DateTimeOffset(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);
        var ok = new ScheduledTaskDraft { Name = "x", Target = TaskTarget.Device("d1"), Command = "uptime" };
        Assert.Null(ok.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "", Target = ok.Target, Command = "uptime" }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = new string('a', 81), Target = ok.Target, Command = "uptime" }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Command = "uptime" }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = "  " }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = new string('a', 4001) }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = "u", TimeoutSec = 5 }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = "u", Schedule = TaskSchedule.Interval(4) }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = "u", Schedule = TaskSchedule.Once(now.AddMinutes(-1)) }.Validate(now));
        Assert.NotNull(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = "u", Schedule = TaskSchedule.Cron("* * *") }.Validate(now));
        Assert.Null(new ScheduledTaskDraft { Name = "x", Target = ok.Target, Command = "u", Schedule = TaskSchedule.Cron("*/5 1-3 * * MON") }.Validate(now));
        Assert.Equal("""{"kind":"device","deviceId":"d1"}""", ok.Target!.ToJson().ToJsonString());
    }

    [Fact]
    public void OutputIsCappedAt64KiBKeepingTheEnd()
    {
        Assert.Equal("short", RunOutput.Cap("short"));
        var big = new string('a', 70_000) + "THE END";
        var capped = RunOutput.Cap(big);
        Assert.True(Encoding.UTF8.GetByteCount(capped) <= RunOutput.MaxBytes);
        Assert.EndsWith("THE END", capped);
        Assert.StartsWith("…", capped);
        // Multi-byte text is never cut inside a character.
        var turkish = string.Concat(Enumerable.Repeat("ğüş😀", 10_000));
        var t = RunOutput.Cap(turkish, 1000);
        Assert.True(Encoding.UTF8.GetByteCount(t) <= 1000);
        Assert.DoesNotContain('�', t);
        Assert.EndsWith("😀", t);
    }

    [Fact]
    public void ResultMapping()
    {
        Assert.Equal("succeeded", ScheduledRunResult.From(new RemoteExecResult(0, "ok", null)).Status);
        Assert.Equal("failed", ScheduledRunResult.From(new RemoteExecResult(3, "x", null)).Status);
        Assert.Equal("failed", ScheduledRunResult.From(new RemoteExecResult(0, "x", null, TimedOut: true)).Status);
        var noConnect = ScheduledRunResult.From(new RemoteExecResult(null, "", "no login"));
        Assert.Equal(("failed", (int?)null, "no login"), (noConnect.Status, noConnect.ExitCode, noConnect.Error));
        Assert.Null(new ScheduledRunResult("succeeded", 0, "", null).ToJson()["error"]);
        Assert.False(new ScheduledRunResult("succeeded", 0, "", null).ToJson().ContainsKey("error"));
    }

    [Fact]
    public void MarkedCommandFindsTheOutputBetweenTheMarkersInTerminalText()
    {
        var m = new MarkedCommand("abc123");
        var line = m.Line("echo 'hi'");
        Assert.StartsWith(" exec sh -c '", line);
        Assert.EndsWith("\r", line);
        // The typed line is echoed back but never contains a joined marker.
        Assert.DoesNotContain("__WC_B_abc123", line);
        Assert.DoesNotContain("__WC_E_abc123", line);
        m.Append("Welcome to Ubuntu\r\nuser@web:~$ " + line.TrimEnd('\r') + "\r\n> \r\n");
        Assert.False(m.Started);
        m.Append("\r\n__WC_B_abc");
        m.Append("123\r\nhi\r\n\u001b[31mred\u001b[0m\r\n");
        Assert.True(m.Started);
        Assert.False(m.Finished);
        m.Append("\r\n__WC_E_abc123_4");
        Assert.False(m.Finished); // the exit code may go on in the next chunk
        m.Append("2\r\n");
        Assert.True(m.Finished);
        Assert.Equal(42, m.ExitCode);
        Assert.Equal("hi\nred\n", m.Output);
    }

    [Fact]
    public void MarkedCommandDecodesSplitUtf8AndFinishesOnClose()
    {
        var m = new MarkedCommand("n1");
        var bytes = Encoding.UTF8.GetBytes("\r\n__WC_B_n1\r\nçalıştı\r\n__WC_E_n1_0");
        // Split inside the two-byte "ç".
        m.Append(bytes[..14]);
        m.Append(bytes[14..]);
        Assert.False(m.Finished);
        m.Close();
        Assert.True(m.Finished);
        Assert.Equal(0, m.ExitCode);
        Assert.Equal("çalıştı", m.Output);
    }

    [Fact]
    public void QuotingSurvivesSingleQuotes()
    {
        Assert.Equal("'it'\\''s'", MarkedCommand.Quote("it's"));
    }

    private sealed class FakeTransport(List<ClaimedRun> claims) : IScheduledRunTransport
    {
        public List<(string RunId, ScheduledRunResult Result)> Posted { get; } = [];
        public int Claims { get; private set; }
        public Exception? ClaimError { get; set; }
        public int FailPosts { get; set; }
        public Task<List<ClaimedRun>> ClaimAsync(CancellationToken ct)
        {
            Claims++;
            if (ClaimError is not null) throw ClaimError;
            var items = claims.ToList();
            return Task.FromResult(items);
        }
        public Task PostResultAsync(string runId, ScheduledRunResult result, CancellationToken ct)
        {
            if (FailPosts-- > 0) throw new GatewayException(GatewayErrorKind.Network, 0, "network", "offline");
            lock (Posted) Posted.Add((runId, result));
            return Task.CompletedTask;
        }
    }

    private sealed class FakeExecutor(Func<string, string, TimeSpan, Task<RemoteExecResult>> run) : IRemoteExecutor
    {
        public List<(string Host, string Command, TimeSpan Timeout)> Calls { get; } = [];
        public Task<RemoteExecResult> RunAsync(string hostId, string command, TimeSpan timeout, CancellationToken ct)
        {
            lock (Calls) Calls.Add((hostId, command, timeout));
            return run(hostId, command, timeout);
        }
    }

    private static ClaimedRun Claim(string runId, TaskTarget target, string command = "uptime", int timeout = 600) => new()
    {
        Run = new TaskRun { Id = runId, Status = "running" },
        Task = new ScheduledTask { Id = TaskId, Target = target, Command = command, TimeoutSec = timeout },
    };

    [Fact]
    public async Task RunnerRunsEachClaimedSshRunOnceAndPostsItsResult()
    {
        var gate = new TaskCompletionSource();
        var exec = new FakeExecutor(async (_, _, _) => { await gate.Task; return new RemoteExecResult(0, "up 3 days", null); });
        var transport = new FakeTransport([Claim(RunId, TaskTarget.Ssh("c1", "h1", "web-1"), "uptime", 5000)]);
        var runner = new ScheduledRunner(exec);
        Assert.Equal(1, await runner.PollOnceAsync(transport));
        // Claimed again while it still runs: not started twice.
        Assert.Equal(0, await runner.PollOnceAsync(transport));
        gate.SetResult();
        await runner.WhenIdle();
        var call = Assert.Single(exec.Calls);
        Assert.Equal(("h1", "uptime", TimeSpan.FromSeconds(3600)), call);
        var posted = Assert.Single(transport.Posted);
        Assert.Equal((RunId, "succeeded", 0, "up 3 days"), (posted.RunId, posted.Result.Status, posted.Result.ExitCode, posted.Result.Output));
    }

    [Fact]
    public async Task RunnerReportsFailuresAndNeverThrows()
    {
        var other = "22222222-2222-4333-8444-555555555555";
        var exec = new FakeExecutor((host, _, _) => host == "boom"
            ? throw new InvalidOperationException("core crashed")
            : Task.FromResult(new RemoteExecResult(null, "", "needs a password")));
        var logged = new List<Exception>();
        var transport = new FakeTransport([
            Claim(RunId, TaskTarget.Device("d1")),
            Claim(other, TaskTarget.Ssh("c1", "boom", "x")),
            Claim("33333333-2222-4333-8444-555555555555", TaskTarget.Ssh("c1", "locked", "y")),
        ]) { FailPosts = 1 };
        var runner = new ScheduledRunner(exec, e => { lock (logged) logged.Add(e); });
        Assert.Equal(3, await runner.PollOnceAsync(transport));
        await runner.WhenIdle();
        Assert.Equal(3, transport.Posted.Count); // one post failed once and was sent again
        Assert.All(transport.Posted, p => Assert.Equal("failed", p.Result.Status));
        Assert.Contains("core crashed", transport.Posted.Single(p => p.RunId == other).Result.Error);
        Assert.Equal("needs a password", transport.Posted.Single(p => p.RunId.StartsWith("3333")).Result.Error);
        Assert.Single(logged);

        transport.ClaimError = new GatewayException(GatewayErrorKind.Network, 0, "network", "offline");
        Assert.Equal(0, await runner.PollOnceAsync(transport));
    }
}
