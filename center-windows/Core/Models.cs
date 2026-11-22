using System.Text.Json;
using System.Text.Json.Serialization;

namespace Wecommander.Center.Core;

/// <summary>A pending approval request as the gateway lists it.</summary>
public sealed class ApprovalRequest
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("device_id")] public string DeviceId { get; set; } = "";
    /// <summary>A saved SSH server shared through a computer (Hybrid Access H3): no device, a label instead.</summary>
    [JsonPropertyName("target_label")] public string? TargetLabel { get; set; }
    [JsonPropertyName("action_kind")] public string ActionKind { get; set; } = "";
    [JsonPropertyName("action")] public JsonElement Action { get; set; }
    [JsonPropertyName("expires_at")] public DateTimeOffset ExpiresAt { get; set; }
    [JsonPropertyName("created_at")] public DateTimeOffset CreatedAt { get; set; }

    /// <summary>The exact thing the approval allows: command, path or name.</summary>
    public string Summary => ActionSummary.From(Action);

    /// <summary>Where it runs: the device's name, or the SSH server's ("web-1 · SSH").</summary>
    public string PlaceName(IReadOnlyDictionary<string, string> devices) =>
        !string.IsNullOrEmpty(DeviceId) && devices.TryGetValue(DeviceId, out var name) ? name
        : !string.IsNullOrWhiteSpace(TargetLabel) ? TargetLabel + " · SSH"
        : L.T("bilinmeyen cihaz");
}

public sealed class Device
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("platform")] public string? Platform { get; set; }
    [JsonPropertyName("online")] public bool Online { get; set; }
    [JsonPropertyName("trust_level")] public string? TrustLevel { get; set; }
    [JsonPropertyName("trust_full_until")] public DateTimeOffset? TrustFullUntil { get; set; }
    [JsonPropertyName("revoked_at")] public DateTimeOffset? RevokedAt { get; set; }
    /// <summary>"user" or "root": who the AI's commands run as.</summary>
    [JsonPropertyName("run_as")] public string? RunAs { get; set; }
    /// <summary>The machine owner allowed root when installing the agent.</summary>
    [JsonPropertyName("root_capable")] public bool? RootCapable { get; set; }
    [JsonPropertyName("safety_net")] public bool? SafetyNet { get; set; }
}

public sealed class AutonomyItem
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("trust_full_until")] public DateTimeOffset? TrustFullUntil { get; set; }
}

public sealed class CenterMe
{
    [JsonPropertyName("centerId")] public string CenterId { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("email")] public string? Email { get; set; }
    [JsonPropertyName("role")] public string Role { get; set; } = "";
    [JsonPropertyName("organizationName")] public string? OrganizationName { get; set; }
}

/// <summary>Where a request was decided: a Management Center (its name and
/// kind of computer) or the web panel. <c>Self</c> is this center.</summary>
public sealed class DecidedVia
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("platform")] public string? Platform { get; set; }
    [JsonPropertyName("self")] public bool Self { get; set; }
}

/// <summary>The outcome of one approval request (GET /api/approval-requests/{id}).</summary>
public sealed class ApprovalOutcome
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("decided_via")] public DecidedVia? DecidedVia { get; set; }
}

public sealed class LinkStart
{
    [JsonPropertyName("requestId")] public string RequestId { get; set; } = "";
    [JsonPropertyName("requestSecret")] public string RequestSecret { get; set; } = "";
    [JsonPropertyName("approveUrl")] public string ApproveUrl { get; set; } = "";
    [JsonPropertyName("expiresInSeconds")] public int ExpiresInSeconds { get; set; }
}

public sealed class LinkPoll
{
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("centerToken")] public string? CenterToken { get; set; }
}

public static class ActionSummary
{
    public static string From(JsonElement action)
    {
        if (action.ValueKind != JsonValueKind.Object) return "";
        if (action.TryGetProperty("dataBase64", out var input) && input.ValueKind == JsonValueKind.String)
            return TerminalInput(input.GetString() ?? "");
        // SSH targets (Hybrid Access H4): a move shows both ends, a write its size and content hash.
        if (action.TryGetProperty("source", out var from) && from.ValueKind == JsonValueKind.String &&
            action.TryGetProperty("destination", out var to) && to.ValueKind == JsonValueKind.String)
            return $"{from.GetString()} → {to.GetString()}";
        if (action.TryGetProperty("path", out var written) && written.ValueKind == JsonValueKind.String &&
            action.TryGetProperty("sha256", out var hash) && hash.ValueKind == JsonValueKind.String &&
            action.TryGetProperty("size", out var size) && size.ValueKind == JsonValueKind.Number)
        {
            var h = hash.GetString() ?? "";
            return $"{written.GetString()} ({size.GetRawText()} B, sha256 {(h.Length > 12 ? h[..12] : h)}…)";
        }
        foreach (var key in new[] { "command", "path", "source", "name", "pid", "taskId", "sessionId" })
        {
            if (!action.TryGetProperty(key, out var value)) continue;
            if (value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text) return text;
            if (value.ValueKind == JsonValueKind.Number) return $"{key} {value.GetRawText()}";
        }
        return "";
    }

    /// <summary>What an AI wants to type into a terminal: printable, one line, bounded.</summary>
    public static string TerminalInput(string base64)
    {
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); } catch (FormatException) { return ""; }
        var text = System.Text.Encoding.UTF8.GetString(bytes).Replace("\r\n", "⏎").Replace('\n', '⏎').Replace('\r', '⏎');
        var printable = new string(text.Select(c => c < 0x20 || c == 0x7f ? '·' : c).ToArray());
        return printable.Length > 300 ? printable[..300] : printable;
    }
}
