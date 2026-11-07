using System.Net;
using System.Text;
using System.Text.Json;
using Wecommander.Center.Core;
using Xunit;

public class CoreTests
{
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

    [Theory]
    [InlineData("DisabledForApplication", "WECOMMANDER Yönetim Merkezi")]
    [InlineData("DisabledForUser", "Bildirimler anahtarını")]
    [InlineData("DisabledByGroupPolicy", "yöneticine")]
    [InlineData("DisabledByManifest", "yeniden kur")]
    public void NotificationBlockedMessageExplainsEachCause(string setting, string expected)
    {
        Assert.Contains(expected, Texts.NotificationBlockedMessage(setting));
    }

    [Theory]
    [InlineData("Enabled")]
    [InlineData("Unsupported")]
    public void NotificationBlockedMessageIsEmptyWhenNotBlocked(string setting)
    {
        Assert.Equal("", Texts.NotificationBlockedMessage(setting));
    }

    [Fact]
    public void ServerUrlAcceptsHttpsOriginsOnly()
    {
        Assert.Equal("https://wecommander.app", ServerUrl.Normalize("https://wecommander.app/"));
        Assert.Equal("https://example.com", ServerUrl.Normalize(" https://example.com "));
        Assert.Equal("http://127.0.0.1:8787", ServerUrl.Normalize("http://127.0.0.1:8787"));
        foreach (var bad in new[] { "http://wecommander.app", "https://wecommander.app/mcp", "ftp://x", "wecommander.app", "https://a@b.c" })
            Assert.Throws<ArgumentException>(() => ServerUrl.Normalize(bad));
    }

