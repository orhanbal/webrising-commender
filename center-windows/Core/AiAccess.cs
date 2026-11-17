using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Wecommander.Center.Core;

/// <summary>
/// AI access of one saved SSH host (docs: Hybrid Access, contract section 7):
/// which AI clients may use it (this computer's, through local MCP; remote
/// ones, through wecommander.app and a connector), how much they may do and
/// whether sudo is allowed. Absent on a host = everything off.
/// </summary>
public sealed record AiAccess(bool Local = false, bool Remote = false, string Connector = AiAccess.ThisComputer,
    string Preset = AiAccess.Approval, string? TimedUntil = null, string Sudo = AiAccess.SudoNever)
{
    public const string ThisComputer = "this-computer";
    public const string ReadOnly = "readonly";
    public const string Approval = "approval";
    public const string Timed = "timed";
    public const string SudoNever = "never";
    public const string SudoSudoers = "sudoers";

    /// <summary>The longest a timed (autonomous) preset may run.</summary>
    public static readonly TimeSpan MaxTimed = TimeSpan.FromHours(8);

    public static readonly string[] Presets = [ReadOnly, Approval, Timed];
    public static readonly string[] SudoModes = [SudoNever, SudoSudoers];

    /// <summary>The default of every host: no AI can see it.</summary>
    public static AiAccess Off { get; } = new();

    /// <summary>Some AI can use the host.</summary>
    [JsonIgnore] public bool Any => Local || Remote;

    [JsonIgnore] public DateTimeOffset? TimedUntilTime =>
        DateTimeOffset.TryParse(TimedUntil, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
}

/// <summary>Why AI access cannot be switched on for a host yet; each has a fix in the editor.</summary>
public enum AiBlocker
{
    /// <summary>Telnet, serial and Mosh hosts: AI access works only over SSH.</summary>
    NotSsh,
    /// <summary>The host key was never approved (known_hosts has no entry).</summary>
    HostKeyUntrusted,
    /// <summary>A login would ask for a password: nothing is saved.</summary>
    NeedsCredential,
}

/// <summary>What the app checks before it asks the core (the core checks again and decides).</summary>
public static class AiAccessRules
{
    public const string HostKeyUntrusted = "host_key_untrusted";
    public const string NeedsCredential = "needs_credential";
    public const string NotSsh = "not_ssh";
    public const string RemoteNotSupported = "remote_not_supported";
    public const string InvalidPreset = "invalid_preset";
    public const string InvalidSudo = "invalid_sudo";
    public const string InvalidConnector = "invalid_connector";
    public const string TimedNeedsUntil = "timed_needs_until";
    public const string TimedTooLong = "timed_too_long";
    public const string TimedInPast = "timed_in_past";

    /// <summary>The access stored for a host (absent = off).</summary>
    public static AiAccess Of(CoreHost host) => host.AiAccess ?? AiAccess.Off;

    /// <summary>Plain SSH only: Mosh runs its terminal over UDP, Telnet and serial have no SSH at all.</summary>
    public static bool IsPlainSsh(CoreHost host) => host.Protocol is "ssh" or "" or null;

    /// <summary>
    /// What stops AI access on this host, in the order to fix it. A key login
    /// without a chosen key may still work silently (this computer's ~/.ssh
    /// keys, the SSH agent), so only a password login with nothing saved blocks
    /// here; the core has the last word.
    /// </summary>
    public static IReadOnlyList<AiBlocker> Blockers(CoreHost host)
    {
        var list = new List<AiBlocker>();
        if (!IsPlainSsh(host)) { list.Add(AiBlocker.NotSsh); return list; }
        if (string.IsNullOrEmpty(host.TrustedKey)) list.Add(AiBlocker.HostKeyUntrusted);
        var silent = host.SavedSecret || host.KeyId is not null || host.IdentityId is not null || host.AuthKind != "password";
        if (!silent) list.Add(AiBlocker.NeedsCredential);
        return list;
    }

    /// <summary>The blocker a core error code stands for (null for other errors).</summary>
    public static AiBlocker? BlockerFromError(string raw) =>
        raw.Contains(HostKeyUntrusted, StringComparison.Ordinal) ? AiBlocker.HostKeyUntrusted
        : raw.Contains(NeedsCredential, StringComparison.Ordinal) ? AiBlocker.NeedsCredential
        : raw.Contains(NotSsh, StringComparison.Ordinal) ? AiBlocker.NotSsh
        : null;

    public static string Code(AiBlocker blocker) => blocker switch
    {
        AiBlocker.NotSsh => NotSsh,
        AiBlocker.HostKeyUntrusted => HostKeyUntrusted,
        _ => NeedsCredential,
    };

    /// <summary>Drops what does not apply: the connector without remote access, the end time without the timed preset.</summary>
    public static AiAccess Normalize(AiAccess access) => access with
    {
        Connector = access.Remote && !string.IsNullOrWhiteSpace(access.Connector) ? access.Connector : AiAccess.ThisComputer,
        TimedUntil = access.Preset == AiAccess.Timed ? access.TimedUntil : null,
    };

    /// <summary>The timed preset for <paramref name="duration"/> from now (at most 8 hours).</summary>
    public static AiAccess TimedFor(AiAccess access, TimeSpan duration, DateTimeOffset now)
    {
        if (duration > AiAccess.MaxTimed) duration = AiAccess.MaxTimed;
        if (duration < TimeSpan.FromMinutes(1)) duration = TimeSpan.FromMinutes(1);
        return access with { Preset = AiAccess.Timed, TimedUntil = now.ToUniversalTime().Add(duration).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture) };
    }

    /// <summary>An error code when the setting itself is invalid; null when it can be sent.</summary>
    public static string? Validate(AiAccess access, DateTimeOffset now)
    {
        if (!AiAccess.Presets.Contains(access.Preset)) return InvalidPreset;
        if (!AiAccess.SudoModes.Contains(access.Sudo)) return InvalidSudo;
        if (access.Remote && string.IsNullOrWhiteSpace(access.Connector)) return InvalidConnector;
        if (access.Preset == AiAccess.Timed)
        {
            if (access.TimedUntilTime is not { } until) return TimedNeedsUntil;
            if (until <= now) return TimedInPast;
            // A minute of slack for the time it takes to save.
            if (until > now + AiAccess.MaxTimed + TimeSpan.FromMinutes(1)) return TimedTooLong;
        }
        return null;
    }

    /// <summary>
    /// Whether the core can already serve remote AI access. A core that does
    /// not say so is treated as "not yet" (phase H3 adds it).
    /// </summary>
    public static bool RemoteSupported(JsonNode? info, JsonNode? status = null)
    {
        static bool Flag(JsonNode? node, string name) =>
            node is JsonObject o && o[name] is JsonValue v && v.TryGetValue(out bool b) && b;
        static bool Feature(JsonNode? node) =>
            node is JsonObject o && o["features"] is JsonArray a && a.Any(f => f is JsonValue v && v.TryGetValue(out string? s) && s == "remote-mcp");
        return Flag(info, "remoteMcp") || Feature(info) || Flag(status, "remoteSupported") || Flag(status, "remote") || Feature(status);
    }
}

