namespace Wecommander.Center.Core;

/// <summary>Which screen edge the Dock sits on.</summary>
public enum DockEdge { Top, Bottom, Left, Right }

/// <summary>
/// Fixed: an AppBar that takes its strip from the work area (windows do not
/// cover it). AutoHide: slides out of sight at the edge and back when the
/// mouse reaches that edge. Floating: a normal window the owner drags anywhere.
/// </summary>
public enum DockMode { Fixed, AutoHide, Floating }

/// <summary>A screen rectangle in physical pixels.</summary>
public readonly record struct PixelRect(int X, int Y, int Width, int Height)
{
    public int Right => X + Width;
    public int Bottom => Y + Height;
    public bool Contains(int x, int y) => x >= X && x < Right && y >= Y && y < Bottom;
    public static PixelRect FromEdges(int left, int top, int right, int bottom) => new(left, top, right - left, bottom - top);
}

/// <summary>Where the Dock goes; pure geometry, so it is tested without a screen.</summary>
public static class DockLayout
{
    /// <summary>How thick the bar is (96-dpi pixels): a row along the top/bottom, a column at the sides (charts stacked).</summary>
    public static int ThicknessDip(DockEdge edge, bool compact) => IsHorizontal(edge)
        ? (compact ? 48 : 60)
        : (compact ? 92 : 118);

    public static bool IsHorizontal(DockEdge edge) => edge is DockEdge.Top or DockEdge.Bottom;

    /// <summary>The full strip along one edge of a monitor.</summary>
    public static PixelRect Strip(PixelRect monitor, DockEdge edge, int thickness)
    {
        thickness = Math.Clamp(thickness, 1, IsHorizontal(edge) ? monitor.Height : monitor.Width);
        return edge switch
        {
            DockEdge.Top => monitor with { Height = thickness },
            DockEdge.Bottom => new PixelRect(monitor.X, monitor.Bottom - thickness, monitor.Width, thickness),
            DockEdge.Left => monitor with { Width = thickness },
            _ => new PixelRect(monitor.Right - thickness, monitor.Y, thickness, monitor.Height),
        };
    }

    /// <summary>
    /// After ABM_QUERYPOS moved the proposed rectangle away from other AppBars
    /// (the taskbar on the same edge, another tool), keep our thickness from
    /// the edge the shell left us.
    /// </summary>
    public static PixelRect AfterQuery(PixelRect proposed, DockEdge edge, int thickness) => edge switch
    {
        DockEdge.Top => proposed with { Height = thickness },
        DockEdge.Bottom => PixelRect.FromEdges(proposed.X, proposed.Bottom - thickness, proposed.Right, proposed.Bottom),
        DockEdge.Left => proposed with { Width = thickness },
        _ => PixelRect.FromEdges(proposed.Right - thickness, proposed.Y, proposed.Right, proposed.Bottom),
    };

    /// <summary>The auto-hidden bar: moved past the edge so only <paramref name="peek"/> pixels stay on screen.</summary>
    public static PixelRect Hidden(PixelRect shown, DockEdge edge, int peek)
    {
        peek = Math.Max(0, peek);
        return edge switch
        {
            DockEdge.Top => shown with { Y = shown.Y - shown.Height + peek },
            DockEdge.Bottom => shown with { Y = shown.Bottom - peek },
            DockEdge.Left => shown with { X = shown.X - shown.Width + peek },
            _ => shown with { X = shown.Right - peek },
        };
    }

    /// <summary>Between hidden (0) and shown (1), for the slide.</summary>
    public static PixelRect Between(PixelRect hidden, PixelRect shown, double t)
    {
        t = Math.Clamp(t, 0, 1);
        return new PixelRect(
            (int)Math.Round(hidden.X + (shown.X - hidden.X) * t),
            (int)Math.Round(hidden.Y + (shown.Y - hidden.Y) * t),
            shown.Width, shown.Height);
    }

