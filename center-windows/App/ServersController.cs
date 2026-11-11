using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Owns wecommander-core for the app's lifetime (so saved tunnels keep
/// running with the window closed) and routes its events to terminal tabs.
/// </summary>
public sealed class ServersController : IDisposable
{
    private CoreClient? _core;
    private readonly ConcurrentDictionary<string, (TerminalTab Tab, DispatcherQueue Ui)> _tabs = new();

    public List<CoreHost> Hosts { get; private set; } = [];
    public List<SavedTunnel> SavedTunnels { get; private set; } = [];
    public string VaultLabel { get; private set; } = "";
    public string? StartError { get; private set; }
    public ConcurrentDictionary<string, Action<ulong, ulong>> Progress { get; } = new();

    /// <summary>Hosts or saved tunnels changed (any thread).</summary>
    public event Action? Changed;
    /// <summary>Something to tell the person (any thread).</summary>
    public event Action<string>? Notice;

    public void Start()
    {
        if (_core is not null) return;
        var exe = Path.Combine(AppContext.BaseDirectory, "wecommander-core.exe");
        if (!File.Exists(exe))
        {
            StartError = "Uygulama çekirdeği (wecommander-core.exe) bulunamadı.";
            return;
        }
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WECOMMANDER", "core");
        try
        {
            _core = CoreClient.Start(exe, data);
            _core.Event += OnEvent;
            _ = Reload();
        }
        catch (Exception e)
        {
            StartError = "Uygulama çekirdeği başlatılamadı: " + e.Message;
        }
    }

    private CoreClient Core => _core ?? throw new CoreException(CoreException.Stopped);

    private void OnEvent(string name, JsonNode? data)
    {
        switch (name)
        {
            case "ready":
                VaultLabel = (string?)data?["vaultBackend"] ?? "";
                break;
            case "terminal-output":
            {
                var sid = (string?)data?["sessionId"];
                if (sid is not null && _tabs.TryGetValue(sid, out var t))
                {
                    var b64 = (string?)data?["data"] ?? "";
                    var json = JsonSerializer.Serialize(new { type = "output", data = b64 });
                    t.Ui.TryEnqueue(() => t.Tab.Post(json));
                    if (t.Tab.Hosting is { } share) _ = share.SendOutputAsync(b64);
                }
                break;
            }
            case "terminal-exit":
            {
                var sid = (string?)data?["sessionId"];
                if (sid is not null && _tabs.TryGetValue(sid, out var t))
                {
                    var code = data?["code"] is JsonValue v && v.TryGetValue(out int c) ? $", çıkış kodu {c}" : "";
                    var json = JsonSerializer.Serialize(new { type = "text", data = $"\r\n\u001b[90m[Bağlantı kapandı{code}. Sekmeyi kapatabilirsin.]\u001b[0m\r\n" });
                    t.Ui.TryEnqueue(() =>
                    {
                        t.Tab.Closed = true;
                        t.Tab.Post(json);
                        t.Tab.Exited?.Invoke();
                    });
                }
                break;
            }
            case "transfer-progress":
            {
                var id = (string?)data?["transferId"];
                if (id is not null && Progress.TryGetValue(id, out var report))
                    report((ulong?)data?["done"] ?? 0, (ulong?)data?["total"] ?? 0);
                break;
            }
            case "changed":
            case "tunnels-changed":
                _ = Reload();
                break;
        }
    }

    public async Task Reload()
    {
        try
        {
            Hosts = await Core.CallAsync<List<CoreHost>>("hosts.list");
            SavedTunnels = await Core.CallAsync<List<SavedTunnel>>("tunnels.saved");
            Changed?.Invoke();
        }
        catch (CoreException e) { Notice?.Invoke(e.Message); }
    }

    public async Task AddHost(string label, string host, int port, string user, string authKind, string? jumpId)
    {
        Hosts = await Core.CallAsync<List<CoreHost>>("hosts.add", new { label, host, port, user, authKind, jumpId });
        Changed?.Invoke();
    }

    public async Task DeleteHost(CoreHost host)
    {
        try { Hosts = await Core.CallAsync<List<CoreHost>>("hosts.delete", new { id = host.Id }); Changed?.Invoke(); }
        catch (CoreException e) { Notice?.Invoke(e.Message); }
    }

    public async Task ForgetSecret(CoreHost host)
    {
        try { Hosts = await Core.CallAsync<List<CoreHost>>("secret.forget", new { id = host.Id }); Changed?.Invoke(); }
        catch (CoreException e) { Notice?.Invoke(e.Message); }
    }

