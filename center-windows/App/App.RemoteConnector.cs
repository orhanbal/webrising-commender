using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// "Bu bilgisayar" as the connector (Hybrid Access H3): while signed in, a
/// background loop publishes the saved SSH hosts shared with remote AI and
/// runs the calls Claude/ChatGPT make through wecommander.app in the core
/// (RemoteConnector). It stops on sign-out or when the account changes.
/// Approvals are never given here by the loop: they come from the person's
/// click on the approval notification (the gateway's approval requests).
/// </summary>
public partial class App
{
    private RemoteConnector? _connector;
    private CancellationTokenSource? _connectorStop;
    private string? _connectorToken;

    /// <summary>From the tick: start the loop once signed in and the core runs; stop it on sign-out.</summary>
    private void EnsureRemoteConnector()
    {
        AiAccessRules.CurrentCenterId = Me?.CenterId;
        var token = Token;
        if (_connectorStop is not null && token == _connectorToken) return;
        StopRemoteConnector();
        if (token is null || Servers.CoreTransport is not { } core) return;
        _connector = new RemoteConnector(core, LogCrash);
        _connectorStop = new CancellationTokenSource();
        _connectorToken = token;
        var connector = _connector;
        var transport = new GatewayConnectorTransport(Gateway, token);
        var stop = _connectorStop.Token;
        _ = Task.Run(async () =>
        {
            try { await connector.RunAsync(transport, () => Me?.CenterId, stop); }
            catch (Exception e) { LogCrash(e); }
        });
    }

    private void StopRemoteConnector()
    {
        _connectorStop?.Cancel();
        _connectorStop?.Dispose();
        _connectorStop = null;
        _connectorToken = null;
        _connector = null;
    }
}
