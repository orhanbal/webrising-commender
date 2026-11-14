using System.Runtime.InteropServices;
using Windows.ApplicationModel;

namespace Wecommander.Center;

/// <summary>
/// The Microsoft Store copy (MSIX, package UnmadeThings.WECOMMANDER) versus
/// the zip copy: the Store copy updates through the Store, starts with
/// Windows through its startup task, and its notifications use the
/// package's identity.
/// </summary>
internal static class Packaging
{
    public const string StoreProductId = "9P66C88PSBP6";
    public const string StartupTaskId = "WecommanderStartup";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFullName(ref int length, char[]? name);

    private const int AppModelErrorNoPackage = 15700;

    public static readonly bool IsPackaged = Detect();

    private static bool Detect()
    {
        try
        {
            var length = 0;
            return GetCurrentPackageFullName(ref length, null) != AppModelErrorNoPackage;
        }
        catch (Exception) { return false; }
    }

    /// <summary>The app's page in the Store app (updates come from there).</summary>
    public static void OpenStorePage()
    {
        try { _ = Windows.System.Launcher.LaunchUriAsync(new Uri($"ms-windows-store://pdp/?productid={StoreProductId}")); }
        catch (Exception) { }
    }

    /// <summary>Whether the Store copy starts with Windows (its startup task).</summary>
    public static bool StartsWithWindows()
    {
        try
        {
            var task = Task.Run(async () => await StartupTask.GetAsync(StartupTaskId));
            return task.Wait(TimeSpan.FromSeconds(2))
                && task.Result.State is StartupTaskState.Enabled or StartupTaskState.EnabledByPolicy;
        }
        catch (Exception) { return false; }
    }

    public static async Task SetStartsWithWindows(bool on)
    {
        try
        {
            var task = await StartupTask.GetAsync(StartupTaskId);
            if (on) await task.RequestEnableAsync();
            else task.Disable();
        }
        catch (Exception) { }
    }
}