    public async Task<string> ImportSshConfig()
    {
        try
        {
            var r = await Core.CallAsync<ImportResult>("hosts.import");
            Hosts = r.Hosts;
            Changed?.Invoke();
            return r.Added > 0
                ? $"{r.Added} sunucu içe aktarıldı" + (r.Skipped > 0 ? $", {r.Skipped} zaten vardı." : ".")
                : "Yeni sunucu bulunamadı.";
        }
        catch (CoreException e) { return "~/.ssh/config okunamadı: " + e.Message; }
    }

    public Task<ConnectResult> Connect(CoreHost host, object auth, string? accept) =>
        Core.CallAsync<ConnectResult>("connect", new { id = host.Id, auth, acceptFingerprint = accept, mode = "terminal", cols = 100, rows = 30 });

    public void Register(TerminalTab tab, DispatcherQueue ui) => _tabs[tab.SessionId] = (tab, ui);

    public void Write(TerminalTab tab, string data)
    {
        if (tab.Guest is { } guest) { _ = guest.SendInputAsync(data); return; }
        if (tab.Closed) return;
        _ = Core.CallAsync("terminal.write", new { sessionId = tab.SessionId, data }).ContinueWith(_ => { });
    }

    public void Resize(TerminalTab tab, int cols, int rows)
    {
        if (tab.Closed || tab.Guest is not null) return;
        _ = Core.CallAsync("terminal.resize", new { sessionId = tab.SessionId, cols, rows }).ContinueWith(_ => { });
    }

    public void Close(TerminalTab tab)
    {
        if (tab.Guest is { } guest) { tab.Guest = null; tab.Closed = true; _ = guest.DisposeAsync().AsTask(); return; }
        if (tab.Hosting is not null) _ = StopSharing(tab);
        _tabs.TryRemove(tab.SessionId, out _);
        if (!tab.Closed) _ = Core.CallAsync("terminal.close", new { sessionId = tab.SessionId }).ContinueWith(_ => { });
        tab.Closed = true;
    }

    public Task<RemoteListing> ListFiles(TerminalTab tab, string? path) =>
        Core.CallAsync<RemoteListing>("files.list", new { sessionId = tab.SessionId, path });

    public Task FilesAction(TerminalTab tab, string method, object parameters) => Core.CallAsync(method, parameters);

    public async Task<List<ForwardInfo>> Forwards(TerminalTab tab)
    {
        try { return await Core.CallAsync<List<ForwardInfo>>("forward.list", new { sessionId = tab.SessionId }); }
        catch (CoreException) { return []; }
    }

    public async Task<List<ForwardInfo>> StartForward(TerminalTab tab, TunnelRequest t, bool save)
    {
        var list = await Core.CallAsync<List<ForwardInfo>>("forward.start", new
        {
            sessionId = tab.SessionId, kind = t.Kind, localPort = t.LocalPort, localHost = t.LocalHost,
            remoteHost = t.RemoteHost, remotePort = t.RemotePort,
        });
        if (save && list.Count > 0)
        {
            var started = list[^1];
            var localPort = t.LocalPort;
            var remotePort = t.RemotePort;
            // A free port picked by the system is saved as that port.
            if (t.Kind != "remote" && localPort == 0 && int.TryParse(started.Local.Split(':')[^1], out var lp)) localPort = lp;
            if (t.Kind == "remote" && remotePort == 0 && int.TryParse(started.Local.Split(' ')[0].Split(':')[^1], out var rp)) remotePort = rp;
            SavedTunnels = await Core.CallAsync<List<SavedTunnel>>("tunnels.save", new
            {
                hostId = tab.Host.Id, kind = t.Kind, localPort, localHost = t.LocalHost, remoteHost = t.RemoteHost, remotePort,
            });
            Changed?.Invoke();
        }
        return list;
    }

    // ---- A20 sync ----

    public async Task<SyncStatus> SyncStatus()
    {
        try { return await Core.CallAsync<SyncStatus>("sync.status"); }
        catch (CoreException) { return new SyncStatus(false, false); }
    }

    /// <summary>Turns sync on with the passphrase (checked against the server's library when there is one).</summary>
    public async Task SetupSync(GatewayClient gateway, string token, string passphrase)
    {
        var remote = await gateway.LibraryAsync(token);
        await Core.CallAsync<SyncStatus>("sync.setup", new { passphrase, remote = remote.Envelope });
        await SyncLibrary(gateway, token);
    }

    public Task ForgetSync() => Core.CallAsync("sync.forget");

    private readonly SemaphoreSlim _syncGate = new(1, 1);
    public DateTime? LastLibrarySync { get; private set; }

    /// <summary>One sync round; does nothing when sync is off on this computer.</summary>
    public async Task SyncLibrary(GatewayClient gateway, string token)
    {
        if (!await _syncGate.WaitAsync(0)) return;
        try
        {
            if (!(await SyncStatus()).Configured) return;
            var changed = await LibrarySync.RunAsync(Core, () => gateway.LibraryAsync(token), (rev, env) => gateway.PutLibraryAsync(token, rev, env));
            LastLibrarySync = DateTime.Now;
            if (changed) await Reload();
        }
        finally { _syncGate.Release(); }
    }

