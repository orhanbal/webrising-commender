using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// "Yapay zekâya root izni ver (bu sunucuda)" on a saved host: the machine
/// side of run-as-root (docs/AI_PERMISSIONS.md) done from the app. After a
/// confirmation that shows the exact command, a new terminal to the host runs
/// <see cref="RootSetup"/>'s fixed command and the person types their own sudo
/// password there; the app never handles it. Root stays off until an admin
/// turns it on in the web panel with their password.
/// </summary>
public sealed partial class ServersWindow
{
    /// <summary>Host id → the command its next new terminal types (set only while that connect runs).</summary>
    private readonly Dictionary<string, string> _pendingCommands = [];

    private void AddRootSetupItems(MenuFlyout flyout, CoreHost host)
    {
        if (!RootSetup.Applies(host)) return;
        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(Item(L.T("Yapay zekâya root izni ver (bu sunucuda)"), () => _ = RunRootSetup(host, allow: true)));
        flyout.Items.Add(Item(L.T("Root iznini kaldır"), () => _ = RunRootSetup(host, allow: false)));
    }

    private async Task RunRootSetup(CoreHost host, bool allow)
    {
        if (_connecting.Contains(host.Id))
        {
            Show(L.F("{0} şu anda bağlanıyor; bitince yeniden dene.", host.Label), InfoBarSeverity.Informational);
            return;
        }
        var command = RootSetup.Command(allow);
        var body = new StackPanel { Spacing = 10, MaxWidth = 520 };
        body.Children.Add(HelpText(allow
            ? L.T("Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.")
            : L.T("Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.")));
        body.Children.Add(HelpText(L.T("sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.")));
        if (allow)
        {
            body.Children.Add(HelpText(L.T("Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.")));
        }
        body.Children.Add(StrongText(L.T("Çalışacak komut")));
        body.Children.Add(new TextBlock
        {
            Text = command,
            FontFamily = AiMono,
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            IsTextSelectionEnabled = true,
            Padding = new Thickness(8),
        });
        var title = allow ? L.F("{0}: yapay zekâya root izni verilsin mi?", host.Label) : L.F("{0}: root izni kaldırılsın mı?", host.Label);
        var dialog = Dialog(title, new ScrollViewer { Content = body }, L.T("Terminalde çalıştır"));
        if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;

        var before = _tabs.TabItems.Count;
        _pendingCommands[host.Id] = command;
        try { await OpenHost(host); }
        finally { _pendingCommands.Remove(host.Id); }
        if (_tabs.TabItems.Count == before) return; // not connected: the reason is already shown

        if (allow)
        {
            var url = RootSetup.PermissionsUrl(App.Current.Settings.Server, RootSetup.MatchDevice(host, App.Current.Devices));
            ShowWithLink(L.T("Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar."),
                L.T("Web'de yetkileri aç"), url);
        }
        else Show(L.T("Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner."), InfoBarSeverity.Informational);
    }

    /// <summary>Types the pending root command into the new terminal of that host (once).</summary>
    private void SendPendingCommand(CoreHost host, TerminalTab tab)
    {
        if (!_pendingCommands.Remove(host.Id, out var command)) return;
        _c.Write(tab, command + "\r");
    }

    private void ShowWithLink(string text, string button, string url)
    {
        Show(text, InfoBarSeverity.Success);
        var open = new Button { Content = button };
        open.Click += (_, _) => App.OpenUrl(url);
        _info.ActionButton = open;
    }
}
