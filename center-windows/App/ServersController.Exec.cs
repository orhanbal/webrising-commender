using System.Collections.Concurrent;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Runs one command on a saved SSH host for a scheduled task, with no window.
/// wecommander-core has no plain "exec" call, so this opens a hidden terminal
/// session with the saved login (nothing is ever asked), types one line that
/// replaces the shell with <c>sh -c</c> around the command (MarkedCommand) and
/// reads the output between the markers. The session ends with the command.
/// </summary>
public sealed partial class ServersController : IRemoteExecutor
{
    /// <summary>Hidden sessions of scheduled tasks: raw output bytes, null when the session ended.</summary>
    private readonly ConcurrentDictionary<string, Action<byte[]?>> _captures = new();

    public static string NeedsSavedLogin =>
        L.T("Bu sunucuya parola sorulmadan bağlanılamıyor. Zamanlanmış görevler için girişi bu bilgisayarda kaydet (parolayı sakla ya da SSH anahtarı kullan).");

    public async Task<RemoteExecResult> RunAsync(string hostId, string command, TimeSpan timeout, CancellationToken ct)
    {
        var host = Hosts.FirstOrDefault(h => h.Id == hostId);
        if (host is null)
        {
            try { Hosts = await Core.CallAsync<List<CoreHost>>("hosts.list"); } catch (CoreException) { }
            host = Hosts.FirstOrDefault(h => h.Id == hostId);
        }
        if (host is null)
            return new RemoteExecResult(null, "", L.T("Bu sunucu bu bilgisayarın kayıtlı sunucuları arasında yok (silinmiş olabilir)."));
        if (!host.IsSsh)
            return new RemoteExecResult(null, "", L.T("Zamanlanmış görevler yalnız SSH ile bağlanılan sunucularda çalışır."));
        if (host.AuthKind == "password" && !host.SavedSecret && host.IdentityId is null)
            return new RemoteExecResult(null, "", NeedsSavedLogin);

        ConnectResult opened;
        try
        {
            var auth = new { kind = host.AuthKind == "password" ? "password" : "key", secret = "", remember = false };
            opened = await Core.CallAsync<ConnectResult>("connect",
                    new { id = host.Id, auth, acceptFingerprint = (string?)null, mode = "terminal", cols = 400, rows = 50 })
                .WaitAsync(TimeSpan.FromMinutes(2), ct);
        }
        catch (CoreException e) when (e.Raw.Contains("no saved credential") || e.Raw.Contains("authentication failed")
                                      || e.Raw.Contains("private key could not be used"))
        {
            return new RemoteExecResult(null, "", NeedsSavedLogin + " (" + e.Message + ")");
        }
        catch (CoreException e)
        {
            return new RemoteExecResult(null, "", L.T("Sunucuya bağlanılamadı: ") + e.Message);
        }
        catch (TimeoutException)
        {
            return new RemoteExecResult(null, "", L.T("Sunucuya bağlanılamadı: bağlantı iki dakikada kurulamadı."));
        }
        if (opened.NeedsHostKeyApproval)
            return new RemoteExecResult(null, "", L.T("Bu sunucunun anahtarı henüz onaylanmadı ya da değişti. Bir kez terminalden bağlanıp anahtarı onayla."));
        if (opened.SessionId is not { } sid)
            return new RemoteExecResult(null, "", L.T("Sunucuda terminal oturumu açılamadı."));

        var marked = new MarkedCommand();
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new object();
        var ended = false;
        _captures[sid] = bytes =>
        {
            lock (gate)
            {
                if (bytes is null) { ended = true; marked.Close(); done.TrySetResult(); return; }
                marked.Append(bytes);
                if (marked.Finished) done.TrySetResult();
            }
        };
        try
        {
            await Core.CallAsync("terminal.write", new { sessionId = sid, data = marked.Line(command) });
            var timedOut = false;
            try { await done.Task.WaitAsync(timeout, ct); }
            catch (TimeoutException) { timedOut = true; }
            lock (gate)
            {
                if (marked.Finished) return new RemoteExecResult(marked.ExitCode, marked.Output, null);
                if (timedOut)
                    return new RemoteExecResult(null, marked.Output, L.F("Zaman aşımı: komut {0} saniyede bitmedi ve durduruldu.", (int)timeout.TotalSeconds), TimedOut: true);
                return new RemoteExecResult(null, marked.Output, marked.Started || ended
                    ? L.T("Bağlantı komut bitmeden kapandı.")
                    : L.T("Komut başlatılamadı."));
            }
        }
        catch (CoreException e)
        {
            return new RemoteExecResult(null, "", L.T("Komut çalıştırılamadı: ") + e.Message);
        }
        finally
        {
            _captures.TryRemove(sid, out _);
            // Ends the remote command too when it is still running (timeout).
            try { await Core.CallAsync("terminal.close", new { sessionId = sid }); } catch (Exception) { }
        }
    }
}