    // ---- A27 shared terminals ----

    /// <summary>Shares this terminal with the team; guests see it live (and type when allowed).</summary>
    public async Task StartSharing(TerminalTab tab, bool allowInput)
    {
        if (App.Current.Credentials() is not { } c) throw new CoreException("Önce oturum aç.");
        if (!(await Core.CallAsync<TeamKeyStatus>("team.status")).HasKey)
            throw new CoreException("Paylaşmak için ekip anahtarı gerekli: Ayarlar → Ekip'te eşitlemenin tamamlanmasını bekle.");
        var id = await c.Gateway.CreateShareAsync(c.Token, tab.Host.Label);
        var share = await TerminalShare.ConnectAsync(Core, c.Gateway.ShareSocketUri(id, "host"), c.Token, id, host: true);
        share.AllowInput = allowInput;
        share.Input += keys => Write(tab, keys);
        tab.Hosting = share;
    }

    public async Task StopSharing(TerminalTab tab)
    {
        if (tab.Hosting is not { } share) return;
        tab.Hosting = null;
        if (App.Current.Credentials() is { } c) await c.Gateway.EndShareAsync(c.Token, share.Id);
        await share.DisposeAsync();
    }

    public async Task<List<ShareInfo>> Shares() =>
        App.Current.Credentials() is { } c ? await c.Gateway.SharesAsync(c.Token) : [];

    public async Task<TerminalShare> JoinShare(ShareInfo info)
    {
        if (App.Current.Credentials() is not { } c) throw new CoreException("Önce oturum aç.");
        return await TerminalShare.ConnectAsync(Core, c.Gateway.ShareSocketUri(info.Id, "guest"), c.Token, info.Id, host: false);
    }

    // ---- A22 team ----

    /// <summary>Last team round, shown in Settings.</summary>
    public string? TeamName { get; private set; }
    public string? TeamRole { get; private set; }
    public List<TeamMember> TeamMembers { get; private set; } = [];
    public TeamSyncState? TeamState { get; private set; }

    private sealed class TeamServer(GatewayClient g, string token) : ITeamServer
    {
        public Task<TeamState> GetAsync() => g.TeamAsync(token);
        public Task PutKeyAsync(string publicKey) => g.PutTeamKeyAsync(token, publicKey);
        public Task PutWrappedKeyAsync(string centerId, string wrappedKey) => g.PutWrappedKeyAsync(token, centerId, wrappedKey);
        public Task<(bool Accepted, LibraryState State)> PutLibraryAsync(long baseRevision, string envelope) => g.PutTeamLibraryAsync(token, baseRevision, envelope);
    }

    private readonly SemaphoreSlim _teamGate = new(1, 1);

    /// <summary>One team round (key exchange + shared library).</summary>
    public async Task SyncTeam(GatewayClient gateway, string token)
    {
        if (!await _teamGate.WaitAsync(0)) return;
        try
        {
            var server = new TeamServer(gateway, token);
            try
            {
                var (state, changed) = await TeamSync.RunAsync(Core, server);
                TeamState = state;
                var info = await gateway.TeamAsync(token);
                (TeamName, TeamRole, TeamMembers) = (info.OrganizationName, info.Role, info.Members);
                if (changed) await Reload();
            }
            catch (GatewayException e) when (e.Code == "not_a_member")
            {
                await Core.CallAsync("team.leave");
                (TeamName, TeamRole, TeamMembers, TeamState) = (null, null, [], null);
                await Reload();
            }
        }
        finally { _teamGate.Release(); }
    }

    /// <summary>Shares a host or snippet with the team (or takes it back).</summary>
    public async Task SetTeam(string kind, string id, bool team)
    {
        Hosts = await Core.CallAsync<List<CoreHost>>("library.setTeam", new { kind, id, team });
        Changed?.Invoke();
    }

    public Task<List<Identity>> Identities() => Core.CallAsync<List<Identity>>("identities.list");

    public Task<List<Identity>> SaveIdentity(string? id, string label, string user, string authKind, string? keyId, string? password) =>
        Core.CallAsync<List<Identity>>("identities.save", new { id, label, user, authKind, keyId, password });

    public async Task<List<Identity>> DeleteIdentity(Identity identity)
    {
        var list = await Core.CallAsync<List<Identity>>("identities.delete", new { id = identity.Id });
        await Reload();
        return list;
    }

    public async Task SetHostIdentity(CoreHost host, string? identityId)
    {
        Hosts = await Core.CallAsync<List<CoreHost>>("hosts.setIdentity", new { id = host.Id, identityId });
        Changed?.Invoke();
    }

