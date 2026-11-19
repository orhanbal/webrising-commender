import Foundation

/// AI access of one saved SSH host (docs/HYBRID_ACCESS.md, contract section 7):
/// which AI clients may use it (this computer's, through local MCP; remote
/// ones, through wecommander.app and a connector), how much they may do and
/// whether sudo is allowed. Absent on a host = everything off. Same rules
/// as the Windows app (center-windows/Core/AiAccess.cs).
public struct AiAccess: Codable, Equatable, Hashable, Sendable {
    public static let thisComputer = "this-computer"
    public static let readOnly = "readonly"
    public static let approval = "approval"
    public static let timed = "timed"
    public static let sudoNever = "never"
    public static let sudoSudoers = "sudoers"

    /// The longest a timed (autonomous) preset may run.
    public static let maxTimed: TimeInterval = 8 * 3600

    public static let presets = [readOnly, approval, timed]
    public static let sudoModes = [sudoNever, sudoSudoers]

    /// The default of every host: no AI can see it.
    public static let off = AiAccess()

    public var local: Bool
    public var remote: Bool
    public var connector: String
    public var preset: String
    public var timedUntil: String?
    public var sudo: String

    public init(local: Bool = false, remote: Bool = false, connector: String = AiAccess.thisComputer,
                preset: String = AiAccess.approval, timedUntil: String? = nil, sudo: String = AiAccess.sudoNever) {
        self.local = local; self.remote = remote; self.connector = connector
        self.preset = preset; self.timedUntil = timedUntil; self.sudo = sudo
    }

    enum CodingKeys: String, CodingKey { case local, remote, connector, preset, timedUntil, sudo }

    /// Missing fields take their defaults (an older core, a host never changed).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        local = try c.decodeIfPresent(Bool.self, forKey: .local) ?? false
        remote = try c.decodeIfPresent(Bool.self, forKey: .remote) ?? false
        connector = try c.decodeIfPresent(String.self, forKey: .connector) ?? AiAccess.thisComputer
        preset = try c.decodeIfPresent(String.self, forKey: .preset) ?? AiAccess.approval
        timedUntil = try c.decodeIfPresent(String.self, forKey: .timedUntil)
        sudo = try c.decodeIfPresent(String.self, forKey: .sudo) ?? AiAccess.sudoNever
    }

    /// Some AI can use the host.
    public var any: Bool { local || remote }

    public var timedUntilDate: Date? { timedUntil.flatMap(GatewayDates.parse) }

    /// What `hosts.setAiAccess` takes (`timedUntil` is null when not timed).
    public var json: [String: Any] {
        ["local": local, "remote": remote, "connector": connector, "preset": preset,
         "timedUntil": timedUntil.map { $0 as Any } ?? NSNull(), "sudo": sudo]
    }
}

/// Why AI access cannot be switched on for a host yet; each has a fix.
public enum AiBlocker: Equatable, Sendable {
    /// Telnet, serial and Mosh hosts: AI access works only over SSH.
    case notSsh
    /// The host key was never approved (known_hosts has no entry).
    case hostKeyUntrusted
    /// A login would ask for a password: nothing is saved.
    case needsCredential
}

/// What the app checks before it asks the core (the core checks again and decides).
public enum AiAccessRules {
    public static let hostKeyUntrusted = "host_key_untrusted"
    public static let needsCredential = "needs_credential"
    public static let notSsh = "not_ssh"
    public static let remoteNotSupported = "remote_not_supported"
    public static let invalidPreset = "invalid_preset"
    public static let invalidSudo = "invalid_sudo"
    public static let invalidConnector = "invalid_connector"
    public static let timedNeedsUntil = "timed_needs_until"
    public static let timedTooLong = "timed_too_long"
    public static let timedInPast = "timed_in_past"

    /// The access stored for a host (absent = off).
    public static func of(_ host: CoreHost) -> AiAccess { host.aiAccess ?? .off }

    /// Whether this computer serves the host's remote access ("this-computer", or its own Center id).
    public static func servedHere(_ access: AiAccess, centerId: String?) -> Bool {
        access.connector == AiAccess.thisComputer || (!(centerId ?? "").isEmpty && access.connector == centerId)
    }

    /// The connector to store when remote access is on: kept when it was already on
    /// (another computer may serve it), else this computer's Center id.
    public static func connectorFor(_ stored: AiAccess, remote: Bool, centerId: String?) -> String {
        if !remote { return AiAccess.thisComputer }
        if stored.remote, !stored.connector.trimmingCharacters(in: .whitespaces).isEmpty { return stored.connector }
        guard let centerId, !centerId.isEmpty else { return AiAccess.thisComputer }
        return centerId
    }