    /// <summary>Whether the mouse at (x, y) asks an auto-hidden bar to come out: on its edge of its monitor (within <paramref name="reach"/> pixels).</summary>
    public static bool Wakes(PixelRect monitor, DockEdge edge, int x, int y, int reach)
    {
        if (!monitor.Contains(x, y)) return false;
        return edge switch
        {
            DockEdge.Top => y < monitor.Y + reach,
            DockEdge.Bottom => y >= monitor.Bottom - reach,
            DockEdge.Left => x < monitor.X + reach,
            _ => x >= monitor.Right - reach,
        };
    }

    /// <summary>
    /// While the Dock is dragged (like the Windows taskbar): the edge of the
    /// monitor under the pointer it would be fixed to, when the pointer at
    /// (x, y) is within <paramref name="reach"/> pixels of one (the nearest
    /// wins); null: off every edge, it floats where it is dropped.
    /// </summary>
    public static DockEdge? DragTarget(int x, int y, PixelRect monitor, int reach)
    {
        if (!monitor.Contains(x, y)) return null;
        var distances = new (DockEdge Edge, int Distance)[]
        {
            (DockEdge.Top, y - monitor.Y),
            (DockEdge.Bottom, monitor.Bottom - 1 - y),
            (DockEdge.Left, x - monitor.X),
            (DockEdge.Right, monitor.Right - 1 - x),
        };
        var nearest = distances.OrderBy(d => d.Distance).First();
        return nearest.Distance < reach ? nearest.Edge : null;
    }

    /// <summary>Keeps a floating Dock fully on the work area (a monitor was removed, the resolution changed).</summary>
    public static PixelRect Clamp(PixelRect window, PixelRect work)
    {
        var width = Math.Min(window.Width, work.Width);
        var height = Math.Min(window.Height, work.Height);
        var x = Math.Clamp(window.X, work.X, work.Right - width);
        var y = Math.Clamp(window.Y, work.Y, work.Bottom - height);
        return new PixelRect(x, y, width, height);
    }

    /// <summary>Which way a panel opened from the Dock goes: away from the edge the Dock sits on.</summary>
    public static DockEdge PanelSide(DockEdge dockEdge) => dockEdge switch
    {
        DockEdge.Top => DockEdge.Bottom,
        DockEdge.Bottom => DockEdge.Top,
        DockEdge.Left => DockEdge.Right,
        _ => DockEdge.Left,
    };

    /// <summary>
    /// A panel of <paramref name="width"/> × <paramref name="height"/> opened from
    /// <paramref name="anchor"/> (a Dock button) toward <paramref name="side"/>,
    /// kept inside the work area (shortened when there is not enough room).
    /// </summary>
    public static PixelRect PanelAt(PixelRect anchor, DockEdge side, int width, int height, PixelRect work, int gap)
    {
        width = Math.Min(width, work.Width);
        height = Math.Min(height, work.Height);
        int x, y;
        switch (side)
        {
            case DockEdge.Bottom:
                x = anchor.X; y = anchor.Bottom + gap;
                height = Math.Min(height, work.Bottom - y);
                break;
            case DockEdge.Top:
                x = anchor.X; y = anchor.Y - gap - height;
                if (y < work.Y) { height = Math.Max(1, anchor.Y - gap - work.Y); y = anchor.Y - gap - height; }
                break;
            case DockEdge.Right:
                x = anchor.Right + gap; y = anchor.Y;
                width = Math.Min(width, work.Right - x);
                break;
            default:
                x = anchor.X - gap - width; y = anchor.Y;
                if (x < work.X) { width = Math.Max(1, anchor.X - gap - work.X); x = anchor.X - gap - width; }
                break;
        }
        x = Math.Clamp(x, work.X, Math.Max(work.X, work.Right - width));
        y = Math.Clamp(y, work.Y, Math.Max(work.Y, work.Bottom - height));
        return new PixelRect(x, y, Math.Max(1, width), Math.Max(1, height));
    }

    /// <summary>
    /// A panel's size as a share of the work area (the terminal: 60 % × 50 %),
    /// at least <paramref name="minWidth"/> × <paramref name="minHeight"/> and never
    /// larger than the work area.
    /// </summary>
    public static (int Width, int Height) PanelSize(PixelRect work, double widthShare, double heightShare, int minWidth, int minHeight)
    {
        var w = Math.Max(minWidth, (int)Math.Round(work.Width * widthShare));
        var h = Math.Max(minHeight, (int)Math.Round(work.Height * heightShare));
        return (Math.Min(w, work.Width), Math.Min(h, work.Height));
    }

