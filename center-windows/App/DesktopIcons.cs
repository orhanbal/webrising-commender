using System.Runtime.InteropServices;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Keeps the desktop icons where they were when the Dock takes or gives back a
/// strip of the screen. Explorer lays the icons out again whenever the work
/// area changes and, with two monitors, can push icons onto the other screen.
/// The positions are read from Explorer's desktop list view before the change
/// and put back after it; an icon that would sit under the Dock is moved just
/// out of its strip. Nothing is done when the desktop auto-arranges its icons.
/// Every step fails quietly: the desktop is never worse off than without this.
/// </summary>
internal static class DesktopIcons
{
    public sealed record Icon(string Key, int X, int Y);

    public sealed record Layout(IntPtr ListView, List<Icon> Icons, int OriginX, int OriginY, int CellW, int CellH);

    private const uint LvmFirst = 0x1000;
    private const uint LvmGetItemCount = LvmFirst + 4, LvmGetItemPosition = LvmFirst + 16, LvmSetItemPosition = LvmFirst + 15,
        LvmGetItemSpacing = LvmFirst + 51, LvmGetItemTextW = LvmFirst + 115;
    private const int GwlStyle = -16;
    private const long LvsAutoArrange = 0x0100;
    private const uint ProcessVmOperation = 0x0008, ProcessVmRead = 0x0010, ProcessVmWrite = 0x0020;
    private const uint MemCommitReserve = 0x3000, MemRelease = 0x8000, PageReadWrite = 0x04;

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string? cls, string? title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string? cls, string? title);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] private static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll")] private static extern bool VirtualFreeEx(IntPtr process, IntPtr address, UIntPtr size, uint type);
    [DllImport("kernel32.dll")] private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll")] private static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr written);

    private delegate bool EnumProc(IntPtr hwnd, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc proc, IntPtr l);

    /// <summary>Explorer's desktop list view (under Progman, or a WorkerW with a wallpaper slideshow).</summary>
    private static IntPtr ListView()
    {
        var view = FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
        if (view == IntPtr.Zero)
        {
            EnumWindows((w, _) =>
            {
                var v = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (v == IntPtr.Zero) return true;
                view = v;
                return false;
            }, IntPtr.Zero);
        }
        return view == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
    }

    /// <summary>The icons and their places now; null when there is nothing to keep (auto-arrange, no desktop).</summary>
    public static Layout? Read()
    {
        IntPtr process = IntPtr.Zero, remote = IntPtr.Zero;
        try
        {
            var list = ListView();
            if (list == IntPtr.Zero) return null;
            if (((long)GetWindowLongPtr(list, GwlStyle) & LvsAutoArrange) != 0) return null;
            var count = (int)SendMessage(list, LvmGetItemCount, IntPtr.Zero, IntPtr.Zero);
            if (count <= 0 || count > 2000) return null;
            GetWindowThreadProcessId(list, out var pid);
            process = OpenProcess(ProcessVmOperation | ProcessVmRead | ProcessVmWrite, false, pid);
            if (process == IntPtr.Zero) return null;
            // One block in Explorer: [POINT 8][LVITEMW 88][text 520].
            const int pointAt = 0, itemAt = 16, textAt = 112, textChars = 260, size = textAt + textChars * 2;
            remote = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)size, MemCommitReserve, PageReadWrite);
            if (remote == IntPtr.Zero) return null;
            var icons = new List<Icon>(count);
            var seen = new Dictionary<string, int>();
            var point = new byte[8];
            var text = new byte[textChars * 2];
            for (var i = 0; i < count; i++)
            {
                if (SendMessage(list, LvmGetItemPosition, (IntPtr)i, remote + pointAt) == IntPtr.Zero) continue;
                if (!ReadProcessMemory(process, remote + pointAt, point, (UIntPtr)8, out _)) continue;
                // LVITEMW (64-bit): mask, iItem, iSubItem, state, stateMask, pad, pszText, cchTextMax, ...
                var item = new byte[88];
                BitConverter.GetBytes(i).CopyTo(item, 4);
                BitConverter.GetBytes((long)(remote + textAt)).CopyTo(item, 24);
                BitConverter.GetBytes(textChars).CopyTo(item, 32);
                if (!WriteProcessMemory(process, remote + itemAt, item, (UIntPtr)item.Length, out _)) continue;
                var length = (int)SendMessage(list, LvmGetItemTextW, (IntPtr)i, remote + itemAt);
                if (length <= 0 || !ReadProcessMemory(process, remote + textAt, text, (UIntPtr)text.Length, out _)) continue;
                var name = System.Text.Encoding.Unicode.GetString(text, 0, Math.Min(length, textChars) * 2);
                // Two icons with the same name keep their order.
                seen[name] = seen.TryGetValue(name, out var n) ? n + 1 : 1;
                icons.Add(new Icon($"{name}\u0001{seen[name]}", BitConverter.ToInt32(point, 0), BitConverter.ToInt32(point, 4)));
            }
            var origin = new POINT();
            ClientToScreen(list, ref origin);
            var spacing = (long)SendMessage(list, LvmGetItemSpacing, IntPtr.Zero, IntPtr.Zero);
            var cellW = (int)(spacing & 0xFFFF);
            var cellH = (int)((spacing >> 16) & 0xFFFF);
            return icons.Count == 0 ? null : new Layout(list, icons, origin.X, origin.Y, Math.Max(cellW, 48), Math.Max(cellH, 48));
        }
        catch (Exception e)
        {
            App.DebugLayout($"desktop icons: not read ({e.GetType().Name})");
            return null;
        }
        finally
        {
            if (remote != IntPtr.Zero) VirtualFreeEx(process, remote, UIntPtr.Zero, MemRelease);
            if (process != IntPtr.Zero) CloseHandle(process);
        }
    }

    /// <summary>
    /// Puts the icons of <paramref name="before"/> back where they were. An icon whose cell
    /// would overlap <paramref name="reserved"/> (the Dock's strip, screen pixels) is moved just
    /// out of it, on the side of <paramref name="edge"/>. Returns how many icons were moved back.
    /// </summary>
    public static int Restore(Layout before, PixelRect? reserved, DockEdge edge, bool apply = true)
    {
        try
        {
            var now = Read();
            if (now is null || now.ListView != before.ListView) return 0;
            var current = now.Icons.ToDictionary(i => i.Key);
            var moved = 0;
            foreach (var icon in before.Icons)
            {
                if (!current.TryGetValue(icon.Key, out var at)) continue; // deleted meanwhile
                var (x, y) = (icon.X, icon.Y);
                if (reserved is { } r)
                {
                    // Screen rectangle of the icon's cell.
                    var left = x + before.OriginX; var top = y + before.OriginY;
                    var right = left + before.CellW; var bottom = top + before.CellH;
                    var overlaps = left < r.X + r.Width && right > r.X && top < r.Y + r.Height && bottom > r.Y;
                    if (overlaps)
                    {
                        switch (edge)
                        {
                            case DockEdge.Top: y = r.Y + r.Height - before.OriginY + 2; break;
                            case DockEdge.Bottom: y = r.Y - before.CellH - before.OriginY - 2; break;
                            case DockEdge.Left: x = r.X + r.Width - before.OriginX + 2; break;
                            case DockEdge.Right: x = r.X - before.CellW - before.OriginX - 2; break;
                        }
                    }
                }
                // Within half a cell counts as in place (the desktop may snap icons to its grid).
                if (Math.Abs(at.X - x) <= before.CellW / 2 && Math.Abs(at.Y - y) <= before.CellH / 2) continue;
                moved++;
                if (!apply) continue;
                var index = now.Icons.IndexOf(at);
                if (index < 0) continue;
                SendMessage(now.ListView, LvmSetItemPosition, (IntPtr)index, (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF)));
            }
            return moved;
        }
        catch (Exception e)
        {
            App.DebugLayout($"desktop icons: not restored ({e.GetType().Name})");
            return 0;
        }
    }

    /// <summary>
    /// Runs <paramref name="change"/> (it changes the work area), then puts the icons back twice:
    /// once Explorer has laid them out again and once more in case it did so late.
    /// </summary>
    public static T Keep<T>(Func<T> change, Func<T, PixelRect?> reserved, DockEdge edge)
    {
        // Several changes in a row (the Dock is placed twice when it starts): the positions
        // from before the first one are the right ones, not those Explorer is moving now.
        Layout? before;
        lock (Gate)
        {
            if (_kept is { } k && DateTime.UtcNow - _keptAt < TimeSpan.FromSeconds(4)) before = k;
            else { before = Read(); _kept = before; }
            _keptAt = DateTime.UtcNow;
        }
        var result = change();
        if (before is null) return result;
        var strip = reserved(result);
        var run = ++_run;
        App.DebugLayout($"desktop icons: kept {before.Icons.Count} positions");
        foreach (var delay in new[] { 700, 2500, 4000 })
        {
            _ = Task.Run(async () =>
            {
                await Task.Delay(delay);
                if (run != _run) return; // a newer change restores them
                var moved = Restore(before, strip, edge, apply: delay < 4000);
                if (delay < 4000) { if (moved > 0) App.DebugLayout($"desktop icons: put {moved} back after {delay} ms"); }
                else App.DebugLayout($"desktop icons: {moved} not where they should be after {delay} ms");
            });
        }
        return result;
    }

    private static readonly object Gate = new();
    private static Layout? _kept;
    private static DateTime _keptAt;
    private static volatile int _run;
}
