namespace Wecommander.Center.Core;

/// <summary>A20 sync state on this computer.</summary>
public sealed record SyncStatus(bool Configured, bool Persistent);

/// <summary>What wecommander-core made of the server's library.</summary>
public sealed record SyncMergeResult(string? Envelope, bool ChangedHere);

/// <summary>
/// One sync round between this computer and the server: the core decrypts and
/// merges the server's library into this one and returns what to upload; when
/// another computer uploaded in between, the server's newer library is merged
/// in and the upload tried again. The server only ever sees encrypted data.
/// </summary>
public static class LibrarySync
{
    public const int MaxRounds = 4;

    /// <returns>True when this computer's library changed.</returns>
    public static async Task<bool> RunAsync(
        CoreClient core,
        Func<Task<LibraryState>> get,
        Func<long, string, Task<(bool Accepted, LibraryState State)>> put)
    {
        var state = await get().ConfigureAwait(false);
        var changed = false;
        for (var round = 0; round < MaxRounds; round++)
        {
            var merge = await core.CallAsync<SyncMergeResult>("sync.merge", new { remote = state.Envelope }).ConfigureAwait(false);
            changed |= merge.ChangedHere;
            if (merge.Envelope is null) return changed;
            var (accepted, now) = await put(state.Revision, merge.Envelope).ConfigureAwait(false);
            if (accepted)
            {
                await core.CallAsync("sync.committed").ConfigureAwait(false);
                return changed;
            }
            state = now;
        }
        throw new CoreException("sync conflict: try again");
    }
}
