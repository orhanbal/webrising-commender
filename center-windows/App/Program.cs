using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Wecommander.Center;

/// <summary>
/// Single instance: a second start (Start menu, autostart, a click on one of
/// our notifications while the app runs elsewhere) is handed to the running
/// instance, which shows its panel or handles the notification button.
/// </summary>
public static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        var main = AppInstance.FindOrRegisterForKey("wecommander-center");
        if (!main.IsCurrent)
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            Task.Run(() => main.RedirectActivationToAsync(activation).AsTask()).Wait();
            return 0;
        }
        Application.Start(_ =>
        {
            SynchronizationContext.SetSynchronizationContext(
                new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
        });
        return 0;
    }
}
