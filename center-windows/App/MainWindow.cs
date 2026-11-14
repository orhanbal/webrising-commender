using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// The tray window: the Management Center panel on the right edge of the
/// screen above the taskbar, like the Windows notification center; it hides
/// when it loses focus.
/// </summary>
public sealed class MainWindow : Window
{
    private readonly CenterPanel _panel = new();
    private DateTime _hiddenAt = DateTime.MinValue;
    private DateTime _shownAt;
    private bool _quitting;

    public MainWindow()
    {
        Title = "WECOMMANDER Yönetim Merkezi";
        SystemBackdrop = new DesktopAcrylicBackdrop();
        Content = _panel;
        AppWindow.Title = "WECOMMANDER Yönetim Merkezi";
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        AppWindow.IsShownInSwitchers = false;
        ExtendsContentIntoTitleBar = true;
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.IsResizable = false;
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
            presenter.IsAlwaysOnTop = true;
            presenter.SetBorderAndTitleBar(true, false);
        }
        AppWindow.Closing += (_, e) =>
        {
            if (_quitting) return;
            e.Cancel = true; // closing keeps the app in the tray; "Çıkış" quits
            HidePanel();
        };
        Activated += (_, e) =>
        {
            if (e.WindowActivationState != WindowActivationState.Deactivated || _panel.DialogOpen || !AppWindow.IsVisible) return;
            // Opened from another window: that window takes the focus back as
            // its click ends. Stay open and take it again instead of closing
            // the moment it appeared.
            if (DateTime.UtcNow - _shownAt < TimeSpan.FromMilliseconds(800))
            {
                DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () => Activate());
                return;
            }
            HidePanel();
        };
        _panel.CloseRequested += HidePanel;
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    private void PlaceOnRightEdge()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var margin = (int)Math.Round(12 * scale);
        var width = Math.Min((int)Math.Round(400 * scale), area.Width - 2 * margin);
        var height = area.Height - 2 * margin;
        AppWindow.MoveAndResize(new RectInt32(area.X + area.Width - width - margin, area.Y + margin, width, height));
    }

    public void ShowPanel()
    {
        _shownAt = DateTime.UtcNow;
        App.Current.CheckForUpdateSoon();
        PlaceOnRightEdge();
        AppWindow.Show();
        Activate();
        _panel.Refresh();
    }

    /// <summary>Open the panel on the Approvals tab (a new request arrived).</summary>
    public void ShowApprovals()
    {
        _panel.SelectApprovals();
        ShowPanel();
    }

    public void HidePanel()
    {
        _hiddenAt = DateTime.UtcNow;
        AppWindow.Hide();
    }

    /// <summary>Tray click: open, or close when open. The click that just took the focus away does not reopen it.</summary>
    public void TogglePanel()
    {
        if (AppWindow.IsVisible) HidePanel();
        else if (DateTime.UtcNow - _hiddenAt > TimeSpan.FromMilliseconds(400)) ShowPanel();
    }

    public void Quit()
    {
        _quitting = true;
        Close();
    }
}
