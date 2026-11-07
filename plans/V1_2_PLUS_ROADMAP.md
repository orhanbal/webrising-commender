# WECOMMANDER v1.2+ yol haritası (İleri Geliştirme Planı 1'in sürümlere bağlanması)

Oluşturulma: 2026-11-05 · Kaynak: [İleri Geliştirme Planı 1 (v0.3)](ADVANCED_DEVELOPMENT_PLAN_1.md)
· Önceki sürüm planı: [v1.1](V1_1_BETTER_THAN_DESKTOP_COMMANDER.md) (kodda tamamlandı)

Bu belge AD1 fikir havuzunu **sıralı, teslim edilebilir sürümlere** bağlar. Fikirlerin
gerekçesi, teknik sınırları ve kabul ölçütleri AD1 belgesinde kalır; burada yalnız
"hangi sürümde, hangi dilimle, neyin üstüne" sorusu cevaplanır.

## Ön koşul: v1.0 kapanışı

Yeni sürüm işi v1.0'ı geciktirmez. v1.0 için kalanlar (çoğu sahip/donanım işi):
Windows ve macOS fiziksel kabulü, yedek/geri yükleme tatbikatı, A4 HTTPS/TLS bağımsız
doğrulaması, GitHub sıkılaştırması (etiket kuralı, `production` ortamı yalnız `main`),
`v1.0` etiketi. v1.2 geliştirmesi bunlarla paralel başlar.

## İlkeler (AD1 §1–§2'den, her sürümde geçerli)

