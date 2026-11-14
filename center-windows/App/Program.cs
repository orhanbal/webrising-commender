using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using System.Runtime.InteropServices;

namespace Wecommander.Center;

/// <summary>
/// Single instance: a second start (Start menu, autostart, a click on one of
/// our notifications while the app runs elsewhere) is handed to the running
/// instance, which shows its panel or handles the notification button.
/// </summary>
public static class Program
{
    /// <summary>
    /// The identity Windows files our notifications under. It is the one the
    /// earlier tray app registered and the one shown in Settings, System,
    /// Notifications as "WECOMMANDER Yönetim Merkezi", so the owner's choice
    /// there (allow, banners) applies to this app. Without an explicit id the
    /// Windows App SDK generated another one, whose notifications reached
    /// neither the banner nor the notification center on the owner's machine.
    /// </summary>
    public const string AppUserModelId = "app.wecommander.center";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    private static int Main(string[] args)
    {
        // Must run before any window or notification API is touched.
        // The Store copy has its package's identity; only the zip copy names itself.
        if (!Packaging.IsPackaged) _ = SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
        WinRT.ComWrappersSupport.InitializeComWrappers();
        var main = AppInstance.FindOrRegisterForKey("wecommander-center");
        if (!main.IsCurrent)
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            Task.Run(() => main.RedirectActivationToAsync(activation).AsTask()).Wait();
            return 0;
        }
        Application.Start(callback =>
        {
            SynchronizationContext.SetSynchronizationContext(
                new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
        });
        return 0;
    }
}