    /// Plain SSH only: Mosh runs its terminal over UDP, Telnet and serial have no SSH at all.
    public static func isPlainSsh(_ host: CoreHost) -> Bool { ["ssh", ""].contains(host.`protocol` ?? "ssh") }

    /// What stops AI access on this host, in the order to fix it. A key login
    /// without a chosen key may still work silently (this Mac's ~/.ssh keys,
    /// the SSH agent), so only a password login with nothing saved blocks
    /// here; the core has the last word.
    public static func blockers(_ host: CoreHost) -> [AiBlocker] {
        if !isPlainSsh(host) { return [.notSsh] }
        var list: [AiBlocker] = []
        if (host.trustedKey ?? "").isEmpty { list.append(.hostKeyUntrusted) }
        let silent = host.savedSecret || host.keyId != nil || host.identityId != nil || host.authKind != "password"
        if !silent { list.append(.needsCredential) }
        return list
    }

    public static func code(_ blocker: AiBlocker) -> String {
        switch blocker {
        case .notSsh: return notSsh
        case .hostKeyUntrusted: return hostKeyUntrusted
        case .needsCredential: return needsCredential
        }
    }

    /// Drops what does not apply: the connector without remote access, the end time without the timed preset.
    public static func normalize(_ access: AiAccess) -> AiAccess {
        var a = access
        if !a.remote || a.connector.trimmingCharacters(in: .whitespaces).isEmpty { a.connector = AiAccess.thisComputer }
        if a.preset != AiAccess.timed { a.timedUntil = nil }
        return a
    }

    /// An error code when the setting itself is invalid; nil when it can be sent.
    public static func validate(_ access: AiAccess, now: Date) -> String? {
        if !AiAccess.presets.contains(access.preset) { return invalidPreset }
        if !AiAccess.sudoModes.contains(access.sudo) { return invalidSudo }
        if access.remote, access.connector.trimmingCharacters(in: .whitespaces).isEmpty { return invalidConnector }
        if access.preset == AiAccess.timed {
            guard let until = access.timedUntilDate else { return timedNeedsUntil }
            if until <= now { return timedInPast }
            // A minute of slack for the time it takes to save.
            if until > now.addingTimeInterval(AiAccess.maxTimed + 60) { return timedTooLong }
        }
        return nil
    }

    /// Whether the core can serve remote AI access (`app.info` / `mcp.status`).
    public static func remoteSupported(info: [String: Any]?, status: [String: Any]? = nil) -> Bool {
        func flag(_ o: [String: Any]?, _ name: String) -> Bool { (o?[name] as? Bool) == true }
        func feature(_ o: [String: Any]?) -> Bool { (o?["features"] as? [String])?.contains("remote-mcp") == true }
        return flag(info, "remoteMcp") || feature(info) || flag(status, "remoteSupported") || flag(status, "remote") || feature(status)
    }

    /// The hosts this Mac shares with remote AI now (what the connector publishes).
    public static func sharedHere(_ hosts: [CoreHost], centerId: String?) -> [CoreHost] {
        hosts.filter { h in
            let a = of(h)
            return a.remote && servedHere(a, centerId: centerId)
        }
    }
}