    [Fact]
    public void SummaryAndTexts()
    {
        Assert.Equal("whoami", ActionSummary.From(JsonDocument.Parse("""{"kind":"process_exec","command":"whoami"}""").RootElement));
        Assert.Equal("pid 42", ActionSummary.From(JsonDocument.Parse("""{"kind":"process_kill","pid":42}""").RootElement));
        Assert.Equal("", ActionSummary.From(JsonDocument.Parse("""{"kind":"x"}""").RootElement));
        Assert.Equal("Komut çalıştır", Texts.KindLabel("process_exec"));
        Assert.Contains("süresi dolmuş", Texts.ForErrorCode("approval_request_expired", 409));
        Assert.Contains("500", Texts.ForErrorCode("", 500));
        var now = new DateTimeOffset(2026, 11, 7, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("8 dk 12 sn", Texts.Remaining(now.AddSeconds(492), now));
        Assert.Equal("süresi doldu", Texts.Remaining(now.AddSeconds(-1), now));
        Assert.Equal("45 sn", Texts.Remaining(now.AddSeconds(45), now));
    }

    [Fact]
    public void NotificationCountdown()
    {
        var now = new DateTimeOffset(2026, 11, 7, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("4:07", Texts.Countdown(now.AddSeconds(247), now));
        Assert.Equal("0:01", Texts.Countdown(now.AddMilliseconds(200), now));
        Assert.Equal("1:02:05", Texts.Countdown(now.AddSeconds(3725), now));
        Assert.Equal("0:00", Texts.Countdown(now.AddSeconds(-5), now));
        var created = now.AddMinutes(-2);
        Assert.Equal(0.8, Texts.RemainingFraction(created, now.AddMinutes(8), now), 3);
        Assert.Equal(0, Texts.RemainingFraction(created, now.AddMinutes(-1), now));
        Assert.Equal(1, Texts.RemainingFraction(now, now.AddMinutes(10), now.AddMinutes(-1)));
        Assert.Equal(0, Texts.RemainingFraction(now, now, now));
    }

    [Fact]
    public void MinutesUntilNine()
    {
        Assert.Equal(60, Durations.MinutesUntilNine(new DateTime(2026, 11, 7, 8, 0, 0)));
        Assert.Equal(15 * 60, Durations.MinutesUntilNine(new DateTime(2026, 11, 7, 18, 0, 0)));
        Assert.Equal(24 * 60, Durations.MinutesUntilNine(new DateTime(2026, 11, 7, 9, 0, 0)));
    }

    [Fact]
    public void SettingsRoundTrip()
    {
        var dir = Path.Combine(Path.GetTempPath(), "wmc-" + Guid.NewGuid().ToString("N"));
        var store = new SettingsStore(dir);
        var (initial, existed) = store.Load();
        Assert.False(existed);
        Assert.Equal(Settings.DefaultServer, initial.Server);
        initial.Notifications = false;
        store.Save(initial);
        var (loaded, existedNow) = store.Load();
        Assert.True(existedNow);
        Assert.False(loaded.Notifications);
        Assert.False(loaded.OpenOnRequest);
        Assert.False(loaded.NotificationIntroShown);
        Directory.Delete(dir, true);
    }

    [Fact]
    public void EarlierOpenOnRequestSettingIsNotCarriedOver()
    {
        var dir = Path.Combine(Path.GetTempPath(), "wmc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "settings.json"),
            """{"server":"https://wecommander.app","notifications":true,"openOnRequest":true}""");
        var (loaded, existed) = new SettingsStore(dir).Load();
        Assert.True(existed);
        Assert.True(loaded.Notifications);
        Assert.False(loaded.OpenOnRequest);
        Directory.Delete(dir, true);
    }

    [Fact]
    public async Task ListsParseGatewayShapes()
    {
        var (client, handler) = Client((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/approval-requests" => (HttpStatusCode.OK, """{"items":[{"id":"99413e59-492a-4b60-b53a-9c36d5433112","device_id":"d","requested_by":"token:x","action_kind":"process_exec","action":{"command":"whoami"},"status":"pending","expires_at":"2026-11-07T11:14:18.026Z","created_at":"2026-11-07T11:04:18.026Z"}]}"""),
            "/api/devices" => (HttpStatusCode.OK, """{"items":[{"id":"d","name":"content","platform":"windows","online":true,"trust_level":"standard","trust_full_until":null,"revoked_at":null,"capabilities":{}},{"id":"old","name":"x","online":false,"revoked_at":"2026-10-01T00:00:00Z"}]}"""),
            "/api/trust/autonomy" => (HttpStatusCode.OK, """{"items":[{"id":"d","name":"content","trust_full_until":null}]}"""),
            "/api/center/me" => (HttpStatusCode.OK, """{"centerId":"c","name":"Ofis-PC","email":"a@b.c","role":"owner","organizationName":"W"}"""),
            _ => (HttpStatusCode.NotFound, "{}"),
        });
        var pending = await client.PendingAsync("wmc_t");
        Assert.Equal("whoami", Assert.Single(pending).Summary);
        Assert.Equal("content", Assert.Single(await client.DevicesAsync("wmc_t")).Name);
        Assert.Null(Assert.Single(await client.AutonomyAsync("wmc_t")).TrustFullUntil);
        Assert.Equal("Ofis-PC", (await client.MeAsync("wmc_t")).Name);
        Assert.All(handler.Calls, c => Assert.Equal("Bearer wmc_t", c.Auth));
        Assert.Contains(handler.Calls, c => c.Url == "https://wecommander.app/api/approval-requests?status=pending&limit=100");
    }

    [Fact]
    public async Task DecideAutonomyAndErrors()
    {
        var (client, handler) = Client((req, body) => req.RequestUri!.AbsolutePath switch
        {
            "/api/trust/autonomy" when body!.Contains("\"enable\":true") => (HttpStatusCode.Forbidden, """{"error":"reauthentication_failed"}"""),
            "/api/trust/autonomy" => (HttpStatusCode.OK, """{"items":[]}"""),
            var p when p.EndsWith("/approve") => (HttpStatusCode.Conflict, """{"error":"approval_request_expired"}"""),
            var p when p.EndsWith("/deny") => (HttpStatusCode.OK, """{"ok":true}"""),
            "/api/center/me" => (HttpStatusCode.Unauthorized, """{"error":"unauthorized"}"""),
            _ => (HttpStatusCode.NotFound, "{}"),
        });
        var id = "99413e59-492a-4b60-b53a-9c36d5433112";
        await client.DecideAsync("t", id, approve: false);
        var expired = await Assert.ThrowsAsync<GatewayException>(() => client.DecideAsync("t", id, approve: true));
        Assert.Equal("approval_request_expired", expired.Code);
        Assert.Contains("süresi dolmuş", expired.Message);
        await Assert.ThrowsAsync<GatewayException>(() => client.DecideAsync("t", "../../api/tokens", true));
        Assert.DoesNotContain(handler.Calls, c => c.Url.Contains("tokens"));

        var wrong = await Assert.ThrowsAsync<GatewayException>(() => client.SetAutonomyAsync("t", true, 30, ["d1"], "x"));
        Assert.Equal("Şifre hatalı.", wrong.Message);
        var sent = handler.Calls.Last(c => c.Url.EndsWith("/api/trust/autonomy")).Body!;
        using (var doc = JsonDocument.Parse(sent))
        {
            Assert.Equal(30, doc.RootElement.GetProperty("minutes").GetInt32());
            Assert.Equal("x", doc.RootElement.GetProperty("currentPassword").GetString());
            Assert.Equal("d1", doc.RootElement.GetProperty("deviceIds")[0].GetString());
        }
        await client.SetAutonomyAsync("t", false, null, null, null);
        using (var doc = JsonDocument.Parse(handler.Calls.Last().Body!))
        {
            Assert.False(doc.RootElement.TryGetProperty("currentPassword", out _));
            Assert.False(doc.RootElement.TryGetProperty("deviceIds", out _));
        }
        var gone = await Assert.ThrowsAsync<GatewayException>(() => client.MeAsync("t"));
        Assert.Equal(GatewayErrorKind.Unauthorized, gone.Kind);
    }

    [Fact]
    public async Task NetworkFailureIsAGatewayException()
    {
        var client = new GatewayClient(new HttpClient(new ThrowingHandler()), "https://wecommander.app");
        var error = await Assert.ThrowsAsync<GatewayException>(() => client.LinkStartAsync("pc"));
        Assert.Equal(GatewayErrorKind.Network, error.Kind);
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new HttpRequestException("down");
    }
}