/// <summary>A small label on a host card ("SSH", "Yerel YZ"…). Kind: method, ai-local, ai-remote, manual.</summary>
public sealed record HostBadge(string Text, string Kind);

/// <summary>The badges and the one-sentence explanation of a host card.</summary>
public static class HostBadges
{
    public static IReadOnlyList<HostBadge> For(CoreHost host, bool agentLinked = false)
    {
        var list = new List<HostBadge>
        {
            new(host.Protocol switch
            {
                "mosh" => "Mosh",
                "telnet" => "Telnet",
                "serial" => L.T("Seri port"),
                _ => "SSH",
            }, "method"),
        };
        if (agentLinked) list.Add(new HostBadge(L.T("Ajan"), "method"));
        var ai = AiAccessRules.Of(host);
        if (ai.Local) list.Add(new HostBadge(L.T("Yerel YZ"), "ai-local"));
        if (ai.Remote)
            list.Add(new HostBadge(ai.Connector == AiAccess.ThisComputer ? L.T("Uzak YZ") : L.F("Uzak YZ · {0}", AiAccessText.ConnectorName(ai.Connector)), "ai-remote"));
        if (!ai.Any) list.Add(new HostBadge(L.T("Yalnız elle"), "manual"));
        return list;
    }

    /// <summary>"Yapay zekâ bu sunucuya SSH ile, bu bilgisayar üzerinden erişir; …" for the card's tooltip.</summary>
    public static string Explain(CoreHost host)
    {
        var ai = AiAccessRules.Of(host);
        if (!ai.Any) return L.T("Yapay zekâ bu sunucuyu göremez; yalnız sen elle bağlanırsın.");
        var route = ai.Remote && ai.Connector != AiAccess.ThisComputer && !ai.Local
            ? AiAccessText.ConnectorName(ai.Connector)
            : AiAccessText.ConnectorName(AiAccess.ThisComputer);
        var preset = ai.Preset switch
        {
            AiAccess.ReadOnly => L.T("yalnız okuma"),
            AiAccess.Timed => L.T("süre bitene kadar komutlar onaysız"),
            _ => L.T("komutlar onaylı"),
        };
        return L.F("Yapay zekâ bu sunucuya SSH ile, {0} üzerinden erişir; klasör sınırı yok, {1}.", route, preset);
    }
}

