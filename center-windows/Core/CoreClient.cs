using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wecommander.Center.Core;

/// <summary>
/// Talks to <c>wecommander-core</c>, the shared Rust app core (saved hosts,
/// keyring, SSH terminals, SFTP, tunnels), over its JSON-lines protocol
/// (docs/CORE_PROTOCOL.md). Requests run concurrently and are matched by id;
/// events arrive through <see cref="Event"/> on a background thread.
/// </summary>
public sealed class CoreClient : IDisposable
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Process _process;
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> _waiting = new();
    private readonly SemaphoreSlim _write = new(1, 1);
    private long _next;
    private volatile bool _running = true;
    private int _disposed;

    /// <summary>Event name and its <c>data</c>.</summary>
    public event Action<string, JsonNode?>? Event;

    /// <summary>The <c>ready</c> event's app info (empty until it arrives).</summary>
    public JsonObject Info { get; private set; } = new();

    private CoreClient(Process process)
    {
        _process = process;
        _ = Task.Run(ReadLoop);
    }

    /// <summary>Starts the core; <paramref name="executable"/> is normally next to the app.</summary>
    public static CoreClient Start(string executable, string dataDirectory, string keyringService = "app.wecommander")
    {
        Directory.CreateDirectory(dataDirectory);
        var info = new ProcessStartInfo(executable)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardInputEncoding = new UTF8Encoding(false),
        };
        info.ArgumentList.Add("--data-dir");
        info.ArgumentList.Add(dataDirectory);
        info.ArgumentList.Add("--keyring-service");
        info.ArgumentList.Add(keyringService);
        var process = Process.Start(info) ?? throw new InvalidOperationException("wecommander-core did not start");
        process.ErrorDataReceived += (_, _) => { };
        process.BeginErrorReadLine();
        return new CoreClient(process);
    }

    private async Task ReadLoop()
    {
        try
        {
            string? line;
            while ((line = await _process.StandardOutput.ReadLineAsync()) is not null)
            {
                Handle(line);
            }
        }
        catch (Exception)
        {
            // Pipe closed: treated as stopped below.
        }
        StopAll();
    }

    internal void Handle(string line)
    {
        JsonObject? obj;
        try { obj = JsonNode.Parse(line) as JsonObject; }
        catch (JsonException) { return; }
        if (obj is null) return;
        if (obj["event"] is JsonValue ev && ev.TryGetValue(out string? name))
        {
            var data = obj["data"];
            if (name == "ready" && data is JsonObject info) Info = (JsonObject)info.DeepClone();
            Event?.Invoke(name, data?.DeepClone());
            return;
        }
        if (obj["id"] is not JsonValue idValue || !idValue.TryGetValue(out long id)) return;
        if (!_waiting.TryRemove(id, out var tcs)) return;
        if (obj["error"] is JsonValue err && err.TryGetValue(out string? message))
            tcs.TrySetException(new CoreException(message));
        else
            tcs.TrySetResult(obj["result"]?.DeepClone());
    }

    /// <summary>Calls <paramref name="method"/>; returns the JSON <c>result</c>.</summary>
    public async Task<JsonNode?> CallAsync(string method, object? parameters = null)
    {
        if (!_running) throw new CoreException(CoreException.Stopped);
        var id = Interlocked.Increment(ref _next);
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _waiting[id] = tcs;
        var line = JsonSerializer.Serialize(new { id, method, @params = parameters ?? new { } }, Json);
        await _write.WaitAsync();
        try
        {
            await _process.StandardInput.WriteLineAsync(line);
            await _process.StandardInput.FlushAsync();
        }
        catch (Exception)
        {
            _waiting.TryRemove(id, out _);
            throw new CoreException(CoreException.Stopped);
        }
        finally
        {
            _write.Release();
        }
        return await tcs.Task;
    }

    /// <summary>Calls <paramref name="method"/> and decodes the result.</summary>
    public async Task<T> CallAsync<T>(string method, object? parameters = null)
    {
        var node = await CallAsync(method, parameters);
        return node is null ? default! : node.Deserialize<T>(Json)!;
    }

    private void StopAll()
    {
        _running = false;
        foreach (var key in _waiting.Keys)
        {
            if (_waiting.TryRemove(key, out var tcs)) tcs.TrySetException(new CoreException(CoreException.Stopped));
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        _running = false;
        try { _process.StandardInput.Close(); } catch (Exception) { }
        try { if (!_process.WaitForExit(2000)) _process.Kill(true); } catch (Exception) { }
        StopAll();
        _process.Dispose();
    }
}

/// <summary>A core error; <see cref="Message"/> is already in Turkish.</summary>
public sealed class CoreException(string raw) : Exception(CoreText.Turkish(raw))
{
    public const string Stopped = "core stopped";
    public string Raw { get; } = raw;
}