    public static DockEdge ParseEdge(string? value) => value?.ToLowerInvariant() switch
    {
        "bottom" => DockEdge.Bottom,
        "left" => DockEdge.Left,
        "right" => DockEdge.Right,
        _ => DockEdge.Top,
    };

    public static DockMode ParseMode(string? value) => value?.ToLowerInvariant() switch
    {
        "autohide" => DockMode.AutoHide,
        "floating" => DockMode.Floating,
        _ => DockMode.Fixed,
    };

    public static string Name(DockEdge edge) => edge.ToString().ToLowerInvariant();
    public static string Name(DockMode mode) => mode.ToString().ToLowerInvariant();

    /// <summary>
    /// The Dock's parts, in the default order. "tasks" opens both schedulers
    /// (it replaced the separate "timers" button; a saved "timers" is dropped).
    /// </summary>
    public static readonly string[] AllModules = ["servers", "processes", "tasks", "terminal", "approvals"];

    /// <summary>The saved order with unknown names dropped and missing ones (added in a later version) appended, hidden ones left out.</summary>
    public static List<string> Modules(IEnumerable<string>? order, IEnumerable<string>? hidden)
    {
        var off = new HashSet<string>(hidden ?? []);
        var result = (order ?? []).Where(m => AllModules.Contains(m)).Distinct().ToList();
        result.AddRange(AllModules.Where(m => !result.Contains(m)));
        return result.Where(m => !off.Contains(m)).ToList();
    }

    /// <summary>
    /// The order after one part was dragged from <paramref name="from"/> to
    /// <paramref name="to"/> (positions in <paramref name="order"/>; out of range: clamped).
    /// </summary>
    public static List<string> Move(IReadOnlyList<string> order, int from, int to)
    {
        var result = order.ToList();
        if (result.Count == 0 || from < 0 || from >= result.Count) return result;
        to = Math.Clamp(to, 0, result.Count - 1);
        if (from == to) return result;
        var item = result[from];
        result.RemoveAt(from);
        result.Insert(to, item);
        return result;
    }

    /// <summary>
    /// Where a part dragged along the Dock lands: the position (for <see cref="Move"/>)
    /// among the parts shown, from the pointer's place along the Dock's axis and
    /// each part's extent there (start, length; in the order shown, not overlapping).
    /// The dragged part (<paramref name="from"/>) itself does not count: it goes
    /// after every other part whose middle the pointer has passed.
    /// </summary>
    public static int DropSlot(IReadOnlyList<(int Start, int Length)> items, int from, int pointer)
    {
        if (items.Count == 0) return 0;
        var slot = 0;
        for (var i = 0; i < items.Count; i++)
        {
            if (i == from) continue;
            // pointer >= start + length / 2, without rounding.
            if (2L * pointer >= 2L * items[i].Start + items[i].Length) slot++;
        }
        return Math.Clamp(slot, 0, items.Count - 1);
    }

    /// <summary>
    /// The full saved order after the parts in <paramref name="shown"/> (the Dock's
    /// movable buttons, in their new order) were rearranged among themselves:
    /// hidden parts and the others keep their places in the saved order.
    /// </summary>
    public static List<string> Rearranged(IEnumerable<string>? order, IReadOnlyList<string> shown)
    {
        var full = Modules(order, null);
        var moved = shown.Where(full.Contains).Distinct().ToList();
        var set = new HashSet<string>(moved);
        var next = new Queue<string>(moved);
        for (var i = 0; i < full.Count; i++)
            if (set.Contains(full[i])) full[i] = next.Dequeue();
        return full;
    }

    /// <summary>One movable Dock part from <paramref name="from"/> to <paramref name="to"/> (positions in <paramref name="shown"/>): the new full saved order.</summary>
    public static List<string> MoveShown(IEnumerable<string>? order, IReadOnlyList<string> shown, int from, int to) =>
        Rearranged(order, Move(shown, from, to));
}
