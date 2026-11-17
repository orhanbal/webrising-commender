using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Runs one command on a saved SSH host for a scheduled task through
/// wecommander-core's <c>hosts.exec</c>: a non-interactive SSH exec channel
/// (no terminal, no startup command, no history entry, no session log) with
/// the saved login only; nothing is ever asked.
/// </summary>
public sealed partial class ServersController : IRemoteExecutor
{
    /// <summary>The <c>hosts.exec</c> result (docs/CORE_PROTOCOL.md).</summary>
    private sealed record HostExecResult(int? ExitCode, string? Output, bool TimedOut, bool Truncated);

    public async Task<RemoteExecResult> RunAsync(string hostId, string command, TimeSpan timeout, CancellationToken ct)
    {
        var host = Hosts.FirstOrDefault(h => h.Id == hostId);
        if (host is null)
        {
            try { Hosts = await Core.CallAsync<List<CoreHost>>("hosts.list"); } catch (CoreException) { }
            host = Hosts.FirstOrDefault(h => h.Id == hostId);
        }
        if (host is null) return new RemoteExecResult(null, "", HostExecText.Error("host_not_found: "));
        if (!host.IsSsh) return new RemoteExecResult(null, "", HostExecText.Error("not_ssh: "));

        var seconds = (int)Math.Clamp(timeout.TotalSeconds, 1, 3600);
        HostExecResult r;
        try
        {
            // The core ends the command at the timeout; the extra time covers connecting.
            r = await Core.CallAsync<HostExecResult>("hosts.exec", new { hostId, command, timeoutSec = seconds })
                .WaitAsync(TimeSpan.FromSeconds(seconds) + TimeSpan.FromMinutes(2), ct);
        }
        catch (CoreException e) { return new RemoteExecResult(null, "", HostExecText.Error(e.Raw)); }
        catch (TimeoutException) { return new RemoteExecResult(null, "", HostExecText.NoAnswer); }
        return HostExecText.Result(r.ExitCode, r.Output ?? "", r.TimedOut, seconds);
    }
}