- WECOMMANDER yapay zekâ değildir; kullanıcının seçtiği AI önerir, WECOMMANDER doğrular,
  yetkilendirir, yürütür ve denetler. Zorunlu LLM, vektör DB, ücretli servis yoktur.
  (Bu nedenle eski "Later" listesindeki **Ollama ile özel AI** maddesi yol haritasından
  çıkarıldı: kullanıcı Ollama'yı zaten herhangi bir MCP istemcisi üzerinden bağlayabilir.)
- Önce salt-okunur, sonra tek hedefe onaylı değişiklik, en son toplu değişiklik.
- Her araç AD1 §5 tamamlanma kriterini sağlar: şema + hata kontratı, Gateway yetki,
  Agent uygulaması, risk/onay/audit, kaynak sınırı, pozitif/negatif E2E, CI, doküman,
  yerel mod (`mcp-stdio`) eşliği.

## Zaten elimizde olan temeller

| AD1 | Bugün mevcut olan | Eksik kalan |
|---|---|---|
| AD1-01 çoklu cihaz | tek MCP uç noktası, tüm cihazlar, cihaz bazlı güven | grup/etiket, toplu ve kademeli yürütme |
| AD1-04 telemetri | `system_info`, `process_list` | zaman damgalı sağlık snapshot'ı, trend, eşik |
| AD1-05 log | `text_search`, `fs_read_lines`, terminal sayfalama | journal/log sorgusu, zaman aralığı, seviye, redaksiyon |
| AD1-06 risk/onay | sunucu tarafı tek kullanımlık onay, onay kutusu, audit | işlem planı, before/after, preview |
| AD1-07 bildirim | onay e-postası | olay/uyarı akışı |
| AD1-13 bağlantı | yalnız dışa bağlanan Agent, cihaz kimliği, canlılık | anahtar döndürme akışı |
| AD1-14 Time Machine | `fs_undo`, `fs_versions`, SHA compare-and-swap | çok dosyalı işlem grubu ve grup geri alma |
| AD1-21 gizlilik | dosya içerikleri audit'e yazılmaz | çıktıda sır redaksiyonu, alan politikası |

## v1.2 — Gözlem ve gizlilik (salt-okunur) · ~2 hafta

AD1 Aşama 1. Hiçbiri hedefte değişiklik yapmaz; varsayılan güven seviyesinde açık.

1. **Ortak sonuç zarfı (AD1-12).** Yeni gözlem araçları `target_id`, `observed_at`,
   `source`, `limitations`, `redacted`, `pagination` alanlarıyla döner.
2. **Redaksiyon motoru (AD1-21 dilim 1).** Agent'ta, çıktı cihazdan çıkmadan önce:
   özel anahtar, bearer/API token, parola atamaları, bağlantı dizesi parolaları
   maskelenir; cihaz politikasında aç/kapa ve alan listesi; fail-closed; negatif
   sızıntı testleri. Önce yeni gözlem araçlarına, sonra `process_exec`/terminal çıktısına
   opsiyonel olarak.
   **Durum 2026-11-05:** ilk dilim yapıldı: `process_exec`, `process_list`,
   `task_status`, `terminal_read(_page)` çıktısı cihazda maskeleniyor; varsayılan
   açık, `capabilities --redact-output off` / `mcp-stdio --no-redact` ile kapanır;
   `policy_info.outputRedaction`. Dosya okumaları bilerek ham. Gözlem araçları
   geldikçe onlara da uygulanacak.
3. **`health_snapshot` (AD1-04).** CPU, RAM, disk, ağ, yük, en çok kaynak kullanan
   süreçler; sınırlı ve hafif. Gateway son N snapshot'ı saklar (varsayılan 24 saat).
   **Durum 2026-11-05:** araç yapıldı (uzak ve yerel mod; `observedAt`, `source`,
   `limitations` ile). Gateway'de 24 saatlik saklama ve panodaki sağlık kartı sonraki adım.
4. **`log_query` (AD1-05).** Linux journal (`journalctl` JSON), dosya logları, Windows
   Event Log, macOS `log show`: zaman aralığı, seviye, birim, regex, sayfalama,
   tekrar kümeleme, bayt/satır sınırı, redaksiyon.
   **Durum 2026-11-05:** ilk dilim yapıldı: Linux journal ve izinli kök içindeki
   dosya logları; seviye, regex, sınır, tekrar gruplama, maskeleme; journal için
   `systemLogs` yeteneği. Windows Event Log ve macOS `log show` sonraki dilim.
5. **Servis ve container gözlemi (AD1-03 / AD1-02 salt-okunur).** `service_list`,
   `service_status` (systemd / Windows SCM / launchd); `container_list`,
   `container_inspect`, `container_logs` (Docker API, yalnız okuma uçları; soket erişimi
   yoksa açık `unavailable`).
6. **Pano:** cihaz sayfasında sağlık kartı ve servis/container listesi.

Kabul: büyük logda sınırlı çıktı, sahte sır içeren log ile redaksiyon, yetkisiz soket,
desteklenmeyen platformda `unavailable`, yerel modda aynı araçlar.

### v1.2 düzeltme listesi (Mac kabul testinden, 2026-11-05)
- Sonuç dönmeyen isteklerde (cihaz bağlantısı kopması, zaman aşımı) tek kullanımlık
  onay yanıyor ve istemci yalnız "Bad Gateway" ya da zaman aşımı görüyor: açık hata
  metni ("komut çalışmamış olabilir, yeni onay gerekiyor") ve mümkünse onayın iadesi.
- macOS paketini Apple Developer ID ile imzalamak/noterlemek (izinlerin kalıcı olması,
  Gatekeeper uyarısı); sahibinin Apple Developer hesabı gerekir.

## v1.3 başı — Yönetim Merkezi (masaüstü tepsi uygulaması) · ~2–3 hafta

Sahibin önerisi (2026-11-07), Mac kabul testinden sonra: onaylar için tarayıcıda
Onaylar sayfasını açıp yenilemek yavaş; istekler 10 dakikada düşüyor.

**İki ayrı rol.** Sunucular ve cihazlarda yalnız ajan çalışır (tepsi, ekran, bildirim
yok). **Yönetim Merkezi**, sahibin/yöneticinin masaüstüne (Windows, macOS, Linux)
kurulan tepsi uygulamasıdır; ajan değil, gateway'e kullanıcı hesabıyla bağlanan bir
istemcidir. Tüm sunuculardaki onay istekleri buraya bildirim olarak gelir.

1. **Giriş:** tarayıcıyla cihaz bağlama akışı (bugünkü `connect-device` gibi); uygulama
   iptal edilebilir bir oturum anahtarı alır, şifre saklanmaz, iki adımlı doğrulama
   korunur. Panelde "Yönetim merkezleri" listesi, ad, son görülme, tek tıkla iptal.
2. **Bildirim aboneliği (merkez başına ayar):**
   - ☑ "Tüm sunucuların bildirimlerini bu uygulamadan al" (varsayılan açık);
   - işaret kaldırılınca yalnız seçilen cihazlar/gruplar (AD1-01 grupları gelince);
   - ☐ "Bu bilgisayarı da yönetilen cihaz yap" (isteğe bağlı; ajanı da kurar).
3. **Birden fazla merkez:** bildirim hepsine gider; ilk onay/ret kazanır, diğerlerinde
   bildirim kapanır ve "Ofis-PC'den onaylandı" görünür. Denetim kaydı merkezin adını
   ve kullanıcıyı yazar.
4. **Bildirim:** yerel masaüstü bildirimi; komut, cihaz, risk, kalan süre; **Onayla /
   Reddet** düğmeleri. Yüksek riskte Touch ID / Windows Hello (ya da parola) doğrulaması,
   böylece bir betik onaylayamaz. Gateway tarafı: kullanıcıya özel olay akışı
   (SSE/WebSocket) ve mevcut onay API'si; merkez çevrimdışıyken onaylar panelde ve
   e-postada kalır, merkez açılınca bekleyenleri listeler.
4b. **Otonom mod (sahibin isteği, 2026-11-07):** kullanıcı onayları tamamen devreden
   çıkarabilir; kontrol onda. Kapsam tüm cihazlar ya da seçilenler; süre 30 dk, 1 sa,
   4 sa, yarın sabaha kadar ya da süresiz. Süre bitince onaylar kendiliğinden geri
   döner ve bildirim gelir; "Hepsini durdur" her an tek tık. Altyapı: mevcut cihaz
   güven seviyesi `full`, bitiş zamanıyla (`trust_until`). Güvenceler: cihazın kendi
   sınırları (izinli klasörler, yazma/komut kapalı, sır maskeleme) yine geçerli; mod
   açıkken tepsi simgesi renk değiştirir, panelde uyarı şeridi; her işlem denetimde
   "otonom" etiketli, açan kişi/zaman/süre kaydedilir; açmak WebAuthn ister; mod yalnız
   tepsi uygulamasından veya paneldeki tarayıcı oturumundan açılır, hiçbir MCP aracı
   bunu yapamaz (yapay zekâ kendi onayını kapatamaz).
   **Durum 2026-11-07:** panel ve gateway tarafı yapıldı (`/api/trust/autonomy`, bitiş
   taraması, uyarı şeridi, Onaylar sayfasında kart); tepsi menüsü Yönetim Merkezi ile gelecek.
5. **Tepsi menüsü:** bağlantı durumu, bekleyen onaylar, cihazlar ve çevrimiçi
   durumları, paneli aç, bildirimleri sustur, güncelleme, çıkış.
6. **Teknoloji:** Tauri (Rust; ajanla aynı dil, küçük paket, tek kodla üç platform).
7. **İmzalama (sahibin işi):** macOS için Apple Developer ID + noter, Windows için kod
   imzalama sertifikası. İmzasız da çalışır, ama kurulumda uyarı çıkar ve macOS
   bildirim/izin davranışı zayıflar.

**Sahip kararı (2026-11-07): imzalama masrafları ertelendi.** Gelir belli olmadan Apple
Developer (yıllık 99 $) ve Windows kod imzalama sertifikası alınmayacak; ilk ödeme yapan
kullanıcılar gelince yeniden değerlendirilecek. **İlk sürüm yine tepsi uygulaması**
(kullanıcı için en iyisi) ve **terminalden tek satırla kurulur**: `curl … | sh` ve
PowerShell tek satırı indirme işareti koymadığından Gatekeeper/SmartScreen uyarısı
çıkmaz, imza gerekmez.
- Windows: kurulum Başlat menüsü kısayolunu AppUserModelID ile oluşturur; böylece
  imzasız uygulamada da düğmeli bildirim (toast) çalışır.
- Linux: tepsi ve bildirim (libnotify) imzasız çalışır.
- macOS: tepsi/menü çalışır; düğmeli bildirim için kurulumda yerel (ad-hoc) imza
  atılır, gerçek Mac'te doğrulanacak. Olmazsa tepsideki "Bekleyen onaylar" penceresi
  ve sesli uyarı kullanılır.
- Yüksek riskte Windows Hello / Touch ID yerine (imzasız uygulamada güvenilir
  olmayabilir) gateway'in WebAuthn doğrulaması tepsi penceresinde açılır.
- Yedek: wecommander.app'in yüklenebilir web uygulaması (PWA) + Web Push; telefonda ya
  da tepsinin kurulamadığı yerde. Aynı gateway olay akışını ve onay API'sini kullanır.

Dilimler: (a) giriş + tepsi + bekleyen onay listesi ve onay/ret; (b) masaüstü
bildirimi + düğmeler + Touch ID/Windows Hello; (c) abonelik ayarları ve birden fazla
merkez; (d) imzalı paketler ve otomatik güncelleme.

## v1.3 — Kontrollü değişiklik · ~3 hafta

AD1 Aşama 2.

1. **İşlem grupları ve grup geri alma (AD1-14 dilim 1).** Bir AI turundaki dosya
   yazmaları tek `change_set` kimliği altında; diff, metadata, kısmi başarısızlık
   raporu; çakışma kontrollü grup geri alma; panoda "değişiklikler" sayfası.
2. **Güvenli yürütme modları (AD1-15).** `analysis` / `preview` / `apply`; ilk
   doğrulayıcılar: `nginx -t`, `sshd -t`, `systemd-analyze verify`, JSON/YAML/TOML
   sözdizimi. `sandbox_test` bu sürümde yok (izolasyon kanıtlanamadan sunulmaz).
3. **Servis/container eylemleri (AD1-03 / AD1-02).** `service_restart`,
   `container_restart` vb. yapılandırılmış eylemler: HIGH risk, tek kullanımlık onay,
   önce/sonra durum doğrulaması, ham shell gerektirmez.
4. **Cihaz grupları ve toplu salt-okunur işlem (AD1-01).** Etiket/grup, hedef seçimi,
   cihaz başına sonuç; toplu **değişiklik** yalnız canary + kademe + iptal ile ve ayrı
   onay politikasıyla (AD1 soru 10).

## v1.4 — Olaylar ve orkestrasyon · ~3 hafta

AD1 Aşama 3.

1. **Olay/uyarı (AD1-07).** Kural ve oran tabanlı (ör. SSH başarısız giriş artışı,
   disk %90), tekilleştirme, e-posta/webhook bildirimi, AI'ın sorgulayabileceği
   `events_query`. AI istemcisini kendiliğinden uyandırma iddiası yok.
2. **Orkestrasyon (AD1-16).** Gateway'de bağımlılık sıralı plan, idempotency anahtarı,
   kilit, iptal, cihaz başına sonuç; Agent'lar birbirine emir vermez.
3. **Runbook'lar (AD1-08).** Varsayılan kapalı; allowlist eylemler, tekrar üst sınırı,
   onay; önce yalnız tanılama runbook'ları.
4. **Denetim:** değiştirilemez (zincirlenmiş hash) audit dışa aktarımı, terminal oturum
   kaydı.

## v2.x — Adaptörler ve derin yetenekler (talebe göre sıralanır)

AD1 Aşama 4 ve v0.3 eklemeleri. Her biri opsiyonel, çekirdeğe zorunlu bağımlılık
eklemez.

| Madde | İlk dilim |
|---|---|
| AD1-09 SSH/SFTP | Agent kurulamayan hedefler; host key sabitleme |
| AD1-10 Kubernetes | salt-okunur pod/deployment/olay/log |
| AD1-11 IaC | `terraform plan` / `ansible --check` çıktısı, onaylı apply |
| AD1-14 dilim 2 | LVM/Btrfs/ZFS/VM snapshot adaptörleri, dış değişiklik gözlemi |
| AD1-15 `sandbox_test` + kaos testi | yalnız kanıtlanmış izole/staging ortamda |
| AD1-17 TPM/HSM | opsiyonel cihaz anahtarı koruması ve attestation |
| AD1-18 dijital ikiz | v1.2 verisinden servis/bağımlılık grafı (salt-okunur) |
| AD1-19 optimizasyon | AD1-14/15 üzerine kıyaslamalı değişiklik planı |
| AD1-20 eBPF | opsiyonel Linux süreç/ağ/I/O gözlemi, özellik yoklamalı |
| AD1-21 dilim 2 | alan bazlı veri minimizasyonu, yerel agregasyon |

## v1.2 başlamadan önce sahibin kararı gereken sorular (önerilen varsayılanlarla)

| AD1 sorusu | Önerilen varsayılan |
|---|---|
| 2 — Docker ilk kapsam | v1.2 yalnız okuma; restart/stop v1.3'te HIGH onaylı |
| 3 — telemetri saklama | Agent toplar, Gateway 24 saat saklar, ham log saklanmaz |
| 8 — Time Machine deposu | cihazda, izinli kök altında; Gateway yalnız metadata |
| 10 — toplu onay | tek hedef: mevcut güven seviyesi; toplu değişiklik: her zaman onay |
| 12 — gizlilik varsayılanı | sırlar her zaman maskeli; IP/kullanıcı adı açık, cihaz politikasıyla kapatılabilir |

Bu varsayılanlar itiraz gelmezse v1.2 işinde kullanılır; değişiklik bu tabloya yazılır.

## Değişiklik geçmişi
- **2026-11-05:** İlk sürüm. AD1-01…AD1-21 v1.2 / v1.3 / v1.4 / v2.x'e bağlandı; v1.1
  planının "Later" listesi bu belgeye taşındı; Ollama maddesi AD1 ilkesi gereği çıkarıldı.