/// Every text of the AI access page (the Windows app's wording and keys).
public enum AiAccessText {
    public static var sectionTitle: String { L.t("Yapay zekâ erişimi") }
    public static var header: String { L.t("Bağlantı yöntemi ile yapay zekâ erişimi ayrı ayarlardır. Bu sunucuya yapay zekâ erişimini sen açmadıkça hiçbir yapay zekâ bu sunucuyu göremez.") }
    public static var localTitle: String { L.t("Bu bilgisayardaki yapay zekâlar (yerel MCP)") }
    public static var remoteTitle: String { L.t("Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)") }
    public static var remoteHelp: String { L.t("wecommander.app üzerinden bağlanan yapay zekâlar bu sunucuyu kullanabilir. Komut ve çıktı WECOMMANDER sunucusundan geçer (parola ve anahtarlar maskelenir); SSH anahtarın hiçbir zaman buluta gönderilmez, işi aşağıda seçtiğin bağlayıcı yapar.") }
    public static var remoteNotYet: String { L.t("Uzak yapay zekâ erişimi bir sonraki sürümde gelecek; şimdilik yerel erişim açılabilir.") }
    public static var remoteThisComputerHelp: String { L.t("Bilgisayarın açık ve WECOMMANDER çalışıyorken, Claude/ChatGPT bu sunucuya senin bilgisayarın üzerinden erişir; anahtarlar bilgisayarından çıkmaz. Komutlar her seferinde onay ister.") }
    public static var remoteNeedsSignIn: String { L.t("Uzak erişim için önce bu uygulamada WECOMMANDER hesabınla oturum aç.") }
    public static var remoteOtherComputer: String { L.t("Bu sunucunun uzak erişimini başka bir bilgisayarındaki WECOMMANDER sağlıyor; o bilgisayar açıkken çalışır.") }
    public static var connectorHeader: String { L.t("Bağlayıcı (uzak erişimi kim kurar)") }
    public static var connectorThisTitle: String { L.t("Bu bilgisayar") }
    public static var connectorThisHelp: String { L.t("Bağlantıyı bu bilgisayardaki WECOMMANDER kurar. Bilgisayarın kapalıysa ya da uygulama açık değilse uzak yapay zekâ bu sunucuya ulaşamaz.") }
    public static var connectorAlwaysTitle: String { L.t("Sürekli açık bağlayıcı (yakında)") }
    public static var connectorAlwaysHelp: String { L.t("Bağlantıyı 7/24 açık bir makinedeki WECOMMANDER bağlayıcısı kurar; bilgisayarın kapalıyken de çalışır. Bağlayıcı yalnız ona verdiğin sunuculara erişebilir.") }
    public static var presetHeader: String { L.t("Yapay zekâ ne yapabilir") }
    public static var sudoHeader: String { L.t("Sudo (yönetici yetkisi)") }
    public static var guaranteesTitle: String { L.t("Her zaman açık (kapatılamaz)") }
    public static var limitTitle: String { L.t("SSH'ın sınırı") }
    public static var sshLimit: String { L.t("SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.") }
    public static var blockedTitle: String { L.t("Yapay zekâ erişimini açmadan önce") }

    public static var guarantees: [String] {
        [
            L.t("Onay ekranı her zaman tam komutu gösterir"),
            L.t("Çıktıdaki parola, anahtar ve token'lar maskelenir"),
            L.t("Her işlem denetim kaydına yazılır"),
            L.t("Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz"),
        ]
    }

    public static func presetTitle(_ preset: String) -> String {
        switch preset {
        case AiAccess.readOnly: return L.t("Salt okunur")
        case AiAccess.timed: return L.t("Süreli otonom")
        default: return L.t("Onaylı (önerilen)")
        }
    }

    public static func presetHelp(_ preset: String) -> String {
        switch preset {
        case AiAccess.readOnly: return L.t("Yapay zekâ dosyaları okuyabilir, klasörleri listeleyebilir, sunucunun durumuna (disk, süreçler, servisler) bakabilir. Komut çalıştıramaz, dosya yazamaz. SSH'ta gerçek “salt okunur” ancak komut çalıştırma kapalıyken mümkündür.")
        case AiAccess.timed: return L.t("Seçtiğin süre boyunca (en fazla 8 saat) onay sorulmaz; süre bitince kendiliğinden Onaylı'ya döner. Her işlem yine kaydedilir.")
        default: return L.t("Okuma serbest; komut çalıştırma, dosya yazma, silme ve servis yeniden başlatma her seferinde tam komutu ve sunucuyu gösteren tek kullanımlık onayla yapılır.")
        }
    }

    /// Timed autonomy is local only: remote calls always ask (HYBRID_ACCESS.md §8).
    public static var timedRemoteNote: String { L.t("Süreli otonom yalnız bu bilgisayardaki yapay zekâlar için geçerlidir; uzak yapay zekânın komutları her seferinde onay ister.") }

    public static func sudoTitle(_ sudo: String) -> String {
        sudo == AiAccess.sudoSudoers ? L.t("Sunucudaki sudoers izinleri") : L.t("Asla")
    }

    public static func sudoHelp(_ sudo: String) -> String {
        sudo == AiAccess.sudoSudoers
            ? L.t("Yalnız sunucuda parolasız izin verdiğin komutlar sudo ile çalışabilir (sudoers). İzinleri sunucuda sen belirlersin.")
            : L.t("Yapay zekâ sudo kullanamaz; sudo parolası hiçbir zaman saklanmaz ya da yapay zekâya verilmez.")
    }

