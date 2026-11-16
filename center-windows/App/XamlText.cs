using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Translates the texts written in a XAML page (Turkish in the markup) into
/// the interface language: called once after InitializeComponent. Only
/// fixed texts are touched; values set from code are already translated.
/// </summary>
public static class XamlText
{
    public static void Apply(DependencyObject root)
    {
        if (L.Current == "tr") return;
        Walk(root, new HashSet<DependencyObject>());
    }

    private static string? Tr(object? value) => value is string s && s.Length > 0 ? L.T(s) : null;

    private static void Walk(DependencyObject node, HashSet<DependencyObject> seen)
    {
        if (!seen.Add(node)) return;
        switch (node)
        {
            case TextBlock t:
                if (t.Inlines.Count > 0)
                    foreach (var run in t.Inlines.OfType<Run>()) { if (Tr(run.Text) is { } r) run.Text = r; }
                else if (Tr(t.Text) is { } text) t.Text = text;
                break;
            case InfoBar bar:
                if (Tr(bar.Title) is { } title) bar.Title = title;
                if (Tr(bar.Message) is { } message) bar.Message = message;
                if (bar.ActionButton is { } action) Walk(action, seen);
                if (bar.Content is DependencyObject inner) Walk(inner, seen);
                break;
            case ToggleSwitch sw:
                if (Tr(sw.Header) is { } h) sw.Header = h;
                if (Tr(sw.OnContent) is { } on) sw.OnContent = on;
                if (Tr(sw.OffContent) is { } off) sw.OffContent = off;
                break;
            case TextBox box:
                if (Tr(box.Header) is { } bh) box.Header = bh;
                if (Tr(box.PlaceholderText) is { } bp) box.PlaceholderText = bp;
                break;
            case PasswordBox pass:
                if (Tr(pass.Header) is { } ph) pass.Header = ph;
                if (Tr(pass.PlaceholderText) is { } pp) pass.PlaceholderText = pp;
                break;
            case NumberBox num:
                if (Tr(num.Header) is { } nh) num.Header = nh;
                break;
            case ComboBox combo:
                if (Tr(combo.Header) is { } ch) combo.Header = ch;
                if (Tr(combo.PlaceholderText) is { } cp) combo.PlaceholderText = cp;
                foreach (var item in combo.Items.OfType<DependencyObject>()) Walk(item, seen);
                break;
            case ContentControl content when content.Content is string:
                if (Tr(content.Content) is { } c) content.Content = c;
                break;
        }
        if (node is UIElement element)
        {
            if (Tr(ToolTipService.GetToolTip(element)) is { } tip) ToolTipService.SetToolTip(element, tip);
            if (Tr(AutomationProperties.GetName(element)) is { } name) AutomationProperties.SetName(element, name);
        }
        if (node is ButtonBase { Flyout: MenuFlyout menu })
            foreach (var item in menu.Items) if (item is MenuFlyoutItem mi && Tr(mi.Text) is { } mt) mi.Text = mt;
        var count = VisualTreeHelper.GetChildrenCount(node);
        if (count > 0)
            for (var i = 0; i < count; i++) Walk(VisualTreeHelper.GetChild(node, i), seen);
        else if (node is Panel panel)
            foreach (var child in panel.Children) Walk(child, seen);
        else if (node is Border { Child: { } bc }) Walk(bc, seen);
        else if (node is ContentControl { Content: DependencyObject cc }) Walk(cc, seen);
        else if (node is ScrollViewer { Content: DependencyObject sc }) Walk(sc, seen);
        else if (node is UserControl { Content: { } uc }) Walk(uc, seen);
    }
}