/// <summary>Every text of the connection-method choice, the AI access editor and Settings → Yapay zekâ.</summary>
public static class AiAccessText
{
    // ---- add server: connection method ----

    public static string MethodSshTitle => L.T("SSH ile bağlan (ajan gerekmez)");
    public static string MethodSshHelp => L.T("Sunucuya hiçbir şey kurmadan, adres ve SSH anahtarı ya da parolayla bağlanırsın. Terminal, dosyalar, tüneller ve sunucu yönetimi hemen çalışır. Sunucuya ajan kurmak istemiyorsan bu yöntemi seç.");
    public static string MethodAgentTitle => L.T("WECOMMANDER ajanı kur");
    public static string MethodAgentHelp => L.T("Sunucuya küçük bir ajan kurulur; sunucu dışarıya tek bir şifreli bağlantı açar, sana gelen port gerekmez. NAT ve güvenlik duvarı arkasındaki makineler, kalıcı terminaller ve uzun görevler için en güçlü yöntem. Yapay zekâ için klasör sınırları ve cihaz politikaları yalnızca ajanla tam uygulanır.");
    public static string MethodOtherTitle => L.T("Diğer protokoller");
    public static string MethodOtherHelp => L.T("Mosh (kopan bağlantıda devam eden terminal), Telnet (eski cihazlar) ve seri port (ağ cihazları, kartlar). Yapay zekâ erişimi bu protokollerde yoktur.");
    public static string MethodAgentSteps => L.T("Ajanın kurulum komutu wecommander.app panelindeki Cihazlar sayfasındadır: komutu sunucuda bir kez çalıştırırsın, sunucu hesabına kendiliğinden bağlanır ve Yönetim Merkezi'nde Cihazlar altında görünür.");
    public static string MethodAgentOpen => L.T("Cihazlar sayfasını aç");

    // ---- host editor: AI access ----

