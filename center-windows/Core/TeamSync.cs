namespace Wecommander.Center.Core;

/// <summary>A22: this app's team key pair and whether it has the team key.</summary>
public sealed record TeamKeyStatus(string PublicKey, bool HasKey);

/// <summary>What one team round did.</summary>
public enum TeamSyncState
{
    /// <summary>Not in a team the server knows, or nothing to do.</summary>
    Ok,
    /// <summary>Another member has to open their app once to give this one the team key.</summary>
    WaitingForKey,
}

/// <summary>Talks to /api/center/team for one round (tests use a stand-in).</summary>
public interface ITeamServer
{
    Task<TeamState> GetAsync();
    Task PutKeyAsync(string publicKey);
    Task PutWrappedKeyAsync(string centerId, string wrappedKey);
    Task<(bool Accepted, LibraryState State)> PutLibraryAsync(long baseRevision, string envelope);
}

/// <summary>
/// One team round: publish this app's public key, get (or create) the team
/// key, give it to team apps that do not have it yet, then merge the shared
/// library like the personal one. Viewers receive changes but cannot upload.
/// </summary>
public static class TeamSync
{
    public static async Task<(TeamSyncState State, bool Changed)> RunAsync(CoreClient core, ITeamServer server)
    {
        var me = await core.CallAsync<TeamKeyStatus>("team.status").ConfigureAwait(false);
        var team = await server.GetAsync().ConfigureAwait(false);
        if (!team.Members.Any(m => m.PublicKey == me.PublicKey))
        {
            await server.PutKeyAsync(me.PublicKey).ConfigureAwait(false);
            team = await server.GetAsync().ConfigureAwait(false);
        }
        var mine = team.Members.FirstOrDefault(m => m.PublicKey == me.PublicKey);
        if (team.MyWrappedKey is { } sealedForMe)
        {
            me = await core.CallAsync<TeamKeyStatus>("team.accept", new { @sealed = sealedForMe }).ConfigureAwait(false);
        }
        else if (me.HasKey && mine is not null && team.CanEdit && team.Members.Any(m => m.HasKey))
        {
            // The server lost this app's copy (e.g. re-registered): give it back.
            var again = await core.CallAsync<SealedReply>("team.share", new { publicKey = me.PublicKey }).ConfigureAwait(false);
            await server.PutWrappedKeyAsync(mine.CenterId, again.Sealed).ConfigureAwait(false);
        }
        else if (!team.Members.Any(m => m.HasKey) && team.CanEdit && mine is not null)
        {
            // The first app of the team makes the team key.
            var created = await core.CallAsync<SealedReply>("team.create").ConfigureAwait(false);
            await server.PutWrappedKeyAsync(mine.CenterId, created.Sealed).ConfigureAwait(false);
            me = me with { HasKey = true };
        }
        else if (!me.HasKey)
        {
            return (TeamSyncState.WaitingForKey, false);
        }

        if (team.CanEdit)
        {
            foreach (var m in team.Members.Where(m => !m.HasKey && m.PublicKey != me.PublicKey))
            {
                var share = await core.CallAsync<SealedReply>("team.share", new { publicKey = m.PublicKey }).ConfigureAwait(false);
                await server.PutWrappedKeyAsync(m.CenterId, share.Sealed).ConfigureAwait(false);
            }
        }

        var state = new LibraryState(team.Revision, team.Envelope);
        var changed = false;
        for (var round = 0; round < LibrarySync.MaxRounds; round++)
        {
            var merge = await core.CallAsync<SyncMergeResult>("team.merge", new { remote = state.Envelope }).ConfigureAwait(false);
            changed |= merge.ChangedHere;
            if (merge.Envelope is null || !team.CanEdit) return (TeamSyncState.Ok, changed);
            var (accepted, now) = await server.PutLibraryAsync(state.Revision, merge.Envelope).ConfigureAwait(false);
            if (accepted)
            {
                await core.CallAsync("team.committed").ConfigureAwait(false);
                return (TeamSyncState.Ok, changed);
            }
            state = now;
        }
        throw new CoreException("sync conflict: try again");
    }

    private sealed record SealedReply(string Sealed);
}