    /// "bu bilgisayar", another computer or the always-on connector, inside a sentence.
    public static func connectorName(_ connector: String, centerId: String?) -> String {
        if connector == AiAccess.thisComputer || (!(centerId ?? "").isEmpty && connector == centerId) { return L.t("bu bilgisayar") }
        return UUID(uuidString: connector) != nil ? L.t("başka bir bilgisayar") : L.t("sürekli açık bağlayıcı")
    }

    /// "Bitiş: …" under a running timed preset.
    public static func timedEnds(_ until: Date) -> String {
        L.f("Bitiş: {0}", until.formatted(date: .numeric, time: .shortened))
    }

    public static func blockerText(_ blocker: AiBlocker) -> String {
        switch blocker {
        case .notSsh: return L.t("Yapay zekâ erişimi yalnız SSH bağlantılarında var; Telnet, seri port ve Mosh'ta yoktur. Bağlantı türünü SSH yap.")
        case .hostKeyUntrusted: return L.t("Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.")
        case .needsCredential: return L.t("Giriş bilgisi sorulmadan bağlanılabilmeli: parolayı ya da anahtarı kaydet (veya SSH agent kullan). Yapay zekâ senden parola isteyemez.")
        }
    }

    public static func blockerFix(_ blocker: AiBlocker) -> String {
        switch blocker {
        case .notSsh: return L.t("SSH'a çevir")
        case .hostKeyUntrusted: return L.t("Bir kez bağlan")
        case .needsCredential: return L.t("Giriş bilgisini kaydet")
        }
    }

    /// A clear sentence for an error code of `hosts.setAiAccess` and the `mcp.*` calls; nil when unknown.
    public static func error(_ raw: String) -> String? {
        if raw.contains(AiAccessRules.hostKeyUntrusted) { return blockerText(.hostKeyUntrusted) }
        if raw.contains(AiAccessRules.needsCredential) { return blockerText(.needsCredential) }
        if raw.contains(AiAccessRules.notSsh) { return blockerText(.notSsh) }
        if raw.contains(AiAccessRules.remoteNotSupported) { return remoteNotYet }
        if raw.contains(AiAccessRules.timedTooLong) { return L.t("Süreli otonom en fazla 8 saat olabilir.") }
        if raw.contains(AiAccessRules.timedNeedsUntil) || raw.contains(AiAccessRules.timedInPast) || raw.contains("invalid_timed_until") {
            return L.t("Süreli otonom için geçerli bir süre seç.")
        }
        if raw.contains(AiAccessRules.invalidPreset) { return L.t("Geçersiz izin seçimi.") }
        if raw.contains(AiAccessRules.invalidSudo) { return L.t("Geçersiz sudo seçimi.") }
        if raw.contains(AiAccessRules.invalidConnector) { return L.t("Uzak erişim için bir bağlayıcı seç.") }
        if raw.contains("connector_offline") { return L.t("Bu sunucuya erişen bilgisayar şu an kapalı; uzak yapay zekâ bu sunucuya şu an ulaşamaz.") }
        return nil
    }

    // MARK: the connector's status (this Mac as the connector)

    public static var connectorTitle: String { L.t("Bu Mac bağlayıcı olarak") }
    public static var connectorExplain: String { L.t("Uzak yapay zekâ erişimini açtığın sunuculara Claude.ai ve ChatGPT, bu Mac'teki WECOMMANDER üzerinden SSH ile ulaşır; sunucuya hiçbir şey kurulmaz. SSH anahtarların ve parolaların bu Mac'ten çıkmaz. Komut çalıştırma ve dosya değişiklikleri her seferinde bu uygulamanın bildiriminde ya da web panelinde onayını bekler.") }

    public static func state(_ status: ConnectorStatus, signedIn: Bool) -> String {
        if !signedIn { return remoteNeedsSignIn }
        switch status.state {
        case .stopped: return L.t("Bağlayıcı çalışmıyor.")
        case .idle: return L.t("Hiçbir sunucu uzak yapay zekâyla paylaşılmıyor; bağlayıcı bekliyor.")
        case .connected: return L.f("Bağlı · {0} sunucu uzak yapay zekâyla paylaşılıyor.", status.shared)
        case .retrying: return L.t("wecommander.app'e ulaşılamıyor; birazdan yeniden denenecek.")
        }
    }

    public static func lastCall(_ call: ConnectorCallRecord, hostName: String) -> String {
        let outcome = call.ok ? L.t("tamamlandı") : (call.error == "approval_required" ? L.t("onay bekliyor") : L.t("hata"))
        return L.f("Son çağrı: {0} · {1} · {2}", hostName, call.tool, outcome)
    }
}
