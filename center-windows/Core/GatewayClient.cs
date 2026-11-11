using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wecommander.Center.Core;

public enum GatewayErrorKind { Unauthorized, Http, Network }

public sealed class GatewayException(GatewayErrorKind kind, int status, string code, string message)
    : Exception(message)
{
    public GatewayErrorKind Kind { get; } = kind;
    public int Status { get; } = status;
    public string Code { get; } = code;
}

/// <summary>
/// Gateway calls of the Management Center. Every call except sign-in carries
/// the center token; the gateway lets it reach only approvals, autonomous
/// mode, the device list and /api/center/*.
/// </summary>
public sealed class GatewayClient(HttpClient http, string baseUrl)
{
    private readonly string _base = baseUrl.TrimEnd('/');

    private async Task<JsonNode?> SendAsync(HttpMethod method, string path, string? token, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, _base + path);
        if (token is not null) request.Headers.Authorization = new("Bearer", token);
        if (body is not null) request.Content = JsonContent.Create(body);
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new GatewayException(GatewayErrorKind.Network, 0, "timeout", "Sunucuya ulaşılamıyor (zaman aşımı).");
        }
        catch (HttpRequestException)
        {
            throw new GatewayException(GatewayErrorKind.Network, 0, "network", "Sunucuya ulaşılamıyor (bağlantı kurulamadı).");
        }
        using (response)
        {
            JsonNode? json = null;
            try { json = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false)); }
            catch (JsonException) { }
            var status = (int)response.StatusCode;
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                throw new GatewayException(GatewayErrorKind.Unauthorized, status, "unauthorized", Texts.SignedOutByServer);
            if (!response.IsSuccessStatusCode)
            {
                var code = json?["error"]?.GetValueKind() == JsonValueKind.String ? json["error"]!.GetValue<string>() : "";
                throw new GatewayException(GatewayErrorKind.Http, status, code, Texts.ForErrorCode(code, status));
            }
            return json;
        }
    }

    private static T Read<T>(JsonNode? node) =>
        node.Deserialize<T>() ?? throw new GatewayException(GatewayErrorKind.Network, 0, "bad_response", "Sunucudan beklenmeyen yanıt.");

    private async Task<List<T>> ItemsAsync<T>(string path, string token, CancellationToken ct) =>
        (await SendAsync(HttpMethod.Get, path, token, null, ct).ConfigureAwait(false))?["items"].Deserialize<List<T>>() ?? [];

    public async Task<LinkStart> LinkStartAsync(string name, CancellationToken ct = default) =>
        Read<LinkStart>(await SendAsync(HttpMethod.Post, "/api/center-link/start", null, new { name, platform = "windows" }, ct).ConfigureAwait(false));

    public async Task<LinkPoll> LinkPollAsync(string id, string secret, CancellationToken ct = default) =>
        Read<LinkPoll>(await SendAsync(HttpMethod.Post, "/api/center-link/poll", null, new { requestId = id, requestSecret = secret }, ct).ConfigureAwait(false));

    public async Task<CenterMe> MeAsync(string token, CancellationToken ct = default) =>
        Read<CenterMe>(await SendAsync(HttpMethod.Get, "/api/center/me?platform=windows", token, null, ct).ConfigureAwait(false));

    public Task<List<ApprovalRequest>> PendingAsync(string token, CancellationToken ct = default) =>
        ItemsAsync<ApprovalRequest>("/api/approval-requests?status=pending&limit=100", token, ct);

    public async Task<List<Device>> DevicesAsync(string token, CancellationToken ct = default) =>
        (await ItemsAsync<Device>("/api/devices", token, ct).ConfigureAwait(false)).Where(d => d.RevokedAt is null).ToList();

    public Task<List<AutonomyItem>> AutonomyAsync(string token, CancellationToken ct = default) =>
        ItemsAsync<AutonomyItem>("/api/trust/autonomy", token, ct);

    /// <summary>Where and how a request ended, once it left the pending list.</summary>
    public async Task<ApprovalOutcome> OutcomeAsync(string token, string id, CancellationToken ct = default)
    {
        if (!Guid.TryParse(id, out var guid))
            throw new GatewayException(GatewayErrorKind.Http, 400, "invalid_request", Texts.ForErrorCode("invalid_request", 400));
        var node = await SendAsync(HttpMethod.Get, $"/api/approval-requests/{guid:D}", token, null, ct).ConfigureAwait(false);
        return Read<ApprovalOutcome>(node?["item"]);
    }

    public async Task DecideAsync(string token, string id, bool approve, CancellationToken ct = default)
    {
        if (!Guid.TryParse(id, out var guid))
            throw new GatewayException(GatewayErrorKind.Http, 400, "invalid_request", Texts.ForErrorCode("invalid_request", 400));
        await SendAsync(HttpMethod.Post, $"/api/approval-requests/{guid:D}/{(approve ? "approve" : "deny")}", token, new { }, ct).ConfigureAwait(false);
    }

    public async Task SetAutonomyAsync(string token, bool enable, int? minutes, IReadOnlyList<string>? deviceIds, string? password, CancellationToken ct = default)
    {
        var body = new JsonObject { ["enable"] = enable };
        if (enable)
        {
            body["minutes"] = minutes;
            body["currentPassword"] = password ?? "";
        }
        if (deviceIds is not null) body["deviceIds"] = new JsonArray(deviceIds.Select(d => (JsonNode)d).ToArray());
        await SendAsync(HttpMethod.Post, "/api/trust/autonomy", token, body, ct).ConfigureAwait(false);
    }

    /// <summary>One-time pairing code (5 minutes) for the agent installer on this computer.</summary>
    public async Task<string> PairingCodeAsync(string token, CancellationToken ct = default)
    {
        var node = await SendAsync(HttpMethod.Post, "/api/center/pairing-code", token, new { }, ct).ConfigureAwait(false);
        return node?["pairingCode"]?.GetValue<string>() ?? throw new GatewayException(GatewayErrorKind.Http, 0, "", "Eşleştirme kodu alınamadı.");
    }

    public async Task DisconnectAsync(string token, CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Post, "/api/center/disconnect", token, new { }, ct).ConfigureAwait(false);

    /// <summary>A20: the encrypted host library and its revision (0 = nothing synced yet).</summary>
    public async Task<LibraryState> LibraryAsync(string token, CancellationToken ct = default)
    {
        var node = await SendAsync(HttpMethod.Get, "/api/center/library", token, null, ct).ConfigureAwait(false);
        return new LibraryState(node?["revision"]?.GetValue<long>() ?? 0, node?["envelope"]?.GetValueKind() == JsonValueKind.String ? node["envelope"]!.GetValue<string>() : null);
    }

    /// <summary>
    /// Uploads the library written on top of <paramref name="baseRevision"/>. When another
    /// computer wrote first the server answers 409 with its newer library: returned as
    /// Accepted = false with that state, to merge and try again.
    /// </summary>
    public async Task<(bool Accepted, LibraryState State)> PutLibraryAsync(string token, long baseRevision, string envelope, CancellationToken ct = default)
    {
        try
        {
            var node = await SendAsync(HttpMethod.Put, "/api/center/library", token, new { baseRevision, envelope }, ct).ConfigureAwait(false);
            return (true, new LibraryState(node?["revision"]?.GetValue<long>() ?? baseRevision + 1, envelope));
        }
        catch (GatewayException e) when (e.Status == 409)
        {
            return (false, await LibraryAsync(token, ct).ConfigureAwait(false));
        }
    }

    public async Task<TeamState> TeamAsync(string token, CancellationToken ct = default) =>
        Read<TeamState>(await SendAsync(HttpMethod.Get, "/api/center/team", token, null, ct).ConfigureAwait(false));

    public async Task PutTeamKeyAsync(string token, string publicKey, CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Put, "/api/center/team/key", token, new { publicKey }, ct).ConfigureAwait(false);

    public async Task PutWrappedKeyAsync(string token, string centerId, string wrappedKey, CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Put, "/api/center/team/wrapped-key", token, new { centerId, wrappedKey }, ct).ConfigureAwait(false);

    public async Task<(bool Accepted, LibraryState State)> PutTeamLibraryAsync(string token, long baseRevision, string envelope, CancellationToken ct = default)
    {
        try
        {
            var node = await SendAsync(HttpMethod.Put, "/api/center/team/library", token, new { baseRevision, envelope }, ct).ConfigureAwait(false);
            return (true, new LibraryState(node?["revision"]?.GetValue<long>() ?? baseRevision + 1, envelope));
        }
        catch (GatewayException e) when (e.Status == 409)
        {
            var team = await TeamAsync(token, ct).ConfigureAwait(false);
            return (false, new LibraryState(team.Revision, team.Envelope));
        }
    }

    // ---- A27 shared terminals ----

    public Task<List<ShareInfo>> SharesAsync(string token, CancellationToken ct = default) =>
        ItemsAsync<ShareInfo>("/api/center/shares", token, ct);

    public async Task<string> CreateShareAsync(string token, string title, CancellationToken ct = default) =>
        (await SendAsync(HttpMethod.Post, "/api/center/shares", token, new { title }, ct).ConfigureAwait(false))?["id"]?.GetValue<string>()
        ?? throw new GatewayException(GatewayErrorKind.Network, 0, "bad_response", "Sunucudan beklenmeyen yanıt.");

    public async Task EndShareAsync(string token, string id, CancellationToken ct = default)
    {
        try { await SendAsync(HttpMethod.Delete, "/api/center/shares/" + id, token, null, ct).ConfigureAwait(false); }
        catch (GatewayException e) when (e.Status == 404) { }
    }

    /// <summary>The relay socket of a shared terminal.</summary>
    public Uri ShareSocketUri(string id, string role) =>
        new((_base.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "wss://" + _base[8..] : "ws://" + _base.Replace("http://", "")) +
            $"/center/share?id={Uri.EscapeDataString(id)}&role={role}");
}

public sealed record LibraryState(long Revision, string? Envelope);

/// <summary>A27: a shared terminal of the workspace.</summary>
public sealed record ShareInfo(string Id, string Title, string HostEmail, int Guests, string CreatedAt);

/// <summary>A22: one app (Management Center) of a team member and whether it has the team key.</summary>
public sealed record TeamMember(string CenterId, string Email, string Role, string CenterName, string PublicKey, bool HasKey);

/// <summary>A22: the team as this app sees it.</summary>
public sealed record TeamState(string? OrganizationName, string Role, string? MyWrappedKey, List<TeamMember> Members, long Revision, string? Envelope)
{
    public bool CanEdit => Role is "operator" or "admin" or "owner";
}