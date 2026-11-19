using System.Runtime.InteropServices;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// After a crash the app comes back and says so. Some failures end the
/// process with no exception to catch (Microsoft.UI.Windowing fail-fast):
/// - Windows restarts the app after such a crash (RegisterApplicationRestart;
///   only once it has run a minute, so a crash at start cannot loop);
/// - a marker file is written at start and removed on every orderly exit, so
///   the next start knows the last run ended unexpectedly and reports it to
///   the server like any other error (super admin: Console → Growth → Feedback).
/// </summary>
public partial class App
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegisterApplicationRestart(string? commandLine, int flags);

    private static string RunMarker => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WECOMMANDER", "running.marker");

    private void StartCrashGuard()
    {
        try
        {
            // CI starts and kills the app on purpose: no restarts, no reports there.
            if (Environment.GetEnvironmentVariable("WECOMMANDER_DEBUG_LAYOUT") == "1") return;
            string? previous = null;
            if (File.Exists(RunMarker)) previous = File.ReadAllText(RunMarker).Trim();
            Directory.CreateDirectory(Path.GetDirectoryName(RunMarker)!);
            File.WriteAllText(RunMarker, $"build {AppUpdate.CurrentBuild()?.ToString() ?? "dev"}, started {DateTimeOffset.Now:O}");
            // Any orderly end (Quit, update, sign-out, Environment.Exit) removes it; a crash does not.
            AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { File.Delete(RunMarker); } catch (Exception) { } };
            RegisterApplicationRestart("--hidden --restarted", 0);
            if (previous is not null)
            {
                var error = new InvalidOperationException($"The app ended unexpectedly in its previous run ({previous}). Windows Event Viewer → Application has the faulting module.");
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(ErrorLogPath)!);
                    File.AppendAllText(ErrorLogPath, $"--- {DateTimeOffset.Now:O} {AppUpdate.CurrentBuild()}\n{error.Message}\n");
                }
                catch (Exception) { }
                // A little later: the token and the network are ready by then.
                _ = Task.Run(async () => { await Task.Delay(TimeSpan.FromSeconds(20)); SendErrorReport(error); });
            }
        }
        catch (Exception) { /* the guard itself must never stop the app */ }
    }
}
