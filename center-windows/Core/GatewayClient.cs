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

    public async Task DisconnectAsync(string token, CancellationToken ct = default) =>
        await SendAsync(HttpMethod.Post, "/api/center/disconnect", token, new { }, ct).ConfigureAwait(false);
}
