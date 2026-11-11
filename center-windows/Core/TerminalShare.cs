using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wecommander.Center.Core;

/// <summary>
/// A27: one side of a shared terminal. The host sends terminal output and
/// receives guests' keys; a guest receives output and sends keys. Every
/// payload is sealed with the team key by wecommander-core (team.seal /
/// team.open), so the relay only sees opaque frames.
/// </summary>
public sealed class TerminalShare : IAsyncDisposable
{
    private readonly ClientWebSocket _ws = new();
    private readonly CoreClient _core;
    private readonly SemaphoreSlim _send = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly StringBuilder _history = new();
    private const int HistoryLimit = 96 * 1024;

    public string Id { get; }
    public bool IsHost { get; }
    /// <summary>Host: guests may type when true.</summary>
    public bool AllowInput { get; set; }
    public Dictionary<string, string> Guests { get; } = [];

    /// <summary>Guest: base64 terminal output.</summary>
    public event Action<string>? Output;
    /// <summary>Host: keys a guest typed (only when AllowInput).</summary>
    public event Action<string>? Input;
    public event Action? GuestsChanged;
    /// <summary>The share ended or the connection dropped (reason text).</summary>
    public event Action<string>? Ended;

    private TerminalShare(CoreClient core, string id, bool host)
    {
        _core = core;
        Id = id;
        IsHost = host;
    }

    public static async Task<TerminalShare> ConnectAsync(CoreClient core, Uri socket, string token, string id, bool host)
    {
        var share = new TerminalShare(core, id, host);
        share._ws.Options.SetRequestHeader("Authorization", "Bearer " + token);
        share._ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        await share._ws.ConnectAsync(socket, CancellationToken.None).ConfigureAwait(false);
        _ = share.ReceiveLoop();
        return share;
    }

    /// <summary>Host: terminal output (base64) for every guest; kept for guests who join later.</summary>
    public async Task SendOutputAsync(string base64)
    {
        lock (_history)
        {
            _history.Append(base64).Append('\n');
            if (_history.Length > HistoryLimit) _history.Remove(0, _history.Length - HistoryLimit);
        }
        if (Guests.Count == 0) return;
        await SendSealedAsync("data", base64, null).ConfigureAwait(false);
    }

    /// <summary>Guest: keys for the host's terminal.</summary>
    public Task SendInputAsync(string keys) => SendSealedAsync("input", keys, null);

    public Task KickAsync(string guestId) => SendRawAsync(new JsonObject { ["t"] = "kick", ["to"] = guestId });

    private async Task SendSealedAsync(string type, string plain, string? to)
    {
        var sealedText = (await _core.CallAsync<JsonElement>("team.seal", new { data = plain }).ConfigureAwait(false)).GetProperty("data").GetString();
        var frame = new JsonObject { ["t"] = type, ["d"] = sealedText };
        if (to is not null) frame["to"] = to;
        await SendRawAsync(frame).ConfigureAwait(false);
    }

    private async Task SendRawAsync(JsonObject frame)
    {
        var bytes = Encoding.UTF8.GetBytes(frame.ToJsonString());
        await _send.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _stop.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
        finally { _send.Release(); }
    }

    private async Task ReceiveLoop()
    {
        var buffer = new byte[64 * 1024];
        var message = new MemoryStream();
        var reason = "Paylaşım bitti.";
        try
        {
            while (_ws.State == WebSocketState.Open)
            {
                var r = await _ws.ReceiveAsync(buffer, _stop.Token).ConfigureAwait(false);
                if (r.MessageType == WebSocketMessageType.Close)
                {
                    reason = _ws.CloseStatusDescription switch
                    {
                        "removed by host" => "Paylaşan kişi seni çıkardı.",
                        "share is full" => "Bu paylaşım dolu.",
                        "no such share" => "Paylaşım artık yok.",
                        _ => "Paylaşım bitti.",
                    };
                    break;
                }
                message.Write(buffer, 0, r.Count);
                if (!r.EndOfMessage) continue;
                var text = Encoding.UTF8.GetString(message.ToArray());
                message.SetLength(0);
                await HandleAsync(text).ConfigureAwait(false);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException)
        {
            reason = "Paylaşım bağlantısı koptu.";
        }
        Ended?.Invoke(reason);
    }

    private async Task HandleAsync(string text)
    {
        JsonObject? f;
        try { f = JsonNode.Parse(text) as JsonObject; } catch (JsonException) { return; }
        var type = (string?)f?["t"];
        var from = (string?)f?["from"];
        switch (type)
        {
            case "join" when IsHost && from is not null:
                Guests[from] = (string?)f!["email"] ?? "";
                GuestsChanged?.Invoke();
                string history;
                lock (_history) history = _history.ToString();
                foreach (var chunk in history.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                    await SendSealedAsync("data", chunk, from).ConfigureAwait(false);
                break;
            case "leave" when IsHost && from is not null:
                Guests.Remove(from);
                GuestsChanged?.Invoke();
                break;
            case "input" when IsHost && AllowInput:
            case "data" when !IsHost:
                try
                {
                    var plain = (await _core.CallAsync<JsonElement>("team.open", new { data = (string?)f!["d"] ?? "" }).ConfigureAwait(false)).GetProperty("data").GetString() ?? "";
                    if (type == "input") Input?.Invoke(plain); else Output?.Invoke(plain);
                }
                catch (CoreException) { }
                break;
            case "paused" when !IsHost:
                Output?.Invoke(Convert.ToBase64String(Encoding.UTF8.GetBytes("\r\n\u001b[90m[Paylaşan kişinin bağlantısı koptu; geri gelmesi bekleniyor.]\u001b[0m\r\n")));
                break;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
        _ws.Dispose();
    }
}