    public static string SectionTitle => L.T("Yapay zekâ erişimi");
    public static string Header => L.T("Bağlantı yöntemi ile yapay zekâ erişimi ayrı ayarlardır. Bu sunucuya yapay zekâ erişimini sen açmadıkça hiçbir yapay zekâ bu sunucuyu göremez.");
    public static string LocalTitle => L.T("Bu bilgisayardaki yapay zekâlar (yerel MCP)");
    public static string LocalHelp => L.T("Claude Desktop, Claude Code, Codex, Cursor gibi bu bilgisayarda çalışan yapay zekâlar bu sunucuyu kullanabilir. Komutlar ve çıktılar bilgisayarından doğrudan sunucuya gider, WECOMMANDER bulutuna uğramaz. WECOMMANDER açık olmalıdır; onaylar bu uygulamada sorulur.");
    public static string RemoteTitle => L.T("Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)");
    public static string RemoteHelp => L.T("wecommander.app üzerinden bağlanan yapay zekâlar bu sunucuyu kullanabilir. Komut ve çıktı WECOMMANDER sunucusundan geçer (parola ve anahtarlar maskelenir); SSH anahtarın hiçbir zaman buluta gönderilmez, işi aşağıda seçtiğin bağlayıcı yapar.");
    public static string RemoteNotYet => L.T("Uzak yapay zekâ erişimi bir sonraki sürümde gelecek; şimdilik yerel erişim açılabilir.");
    public static string ConnectorHeader => L.T("Bağlayıcı (uzak erişimi kim kurar)");
    public static string ConnectorThisTitle => L.T("Bu bilgisayar");
    public static string ConnectorThisHelp => L.T("Bağlantıyı bu bilgisayardaki WECOMMANDER kurar. Bilgisayarın kapalıysa ya da uygulama açık değilse uzak yapay zekâ bu sunucuya ulaşamaz.");
    public static string ConnectorAlwaysTitle => L.T("Sürekli açık bağlayıcı (yakında)");
    public static string ConnectorAlwaysHelp => L.T("Bağlantıyı 7/24 açık bir makinedeki WECOMMANDER bağlayıcısı kurar; bilgisayarın kapalıyken de çalışır. Bağlayıcı yalnız ona verdiğin sunuculara erişebilir.");
    public static string PresetHeader => L.T("Yapay zekâ ne yapabilir");
    public static string SudoHeader => L.T("Sudo (yönetici yetkisi)");
    public static string TimedDuration => L.T("Süre");
    public static string GuaranteesTitle => L.T("Her zaman açık (kapatılamaz)");
    public static string LimitTitle => L.T("SSH'ın sınırı");
    public static string SshLimit => L.T("SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.");
    public static string BlockedTitle => L.T("Yapay zekâ erişimini açmadan önce");

    public static IReadOnlyList<string> Guarantees =>
    [
        L.T("Onay ekranı her zaman tam komutu gösterir"),
        L.T("Çıktıdaki parola, anahtar ve token'lar maskelenir"),
        L.T("Her işlem denetim kaydına yazılır"),
        L.T("Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz"),
    ];

    public static string PresetTitle(string preset) => preset switch
    {
        AiAccess.ReadOnly => L.T("Salt okunur"),
        AiAccess.Timed => L.T("Süreli otonom"),
        _ => L.T("Onaylı (önerilen)"),
    };

    public static string PresetHelp(string preset) => preset switch
    {
        AiAccess.ReadOnly => L.T("Yapay zekâ dosyaları okuyabilir, klasörleri listeleyebilir, sunucunun durumuna (disk, süreçler, servisler) bakabilir. Komut çalıştıramaz, dosya yazamaz. SSH'ta gerçek “salt okunur” ancak komut çalıştırma kapalıyken mümkündür."),
        AiAccess.Timed => L.T("Seçtiğin süre boyunca (en fazla 8 saat) onay sorulmaz; süre bitince kendiliğinden Onaylı'ya döner. Her işlem yine kaydedilir."),
        _ => L.T("Okuma serbest; komut çalıştırma, dosya yazma, silme ve servis yeniden başlatma her seferinde tam komutu ve sunucuyu gösteren tek kullanımlık onayla yapılır."),
    };

    public static string SudoTitle(string sudo) => sudo == AiAccess.SudoSudoers ? L.T("Sunucudaki sudoers izinleri") : L.T("Asla");

    public static string SudoHelp(string sudo) => sudo == AiAccess.SudoSudoers
        ? L.T("Yalnız sunucuda parolasız izin verdiğin komutlar sudo ile çalışabilir (sudoers). İzinleri sunucuda sen belirlersin.")
        : L.T("Yapay zekâ sudo kullanamaz; sudo parolası hiçbir zaman saklanmaz ya da yapay zekâya verilmez.");

    /// <summary>"bu bilgisayar" or the always-on connector, inside a sentence.</summary>
    public static string ConnectorName(string connector) =>
        connector == AiAccess.ThisComputer ? L.T("bu bilgisayar") : L.T("sürekli açık bağlayıcı");

    /// <summary>Hours offered for the timed preset (8 at most).</summary>
    public static readonly int[] TimedHours = [1, 2, 4, 8];

    public static string Hours(int hours) => L.F("{0} saat", hours);

