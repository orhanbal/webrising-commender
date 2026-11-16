using Wecommander.Center.Core;
using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// The Management Center panel window. Two ways it shows:
/// - from the tray: on the right edge of the screen above the taskbar, like
///   the Windows notification center; it hides when it loses focus;
/// - beside the main window (docked): its own window right next to it, like
///   the two halves of the Start menu. It follows the main window, stays in
///   front of it (an owned window) and goes away with it.
/// </summary>
public sealed class MainWindow : Window
{
    private readonly CenterPanel _panel = new();
    private DateTime _hiddenAt = DateTime.MinValue;
    private DateTime _shownAt;
    private bool _quitting;
    /// <summary>Width of the docked panel and the gap to the main window (in 96-dpi pixels).</summary>
    public const int DockedWidth = 400, DockGap = 8;
    private Window? _owner;
    private bool Docked => _owner is not null;

    public MainWindow()
    {
        Title = L.T("WECOMMANDER Yönetim Merkezi");
        SystemBackdrop = new DesktopAcrylicBackdrop();
        Content = _panel;
        AppWindow.Title = L.T("WECOMMANDER Yönetim Merkezi");
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        AppWindow.IsShownInSwitchers = false;
        // No title bar at all (the presenter removes it). Extending content into
        // it made the top ~32 px a drag area that swallowed clicks there.
        ExtendsContentIntoTitleBar = false;
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
            if (Docked) { HideDocked(); App.Current.PanelDismissed(); }
            else HidePanel();
        };
        Activated += (_, e) =>
        {
            if (e.WindowActivationState != WindowActivationState.Deactivated || _panel.DialogOpen || !AppWindow.IsVisible || Docked) return;
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
        _panel.CloseRequested += () =>
        {
            if (Docked) { HideDocked(); App.Current.PanelDismissed(); }
            else HidePanel();
        };
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

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    private const int GWLP_HWNDPARENT = -8;

    /// <summary>Owned by the main window: always in front of it, minimized with it, no taskbar button of its own.</summary>
    private void SetOwner(Window? owner)
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, owner is null ? IntPtr.Zero : WinRT.Interop.WindowNative.GetWindowHandle(owner));
        _owner = owner;
        _panel.ShowClose = owner is null;
        if (AppWindow.Presenter is OverlappedPresenter presenter) presenter.IsAlwaysOnTop = owner is null;
    }

    /// <summary>Beside the main window: same top and height, a small gap; on its left when the screen has no room on its right.</summary>
    public void ShowDocked(Window owner)
    {
        if (!ReferenceEquals(_owner, owner)) SetOwner(owner);
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        // Measured on what is drawn: a resizable window has invisible resize
        // borders around it (about 7 px a side), which made the gap three times
        // as wide as meant.
        var main = Visible(WinRT.Interop.WindowNative.GetWindowHandle(owner));
        var self = Insets(hwnd);
        var area = DisplayArea.GetFromWindowId(owner.AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var width = (int)Math.Round(DockedWidth * scale);
        var gap = (int)Math.Round(DockGap * scale);
        var left = main.Right + gap;
        if (left + width > area.X + area.Width && main.Left - gap - width >= area.X) left = main.Left - gap - width;
        left = Math.Min(left, area.X + area.Width - width);
        var height = main.Bottom - main.Top;
        AppWindow.MoveAndResize(new RectInt32(left - self.Left, main.Top - self.Top, width + self.Left + self.Right, height + self.Top + self.Bottom));
        App.DebugLayout($"dock: main drawn={main.Left},{main.Top},{main.Right},{main.Bottom} panel x={left} w={width} h={height} insets={self.Left},{self.Top},{self.Right},{self.Bottom} visible={AppWindow.IsVisible}");
        if (!AppWindow.IsVisible)
        {
            AppWindow.Show(false); // the main window keeps the focus
            _panel.Refresh();
            // Its own borders are known only once it is on screen: place it again.
            DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () => { if (_owner is { } o && AppWindow.IsVisible) ShowDocked(o); });
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    /// <summary>The part of a window that is drawn (without the invisible resize borders), in screen pixels.</summary>
    private static RECT Visible(IntPtr hwnd)
    {
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out var r, Marshal.SizeOf<RECT>()) == 0 && r.Right > r.Left) return r;
        GetWindowRect(hwnd, out r);
        return r;
    }

    /// <summary>How far this window's invisible borders reach beyond what is drawn (0 while hidden).</summary>
    private RECT Insets(IntPtr hwnd)
    {
        if (!AppWindow.IsVisible || !GetWindowRect(hwnd, out var outer)) return default;
        var drawn = Visible(hwnd);
        return new RECT
        {
            Left = Math.Max(0, drawn.Left - outer.Left), Top = Math.Max(0, drawn.Top - outer.Top),
            Right = Math.Max(0, outer.Right - drawn.Right), Bottom = Math.Max(0, outer.Bottom - drawn.Bottom),
        };
    }

    public void HideDocked()
    {
        App.DebugLayout($"hide docked: docked={Docked} visible={AppWindow.IsVisible}");
        if (Docked && AppWindow.IsVisible) AppWindow.Hide();
    }

    public void SelectApprovals() { _panel.SelectApprovals(); _panel.Refresh(); }
    public void SelectDevices() { _panel.SelectDevices(); _panel.Refresh(); }

    public void ShowPanel()
    {
        // The main window is open: the panel belongs beside it (shown again if it was hidden).
        if (Docked && _owner!.AppWindow.IsVisible)
        {
            App.Current.ShowPanelBesideMain();
            Activate();
            _panel.Refresh();
            return;
        }
        if (Docked) SetOwner(null); // the main window is closed: back to the tray panel on the screen edge
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
        if (Docked && _owner!.AppWindow.IsVisible) { ShowPanel(); return; }
        if (AppWindow.IsVisible) HidePanel();
        else if (DateTime.UtcNow - _hiddenAt > TimeSpan.FromMilliseconds(400)) ShowPanel();
    }

    public void Quit()
    {
        _quitting = true;
        Close();
    }
}