/// <summary>Turkish texts for the core's English error prefixes.</summary>
public static class CoreText
{
    /// <summary>
    /// "authentication failed (server accepts: publickey)": say what the server
    /// takes, so a refused password is not mistaken for a typo.
    /// </summary>
    public static string AuthFailed(string text)
    {
        var i = text.IndexOf("server accepts:", StringComparison.Ordinal);
        if (i < 0) return "Giriş reddedildi. Anahtarı veya parolayı kontrol et.";
        var methods = text[(i + "server accepts:".Length)..].Trim().TrimEnd(')').Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var password = methods.Contains("password") || methods.Contains("keyboard-interactive");
        var key = methods.Contains("publickey");
        if (key && !password)
            return "Giriş reddedildi. Bu sunucu parolayla girişi kabul etmiyor, yalnız SSH anahtarı kabul ediyor. "
                + "Bu bilgisayarın anahtarını sunucuya bir kez ekle; aşağıdaki satır bunu yapar. "
                + "(root için Ubuntu varsayılan olarak parolayla girişi kapatır.)";
        return "Giriş reddedildi; kullanıcı adı, parola ya da anahtar yanlış. Sunucunun kabul ettiği yöntemler: " + string.Join(", ", methods) + ".";
    }

    public static string Turkish(string text)
    {
        if (text == CoreException.Stopped) return "Uygulama çekirdeği çalışmıyor.";
        if (text.Contains("no saved credential")) return "Bu sunucu için kayıtlı giriş bilgisi yok; bir kez gir.";
        if (text.Contains("authentication failed")) return AuthFailed(text);
        if (text.Contains("private key could not be used")) return "Özel anahtar okunamadı (biçim veya anahtar parolası yanlış).";
        if (text.Contains("work only on SSH terminals")) return "Dosyalar ve tüneller yalnız SSH bağlantılarında kullanılabilir.";
        if (text.StartsWith("telnet: could not connect")) return "Telnet bağlantısı kurulamadı; adresi ve portu kontrol et.";
        if (text.Contains("not available in this version")) return "Bu bağlantı türü bu sürümde henüz yok.";
        if (text.StartsWith("serial: could not open"))
            return "Seri port açılamadı. Kablonun takılı olduğunu ve portu başka bir programın kullanmadığını kontrol et.";
        if (text.Contains("invalid serial line settings")) return "Seri port ayarları geçersiz (hız, veri bitleri, eşlik ya da durdurma bitleri).";
        if (text.Contains("invalid serial port") || text.Contains("serial port settings are missing")) return "Seri portu seç ya da yaz (ör. COM3).";
        if (text.Contains("timed out")) return "Sunucuya ulaşılamadı (zaman aşımı). Sunucu kapalı olabilir ya da kısa sürede çok sayıda başarısız giriş yüzünden bu bilgisayarı geçici olarak engellemiş olabilir (ör. fail2ban); birkaç dakika sonra tekrar dene.";
        if (text.Contains("did not start SFTP")) return "Bu sunucu SFTP'yi açmadı (sshd_config içinde 'Subsystem sftp' olmalı).";
        if (text.StartsWith("key file ")) return "Anahtar dosyası okunamadı: " + text["key file ".Length..];
        if (text.StartsWith("jump host ")) return "Atlama sunucusu: " + text["jump host ".Length..];
        if (text.StartsWith("cannot listen on")) return "Port dinlenemiyor:" + text["cannot listen on".Length..];
        if (text.StartsWith("connection failed: ")) return "Bağlanılamadı: " + text["connection failed: ".Length..];
        if (text.StartsWith("ssh error: server refused the remote forward")) return "Sunucu uzak tüneli reddetti (sshd_config içinde AllowTcpForwarding açık olmalı; port kullanımda olabilir).";
        if (text.Contains("a saved tunnel needs a fixed local port")) return "Kaydedilen tünel için sabit bir yerel port gir.";
        if (text.Contains("a saved tunnel needs a fixed server port")) return "Kaydedilen uzak tünel için sabit bir sunucu portu gir.";
        if (text.Contains("the port on this computer is required")) return "Bu bilgisayardaki servis portunu gir.";
        if (text.Contains("remote host and port are required")) return "Uzak adres ve port gerekli.";
        if (text.Contains("is already used by a saved tunnel")) return "Bu yerel port başka bir kayıtlı tünelde kullanılıyor.";
        if (text.StartsWith("invalid variable name: ")) return "Geçersiz ortam değişkeni adı: " + text["invalid variable name: ".Length..];
        if (text.Contains("not a WECOMMANDER backup file")) return "Bu dosya bir WECOMMANDER yedeği değil.";
        if (text.Contains("made by a newer version")) return "Bu yedek daha yeni bir sürümle alınmış; önce uygulamayı güncelle.";
        if (text.Contains("backup file is too large")) return "Yedek dosyası çok büyük.";
        if (text == "terminal closed") return "Terminal kapalı.";
        if (text == "wrong sync passphrase") return "Eşitleme parolası yanlış (diğer bilgisayarda belirlediğin parolayı gir).";
        if (text.Contains("sync passphrase needs at least 8")) return "Eşitleme parolası en az 8 karakter olmalı.";
        if (text.Contains("sync passphrase was changed on another computer")) return "Eşitleme parolası başka bir bilgisayarda değiştirildi; yeni parolayı gir.";
        if (text.Contains("sync is not set up")) return "Bu bilgisayarda eşitleme açık değil.";
        if (text.Contains("synced by a newer version")) return "Kütüphane daha yeni bir sürümle eşitlenmiş; önce uygulamayı güncelle.";
        if (text.StartsWith("sync conflict")) return "Eşitleme çakıştı; birazdan yeniden denenecek.";
        if (text.Contains("does not have the team key yet")) return "Bu uygulamada ekip anahtarı henüz yok; ekipten biri uygulamasını açınca gelir.";
        if (text.Contains("sealed for another app")) return "Ekip anahtarı bu uygulama için değil; ekipten birinin uygulamasını açmasını bekle.";
        if (text.Contains("identity needs a valid user name")) return "Kimlik için geçerli bir kullanıcı adı gir.";
        if (text.Contains("choose a key for this identity")) return "Bu kimlik için bir anahtar seç (Anahtarlar sayfasından oluşturabilirsin).";
        return text;
    }
}