    /// <summary>"Bitiş: 17.11 18:30" under a running timed preset.</summary>
    public static string TimedEnds(DateTimeOffset until) => L.F("Bitiş: {0}", until.ToLocalTime().ToString("g", L.Culture));

    public static string BlockerText(AiBlocker blocker) => blocker switch
    {
        AiBlocker.NotSsh => L.T("Yapay zekâ erişimi yalnız SSH bağlantılarında var; Telnet, seri port ve Mosh'ta yoktur. Bağlantı türünü SSH yap."),
        AiBlocker.HostKeyUntrusted => L.T("Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz."),
        _ => L.T("Giriş bilgisi sorulmadan bağlanılabilmeli: parolayı ya da anahtarı kaydet (veya SSH agent kullan). Yapay zekâ senden parola isteyemez."),
    };

    public static string BlockerFix(AiBlocker blocker) => blocker switch
    {
        AiBlocker.NotSsh => L.T("SSH'a çevir"),
        AiBlocker.HostKeyUntrusted => L.T("Bir kez bağlan"),
        _ => L.T("Giriş bilgisini kaydet"),
    };

    /// <summary>A clear sentence for an error code of hosts.setAiAccess and the mcp.* calls; null when unknown.</summary>
    public static string? Error(string raw)
    {
        if (raw.Contains(AiAccessRules.HostKeyUntrusted, StringComparison.Ordinal)) return BlockerText(AiBlocker.HostKeyUntrusted);
        if (raw.Contains(AiAccessRules.NeedsCredential, StringComparison.Ordinal)) return BlockerText(AiBlocker.NeedsCredential);
        if (raw.Contains(AiAccessRules.NotSsh, StringComparison.Ordinal)) return BlockerText(AiBlocker.NotSsh);
        if (raw.Contains(AiAccessRules.RemoteNotSupported, StringComparison.Ordinal)) return RemoteNotYet;
        if (raw.Contains(AiAccessRules.TimedTooLong, StringComparison.Ordinal)) return L.T("Süreli otonom en fazla 8 saat olabilir.");
        if (raw.Contains(AiAccessRules.TimedNeedsUntil, StringComparison.Ordinal) || raw.Contains(AiAccessRules.TimedInPast, StringComparison.Ordinal))
            return L.T("Süreli otonom için geçerli bir süre seç.");
        if (raw.Contains(AiAccessRules.InvalidPreset, StringComparison.Ordinal)) return L.T("Geçersiz izin seçimi.");
        if (raw.Contains(AiAccessRules.InvalidSudo, StringComparison.Ordinal)) return L.T("Geçersiz sudo seçimi.");
        if (raw.Contains(AiAccessRules.InvalidConnector, StringComparison.Ordinal)) return L.T("Uzak erişim için bir bağlayıcı seç.");
        if (raw.Contains("connector_offline", StringComparison.Ordinal)) return L.T("Bağlayıcı çevrimdışı; uzak yapay zekâ bu sunucuya şu an ulaşamaz.");
        if (raw.Contains("wecommander_not_running", StringComparison.Ordinal)) return L.T("WECOMMANDER'ı aç; yerel yapay zekâ erişimi uygulama açıkken çalışır.");
        if (raw.Contains("approval_expired", StringComparison.Ordinal)) return L.T("Bu onayın süresi doldu; yapay zekâ isterse yeniden sorulur.");
        if (raw.Contains("unknown_approval", StringComparison.Ordinal) || raw.Contains("approval_not_found", StringComparison.Ordinal))
            return L.T("Bu onay artık geçerli değil (karar verilmiş ya da süresi dolmuş).");
        if (raw.Contains("unknown_client", StringComparison.Ordinal)) return L.T("Bu yapay zekâ istemcisi artık listede yok.");
        if (raw.Contains("unknown_mcp_client", StringComparison.Ordinal) || raw.Contains("unknown mcp client", StringComparison.Ordinal))
            return L.T("Bu yapay zekâ uygulaması tanınmıyor.");
        if (raw.Contains("config_unreadable", StringComparison.Ordinal)) return L.T("Uygulamanın ayar dosyası okunamadı (geçerli JSON/TOML değil). Dosyayı düzeltip yeniden dene; WECOMMANDER bozuk bir dosyanın üzerine yazmaz.");
        if (raw.Contains("config_changed", StringComparison.Ordinal)) return L.T("Ayar dosyası bu arada değişti; değişikliği yeniden göster ve tekrar onayla.");
        return null;
    }