    /// <summary>Terminal options of a host: startup command, environment variables, agent forwarding.</summary>
    public async Task SetHostOptions(CoreHost host, string? startupCommand, Dictionary<string, string> env, bool agentForwarding)
    {
        Hosts = await Core.CallAsync<List<CoreHost>>("hosts.setOptions", new { id = host.Id, startupCommand, env, agentForwarding });
        Changed?.Invoke();
    }

    /// <summary>The library as JSON (hosts, groups, tunnels, snippets, trusted keys; no secrets).</summary>
    public async Task<string> ExportLibrary() =>
        (await Core.CallAsync<JsonElement>("library.export")).GetProperty("json").GetString() ?? "{}";

    public async Task<ImportSummary> ImportLibrary(string json)
    {
        var summary = await Core.CallAsync<ImportSummary>("library.import", new { json });
        await Reload();
        return summary;
    }

    public async Task<List<ForwardInfo>> StopForward(TerminalTab tab, string local)
    {
        try { return await Core.CallAsync<List<ForwardInfo>>("forward.stop", new { sessionId = tab.SessionId, local }); }
        catch (CoreException) { return []; }
    }

    public async Task ToggleTunnel(SavedTunnel tunnel)
    {
        try
        {
            SavedTunnels = await Core.CallAsync<List<SavedTunnel>>("tunnels.toggle", new { hostId = tunnel.HostId, index = tunnel.Index });
            Changed?.Invoke();
        }
        catch (CoreException e) { Notice?.Invoke("Tünel açılamadı: " + e.Message); }
    }

    // ---- the host library (edit, groups, trusted keys, snippets, history) ----

    public async Task UpdateHost(CoreHost host, string label, string address, int port, string user, string authKind, string? jumpId, string? group)
    {
        Hosts = await Core.CallAsync<List<CoreHost>>("hosts.update", new { id = host.Id, label, host = address, port, user, authKind, jumpId, group });
        Changed?.Invoke();
    }

    public async Task<List<KnownHost>> KnownHosts()
    {
        try { return await Core.CallAsync<List<KnownHost>>("known.list"); }
        catch (CoreException e) { Notice?.Invoke(e.Message); return []; }
    }

    public async Task<List<KnownHost>> ForgetKnownHost(KnownHost known)
    {
        var list = await Core.CallAsync<List<KnownHost>>("known.forget", new { target = known.Target });
        await Reload();
        return list;
    }

    public async Task<List<Snippet>> Snippets()
    {
        try { return await Core.CallAsync<List<Snippet>>("snippets.list"); }
        catch (CoreException e) { Notice?.Invoke(e.Message); return []; }
    }

    public Task<List<Snippet>> SaveSnippet(string? id, string label, string command) =>
        Core.CallAsync<List<Snippet>>("snippets.save", new { id, label, command });

    public Task<List<Snippet>> DeleteSnippet(Snippet snippet) =>
        Core.CallAsync<List<Snippet>>("snippets.delete", new { id = snippet.Id });

    public async Task<List<HistoryEntry>> History()
    {
        try { return await Core.CallAsync<List<HistoryEntry>>("history.list"); }
        catch (CoreException e) { Notice?.Invoke(e.Message); return []; }
    }

    public Task<List<HistoryEntry>> ClearHistory() => Core.CallAsync<List<HistoryEntry>>("history.clear");

    public async Task<List<KeyMeta>> Keys()
    {
        try { return await Core.CallAsync<List<KeyMeta>>("keys.list"); }
        catch (CoreException e) { Notice?.Invoke(e.Message); return []; }
    }

    public Task<List<KeyMeta>> GenerateKey(string label) => Core.CallAsync<List<KeyMeta>>("keys.generate", new { label });

    public Task<List<KeyMeta>> ImportKey(string label, string privateKey, string? passphrase) =>
        Core.CallAsync<List<KeyMeta>>("keys.import", new { label, @private = privateKey, passphrase });

    public async Task<List<KeyMeta>> DeleteKey(KeyMeta key)
    {
        var list = await Core.CallAsync<List<KeyMeta>>("keys.delete", new { id = key.Id });
        await Reload();
        return list;
    }

    public async Task SetHostKey(CoreHost host, string? keyId)
    {
        Hosts = await Core.CallAsync<List<CoreHost>>("hosts.setKey", new { id = host.Id, keyId });
        Changed?.Invoke();
    }

    public async Task DeleteTunnel(SavedTunnel tunnel)
    {
        try
        {
            SavedTunnels = await Core.CallAsync<List<SavedTunnel>>("tunnels.delete", new { hostId = tunnel.HostId, index = tunnel.Index });
            Changed?.Invoke();
        }
        catch (CoreException e) { Notice?.Invoke(e.Message); }
    }

    public void Dispose() => _core?.Dispose();
}