// ---- protocol models (docs/CORE_PROTOCOL.md) ----

public sealed record CoreHost(string Id, string Label, string Target, string AuthKind, bool SavedSecret,
    string? KeyPath, string? JumpId, string? TrustedKey, string? Group = null, string User = "", string Host = "", int Port = 22,
    string? KeyId = null, string? StartupCommand = null, Dictionary<string, string>? Env = null,
    bool AgentForwarding = false, string? IdentityId = null, bool Team = false,
    string Protocol = "ssh", SerialSettings? Serial = null, bool SessionLog = false)
{
    /// <summary>SSH hosts log in; Telnet, serial and Mosh hosts open straight away.</summary>
    public bool IsSsh => Protocol is "ssh" or "" or null;
    /// <summary>Hosts without a group are listed under this name.</summary>
    public const string NoGroup = "Gruplanmamış";
    public string GroupName => string.IsNullOrWhiteSpace(Group) ? NoGroup : Group!;

    public bool CanConnectSilently => SavedSecret || (AuthKind == "key" && KeyPath is not null);
}

public sealed record ConnectResult(string Status, string? SessionId, string? Fingerprint, string? Algorithm,
    string? Trusted, string? Output)
{
    public bool NeedsHostKeyApproval => Status is "hostKeyUnknown" or "hostKeyChanged";
}

public sealed record RemoteEntry(string Name, string Path, string Kind, ulong Size, ulong? Modified, string Permissions)
{
    public bool IsFolder => Kind == "dir";
}

public sealed record RemoteListing(string Path, string Parent, List<RemoteEntry> Entries);

/// <summary>A running forward; Kind is local (ssh -L), remote (ssh -R) or dynamic (ssh -D, SOCKS5).</summary>
public sealed record ForwardInfo(string Local, string Remote, string Id = "", string Kind = "local")
{
    public string StopId => string.IsNullOrEmpty(Id) ? Local : Id;
}

/// <summary>What a new tunnel does, as typed in the tunnel dialog.</summary>
public sealed record TunnelRequest(string Kind, int LocalPort, string RemoteHost, int RemotePort, string? LocalHost = null);

/// <summary>A user name with a key or password, shared by many hosts.</summary>
public sealed record Identity(string Id, string Label, string User, string AuthKind, string? KeyId = null);

/// <summary>Counts from a backup import.</summary>
public sealed record ImportSummary(int Hosts, int Snippets, int KnownHosts, int Skipped);

public sealed record SavedTunnel(string HostId, string HostLabel, int Index, string Local, string Remote, bool Running, string Kind = "local");

public sealed record ImportResult(int Added, int Skipped, List<CoreHost> Hosts);

public sealed record KnownHost(string Target, string Fingerprint, List<string> Labels);

public sealed record Snippet(string Id, string Label, string Command, bool Team = false);

/// <summary>A key made or imported in the app; the private half is in the OS keyring.</summary>
/// <summary>A serial port and its line settings.</summary>
public sealed record SerialSettings(string Device, int Baud, int DataBits = 8, string Parity = "none", int StopBits = 1, string Flow = "none");

public sealed record KeyMeta(string Id, string Label, string Algorithm, string Fingerprint, string PublicKey, long Created);

public sealed record HistoryEntry(string HostId, string Label, string Target, long At)
{
    public DateTimeOffset When => DateTimeOffset.FromUnixTimeSeconds(At);
}