    // ---- Settings → Yapay zekâ ----

    public static string PageTitle => L.T("Yapay zekâ");
    public static string PageSubtitle => L.T("Bu bilgisayardaki yapay zekâ uygulamalarının WECOMMANDER'a bağlanması (yerel MCP).");
    public static string WhatIsLocal => L.T("Yerel MCP, bu bilgisayardaki yapay zekâ uygulamalarının (Claude Desktop, Claude Code, Cursor, Codex) WECOMMANDER üzerinden sunuculara ulaşmasını sağlar. Yalnız “Yapay zekâ erişimi”nde yerel MCP'yi açtığın sunucular görünür. Komutlar bu bilgisayardan doğrudan sunucuya gider; riskli her işlem burada onayına sunulur. WECOMMANDER kapalıyken yapay zekâ hiçbir sunucuya ulaşamaz.");
    public static string ConfigNote => L.T("Bu dosyaya yalnızca WECOMMANDER girdisi eklenir; diğer ayarlarına dokunulmaz.");

    /// <summary>The AI apps the setup helper can configure.</summary>
    public static readonly string[] SetupClients = ["claude-desktop", "claude-code", "cursor", "codex"];

    public static string ClientName(string client) => client switch
    {
        "claude-desktop" => "Claude Desktop",
        "claude-code" => "Claude Code",
        "cursor" => "Cursor",
        "codex" => "Codex",
        _ => client,
    };

    public static string AddTo(string client) => client switch
    {
        "claude-desktop" => L.T("Claude Desktop'a ekle"),
        "claude-code" => L.T("Claude Code'a ekle"),
        "cursor" => L.T("Cursor'a ekle"),
        _ => L.T("Codex'e ekle"),
    };

    public static string ClientHelp(string client) => client switch
    {
        "claude-desktop" => L.T("Anthropic'in masaüstü uygulaması; ekledikten sonra Claude Desktop'ı kapatıp yeniden aç."),
        "claude-code" => L.T("Terminalde çalışan Claude; tüm projelerinde kullanılabilir (kullanıcı ayarı)."),
        "cursor" => L.T("Yapay zekâlı kod düzenleyicisi; tüm projelerinde kullanılabilir (genel MCP ayarı)."),
        _ => L.T("OpenAI'ın terminal ve düzenleyici aracı; ayar ~/.codex/config.toml dosyasına yazılır."),
    };

    public static string ClientRequestTitle(string name) => L.F("{0} bu bilgisayardan WECOMMANDER'a bağlanmak istiyor", name);
    public static string ClientRequestHelp => L.T("İzin verirsen bu uygulama, yapay zekâ erişimini açtığın sunucuları görebilir; riskli her işlem yine tek tek onayına sunulur. Tanımıyorsan reddet. Kararını sol menüdeki Yapay zekâ sayfasından değiştirebilirsin.");

    public static string Outcome(string outcome) => outcome switch
    {
        "ok" or "success" or "done" or "completed" => L.T("tamamlandı"),
        "approved" => L.T("onaylandı"),
        "denied" or "refused" or "rejected" => L.T("reddedildi"),
        "expired" => L.T("süresi doldu"),
        "error" or "failed" => L.T("hata"),
        "blocked" or "not_allowed" => L.T("izin yok"),
        "pending" => L.T("onay bekliyor"),
        _ => outcome,
    };

    /// <summary>"3 dk önce" style time for the client list and the activity list.</summary>
    public static string Ago(DateTimeOffset? when, DateTimeOffset now)
    {
        if (when is not { } t) return L.T("hiç");
        var d = now - t;
        if (d < TimeSpan.FromMinutes(1)) return L.T("az önce");
        if (d < TimeSpan.FromHours(1)) return L.F("{0} dk önce", (int)d.TotalMinutes);
        if (d < TimeSpan.FromDays(1)) return L.F("{0} sa önce", (int)d.TotalHours);
        return t.ToLocalTime().ToString("g", L.Culture);
    }
}
