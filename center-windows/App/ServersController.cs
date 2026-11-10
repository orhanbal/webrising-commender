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
                    var json = JsonSerializer.Serialize(new { type = "output", data = (string?)data?["data"] ?? "" });
                    t.Ui.TryEnqueue(() => t.Tab.Post(json));
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
                        if (t.Tab.Item is not null) t.Tab.Item.Header = t.Tab.Host.Label + " (kapandı)";
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
        if (tab.Closed) return;
        _ = Core.CallAsync("terminal.write", new { sessionId = tab.SessionId, data }).ContinueWith(_ => { });
    }

    public void Resize(TerminalTab tab, int cols, int rows)
    {
        if (tab.Closed) return;
        _ = Core.CallAsync("terminal.resize", new { sessionId = tab.SessionId, cols, rows }).ContinueWith(_ => { });
    }

    public void Close(TerminalTab tab)
    {
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

    public async Task<List<ForwardInfo>> StartForward(TerminalTab tab, int localPort, string remoteHost, int remotePort, bool save)
    {
        var list = await Core.CallAsync<List<ForwardInfo>>("forward.start", new { sessionId = tab.SessionId, localPort, remoteHost, remotePort });
        if (save && list.Count > 0 && int.TryParse(list[^1].Local.Split(':')[^1], out var port))
        {
            SavedTunnels = await Core.CallAsync<List<SavedTunnel>>("tunnels.save", new { hostId = tab.Host.Id, localPort = port, remoteHost, remotePort });
            Changed?.Invoke();
        }
        return list;
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

    public void Dispose() => _core?.Dispose();
}
