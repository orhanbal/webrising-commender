# WECOMMANDER — Termius Analizi Sonrası Geliştirme Yol Haritası

- **Tarih:** 2026-11-07
- **Dayanak:** [`WECOMMANDER_TERMIUS_COMPETITIVE_ANALYSIS.md`](./WECOMMANDER_TERMIUS_COMPETITIVE_ANALYSIS.md) (§10 puanlama, §9 güvenlik kararları)
- **Temel commit:** `main` = `production` = `3b6734a`
- **Durum:** Öneri. Bu belge mevcut planları (`WEBRISING_COMMENDER_MASTER_PLAN.md`, `V1_2_PLUS_ROADMAP.md`, `ADVANCED_DEVELOPMENT_PLAN_1.md`) değiştirmez. Çelişen noktalar analiz §13.3'tedir.

## Okuma kuralları

- **Efor:** deneyimli tek mühendis-haftası (MH), test ve kabul dahil, ±%40.
- **Öncelik:** A = kesinlikle, B = sonraki aşama (talep/kanıt gelince), C listesi bu yol haritasında yer almaz.
- **Her aşama bağımsız yayınlanabilir:** bir aşamanın paketleri, sonraki aşamalar hiç yapılmasa da ürüne değer katar ve geri alınabilir (özellik bayrağı veya ek API).
- **Production'a çıkış:** yalnız `promote-production.yml` (sahip `production` ortamını onaylar).
- **Ortak kabul kapısı (her paket):** CI yeşil; yeni kod [1] kanıt sınıfında (test + CI işi); Windows + Ubuntu gerçek cihaz kabulü; negatif güvenlik testleri (yetkisiz rol, başka organizasyon, süresi geçmiş bilet, sır sızıntısı taraması); `gateway/test/mcp-client-acceptance.mjs` değişmeden geçer.

## Bağımlılık grafiği

```
F0 Zemin ─┬─> F1: MF ──> WT ──┬─> SH (F3)
          │                   ├─> SPL (F5)
          │                   └─> SR (F5)
          ├─> F2: GR ──> FO (F4)
          │       FM ──────────────> SFTP arka ucu (F6)
          │       PW
          ├─> F3: DX-1 ──> DX-2
          ├─> F4: PV ──> RB
          └─> F6: SSH (MF, WT, GR sonrası) ──> VLT
```

---

## F0 — Zemin (A)

### WP-F0-1 · Açık kabul ve temel borçların kapanışı

- **Geliştirme:** A4 canlı HTTPS/HSTS/TLS/WSS doğrulaması; PostgreSQL restore tatbikatı (`scripts/restore-compose.sh` gerçek yedekle, `plans/BACKUP_RECOVERY_RUNBOOK.md` kanıt bölümü); Draft PR #29 (ConPTY testi) ve PR #25 kararı.
- **Bileşenler:** `scripts/`, `docs/OPERATIONS.md`, `crates/agent/src/terminal.rs` (yalnız test).
- **Bağımlılık:** Yok.
- **Efor:** 1–1,5 MH.
- **Güvenlik riski:** Restore sırasında production verisinin yanlış ortama yazılması → ayrı tatbikat veritabanı.
- **Test:** `ci-postgres-restore.sh`; restore sonrası `migration-idempotence.mjs`; TLS için `gateway/test/tls-smoke.mjs` canlı hedefe karşı.
- **Kabul:** Restore süresi ve veri bütünlüğü (satır sayıları, son denetim kaydı) belgelenmiş; TLS raporu A4'ü kapatır.
- **Öncelik:** A

### WP-F0-2 · `health_snapshot` gürültü düzeltmesi

- **Geliştirme:** Bind-mount ile tekrarlanan diskleri cihaz+bağlama kaynağına göre tekilleştir; `veth*`, `br-*`, `docker0` arayüzlerini varsayılan olarak grupla/gizle; aynı adlı süreçleri (`dockerd`) birleştir.
- **Bileşenler:** `crates/agent/src/system_ops.rs`.
- **Bağımlılık:** Yok.
- **Efor:** 0,5–1 MH.
- **Güvenlik riski:** Yok (salt-okunur).
- **Test:** Birim testleri sahte `sysinfo` girdileriyle (tekrarlı bağlama, 50 `veth`); Ubuntu Docker sunucusunda gerçek çıktı karşılaştırması.
- **Kabul:** Ubuntu sunucusunda disk listesi fiziksel diskleri bir kez gösterir; ağ listesi ≤ fiziksel arayüz + özet satırı.
- **Öncelik:** A (DX-1'in ön koşulu)

---

## F1 — Güvenli insan erişimi (A)

### WP-F1-1 · MF — MFA (TOTP + WebAuthn/passkey) ve step-up

- **Geliştirme:** Kullanıcı başına TOTP (RFC 6238) ve WebAuthn kimlik bilgileri; kurtarma kodları (hash'li); `browser_sessions` üzerinde `mfa_verified_at`; step-up ara katmanı (`requireRecentMfa(maxAgeSec)`) şu işlemlerde: terminal açma, onay verme (yapılandırılabilir), güven seviyesini `full` yapma, API token oluşturma, üye rolü değiştirme. Organizasyon politikası: "tüm üyeler için MFA zorunlu".
- **Bileşenler:** `gateway/src/browser-auth.ts`, `auth.ts`, `db.ts` (yeni tablolar `user_mfa_totp`, `user_webauthn_credentials`, `user_recovery_codes`), `gateway/ui/src/pages/Auth.tsx`, hesap ayarları; Yönetim Merkezi (center token akışı step-up'ı tarayıcıya yönlendirir).
- **Bağımlılık:** WebAuthn sunucu doğrulaması için `@simplewebauthn/server` (MIT, yaygın) — gerekçe: WebAuthn ayrıştırma/doğrulamasını elle yazmak hata riskli. TOTP için ek paket gerekmez (`node:crypto` HMAC).
- **Efor:** 3–4 MH.
- **Güvenlik riskleri:** TOTP sırrının açık metin saklanması (→ gateway anahtarıyla şifreli kolon + loglarda maskeleme), kurtarma kodu kaba kuvvet (→ `rate-limit.ts`), MFA atlatma için eski oturumlar (→ etkinleştirmede diğer oturumları sonlandır), TOTP tekrar oynatma (→ son kullanılan zaman adımı saklanır).
- **Test:** Birim: TOTP penceresi ±1, tekrar oynatma reddi, kurtarma kodu tek kullanım; entegrasyon: step-up gerektiren uçların MFA'sız `403 mfa_required`, 10 dk sonra yeniden istenmesi; WebAuthn sahte doğrulayıcıyla (Playwright sanal kimlik doğrulayıcı); RBAC matrisi (`rbac-matrix-e2e.mjs`) genişletmesi; denetim kaydında sır olmaması.
- **Kabul:** Sahibin hesabında TOTP + passkey kurulur, Windows Yönetim Merkezi ve web'den onay step-up ile çalışır; organizasyon zorunluluğu açıkken MFA'sız üye yalnız MFA kurulum sayfasına erişir.
- **Öncelik:** A (WT'nin ön koşulu)

### WP-F1-2 · WT — Etkileşimli web terminali ve sekmeler

- **Geliştirme:**
  - Gateway: `POST /api/devices/:id/terminals` (step-up + rol ≥ operator) → tek kullanımlık, 60 sn ömürlü terminal bileti; `GET /ws/terminal?ticket=` WebSocket; ajandan terminal çıktısını *push* olarak ileten akış (mevcut `relay-stream.ts` desenini kullanır); giriş/boyutlandırma mesajları ajanın `input`/`resize` çağrılarına eşlenir.
  - Ajan: insan oturumları için ayrı `scope` (`human:<userId>`); çıktı akış bildirimi (sorgulama yerine bildirim; mevcut `read` geri uyumlu kalır); boşta kalma ve 8 saat üst sınır.
  - UI: `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-search`; sekmeler, yeniden bağlanınca `read_page` ile geçmişi doldurma, kopyala/yapıştır, tema (panel temasından).
  - Denetim: `terminal.session_started/ended` (kullanıcı, cihaz, süre, bayt sayısı); giriş içeriği **loglanmaz**.
- **Bileşenler:** `gateway/src/index.ts`, `relay.ts`, `relay-stream.ts`, `security.ts` (CSP), `crates/agent/src/terminal.rs`, `protocol.rs`, `gateway/ui/src/pages/Workspace.tsx`, yeni `Terminal.tsx`.
- **Bağımlılık:** WP-F1-1; npm `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-search` (MIT). Gerekçe: tarayıcıda VT100/xterm öykünücüsünü yeniden yazmak gereksiz ve hata riskli; xterm.js VS Code'un terminalidir.
- **Efor:** 3–4 MH.
- **Güvenlik riskleri:** Oturum hırsızlığı = kabuk (→ MF, bilet, kısa ömür, IP/UA bağlama isteğe bağlı); XSS (→ CSP `script-src 'self'`, xterm bağlantı eklentisi kapalı); bilet tekrar kullanımı (→ tek kullanım, DB'de tüketim işareti); AI'ın insan oturumuna sızması (→ ayrı scope; SH'ye kadar AI insan oturumunu göremez); relay doygunluğu (→ oturum başına bant ve organizasyon başına eşzamanlı terminal kotası).
- **Test:** Birim: bilet ömrü/tek kullanım, scope ayrımı (AI token'ı ile `human:*` terminal listelenemez); e2e (Playwright + gerçek ajan, `agent-e2e.mjs` deseni): `echo`, `vim` açıp kapatma, boyutlandırma, ağ kopması sonrası geçmişin geri gelmesi, 8 saat sınırının simülasyonu; negatif: viewer rolü, MFA'sız, başka organizasyonun cihazı, süresi geçmiş bilet; gecikme ölçümü.
- **Kabul:** Windows (PowerShell, ConPTY) ve Ubuntu (bash) üzerinde `top`/`htop`, `nano`, Türkçe karakter girişi, kopyala/yapıştır çalışır; p95 tuş→yankı < 150 ms (aynı bölge); denetimde oturum başlangıç/bitiş görünür, giriş içeriği görünmez.
- **Öncelik:** A

---

## F2 — Düzen (A)

### WP-F2-1 · GR — Cihaz grupları, etiketler, workspace

- **Geliştirme:** Tablolar `device_groups(id, org_id, name, color)`, `device_group_members`, `device_tags(device_id, tag)`; API CRUD (rol ≥ admin); UI'da cihaz listesi filtreleri, grup kartları; MCP `devices_list` için isteğe bağlı `group`/`tag` filtresi (ek parametre, geri uyumlu); workspace = kullanıcıya ait kaydedilmiş düzen (açık terminal sekmeleri, seçili cihazlar) — `user_workspaces` JSON.
- **Bileşenler:** `gateway/src/db.ts`, `index.ts`, `mcp.ts`, `gateway/ui/src/pages/Devices.tsx`, `Dashboard.tsx`.
- **Bağımlılık:** Yok.
- **Efor:** 2–3 MH.
- **Güvenlik riskleri:** Organizasyonlar arası grup sızıntısı (→ her sorguda `org_id`); bu pakette grup **politika taşımaz**.
- **Test:** Migration idempotence; RBAC (viewer okuyabilir, düzenleyemez); MCP filtre testi; başka organizasyonun grup kimliğiyle erişim reddi.
- **Kabul:** 2 grup + 3 etiketle Ubuntu ve Windows cihazları filtrelenir; Claude'dan `devices_list(group=...)` doğru alt kümeyi döner.
- **Öncelik:** A

### WP-F2-2 · FM — Ajan tabanlı dosya yöneticisi

- **Geliştirme:** UI'da iki panelli gezgin (cihaz → dizin ağacı), önizleme (metin/görsel/PDF), yükleme/indirme, yeniden adlandırma/taşıma/silme, satır içi düzenleyici (mevcut `edit_block`/`fs_write`), sürüm geçmişi ve geri al (`fs_versions`/`fs_undo`). Büyük dosyalar için parçalı aktarım: ajan `fs_read_chunk`/`fs_write_chunk` (ofset + sha256), gateway akış uçları.
- **Bileşenler:** `crates/agent/src/fs_ops.rs`, `protocol.rs`, `gateway/src/index.ts`, `relay.ts`, yeni `gateway/ui/src/pages/Files.tsx`.
- **Bağımlılık:** Yok (UI bileşenleri mevcut tasarım sistemiyle).
- **Efor:** 3–5 MH.
- **Güvenlik riskleri:** Yol geçişi (→ mevcut kapsam kontrolleri, yeni uçlar aynı politika hattından); büyük aktarımla relay doygunluğu (→ hız ve boyut kotası, organizasyon başına eşzamanlı aktarım sınırı); kötü amaçlı yükleme (→ çalıştırma izni verilmez, yalnız yazma); yüksek riskli yollar (`/etc`, `C:\Windows`) için onay (mevcut risk sınıflandırması).
- **Test:** 1 GB parçalı aktarımda kesinti ve devam, sha256 doğrulaması; aynı anda terminal gecikmesinin bozulmadığı ölçüm; negatif: kapsam dışı yol, viewer rolüyle yazma; geri al sonrası içerik eşitliği.
- **Kabul:** Windows ve Ubuntu'da 100 MB dosya yükleme/indirme, düzenleme + geri al; denetimde her yazma işlemi.
- **Öncelik:** A

### WP-F2-3 · PW — PWA onay gelen kutusu ve Web Push

- **Geliştirme:** Manifest + service worker (yalnız `/approvals` kabuğu önbelleğe alınır, veri asla); Web Push abonelikleri (`push_subscriptions` tablosu); `approval-notify.ts`'e Web Push kanalı; bildirimden açılan sayfada Onayla/Reddet (step-up kuralı MF'deki gibi).
- **Bileşenler:** `gateway/src/approval-notify.ts`, `index.ts`, `db.ts`, `gateway/ui/public/sw.js`, `gateway/ui/src/pages/Approvals*`.
- **Bağımlılık:** `web-push` (MIT) veya `node:crypto` ile VAPID imzası — tercih: `web-push` (şifreleme şeması RFC 8291'i doğru uygular). Harici ücretli servis yok; tarayıcı push servisleri standarttır.
- **Efor:** 2–3 MH.
- **Güvenlik riskleri:** Bildirim içeriğinde komut metni/sır (→ yalnız "X cihazında onay bekleyen işlem" + kısa kimlik; ayrıntı oturum açılınca); kilit ekranından onay (→ step-up).
- **Test:** Push gönderimi sahte push servisine; abonelik iptali; süresi geçen onayın 409 dönmesi; içerik maskeleme testi.
- **Kabul:** Android Chrome ve iOS Safari (ana ekrana eklenmiş PWA) ile onay bildirimi gelir ve onay verilir; macOS/Linux masaüstü tarayıcılarında bildirim gelir.
- **Öncelik:** A

---

## F3 — AI farklılaşması (A)

### WP-F3-1 · DX-1 — Servis keşfi (salt-okunur)

- **Geliştirme:** Yeni MCP aracı `service_inventory`: systemd birimleri (Linux), Windows hizmetleri, launchd (macOS), docker/compose konteynerleri (docker soketi varsa ve politika izin veriyorsa), dinlenen TCP portları ve sahibi süreç, TLS sertifika bitiş tarihleri (yerel dosyalardan), paket yöneticisi ve çalışma zamanı sürümleri. UI'da cihaz "envanter" sekmesi.
- **Bileşenler:** `crates/agent/src/system_ops.rs` (veya yeni `inventory.rs`), `gateway/src/mcp.ts`, `local-tools.ts`, UI `Devices.tsx`.
- **Bağımlılık:** WP-F0-2. Yeni crate yok (komut çıktısı ayrıştırma + `sysinfo`).
- **Efor:** 2–3 MH.
- **Güvenlik riskleri:** Ortam değişkenlerinde/komut satırlarında sır (→ `redact.rs`); docker soketine erişim (→ yalnız okuma çağrıları, politika ile kapatılabilir).
- **Test:** Sabit çıktı örnekleriyle ayrıştırıcı testleri (systemd, `ss -ltnp`, `Get-Service`, `docker ps --format json`); Ubuntu Docker sunucusunda gerçek çalışma; maskeleme testi (komut satırında `--password=`).
- **Kabul:** Ubuntu sunucusunda Coolify konteynerleri, açık portlar ve systemd hizmetleri doğru listelenir; Windows'ta hizmetler ve portlar.
- **Öncelik:** A

### WP-F3-2 · DX-2 — Teşhis paketi

- **Geliştirme:** MCP aracı `diagnose_service(name)`: durum + yeniden başlatma sayısı, son 200 log satırı (maskeli, sınırlı bayt), ilgili yapılandırma dosyalarının son değişiklikleri (`fs_versions` + mtime), port çakışması, disk/bellek baskısı; tek, sınırlı boyutlu yapılandırılmış yanıt. UI'da "Teşhis et" düğmesi.
- **Bileşenler:** `log_ops.rs`, `system_ops.rs`, `fs_ops.rs` (salt-okunur), `mcp.ts`.
- **Bağımlılık:** WP-F3-1.
- **Efor:** 1,5–2 MH.
- **Güvenlik riskleri:** Loglarda sır ve kişisel veri (→ maskeleme, bayt sınırı, AD1-21 ilkeleri); log enjeksiyonuyla AI yönlendirme (→ çıktı "güvenilmeyen veri" olarak etiketlenir).
- **Test:** Çökmüş hizmet senaryosu (Ubuntu'da test birimi), log enjeksiyon örneği, büyük log sınırı.
- **Kabul:** Bilerek bozulan bir nginx yapılandırmasında araç hatalı satırı, son değişikliği ve hata logunu tek yanıtta gösterir.
- **Öncelik:** A

### WP-F3-3 · SH — İnsan–AI paylaşımlı terminal oturumu

- **Geliştirme:** İnsan WT oturumunda "AI ile paylaş" anahtarı: (a) **izle** — MCP istemcisi `terminal_read_page` ile bu oturumu okuyabilir; (b) **öner** — AI'ın `terminal_input` çağrısı insanın ekranında onay balonu olarak görünür, insan Enter'a basmadan çalışmaz; (c) **süreli yazma** — insan AI'a X dakika doğrudan yazma izni verir; insan her tuşta kontrolü geri alır. Girişler kaynakla (`human`/`ai:<client>`) etiketlenir; denetimde AI girişleri tam metin, insan girişleri olay olarak.
- **Bileşenler:** `terminal.rs` (paylaşım bayrağı ve giriş kaynağı), `gateway/src/mcp.ts` (paylaşılan oturumların listelenmesi), `approvals.ts` (öneri onayı), `Terminal.tsx`.
- **Bağımlılık:** WP-F1-2.
- **Efor:** 3–4 MH.
- **Güvenlik riskleri:** AI'ın paylaşılmamış insan oturumunu görmesi (→ scope ayrımı + açık paylaşım kaydı); prompt enjeksiyonuyla AI'ın zararlı giriş önermesi (→ öner modunda insan onayı, süreli yazmada izin listesi kontrolü uygulanır); paylaşımın unutulması (→ süre sınırı ve görünür rozet).
- **Test:** Paylaşılmamış oturumun MCP'den görünmezliği; öner modunda onaysız girişin çalışmaması; süre bitiminde yazmanın reddi; giriş kaynağı etiketlerinin denetimde doğruluğu.
- **Kabul:** Sahip Ubuntu'da terminal açar, Claude'a paylaşır; Claude hatayı okuyup düzeltme komutunu önerir; sahip onaylayınca çalışır; denetimde kimin ne yazdığı görünür.
- **Öncelik:** A

---

## F4 — Güvenli değişiklik (A/B)

### WP-F4-1 · PV — Değişiklik öncesi doğrulama (AD1-15 dilimi)

- **Geliştirme:** `fs_write`/`edit_block` için isteğe bağlı `validate` parametresi ve bilinen yollar için varsayılan doğrulayıcılar: `nginx -t`, `sshd -t`, `systemd-analyze verify`, `apachectl configtest`, JSON/YAML/TOML ayrıştırma, `docker compose config`. Akış: snapshot → yaz → doğrula → başarısızsa otomatik `fs_undo` ve hata çıktısı.
- **Bileşenler:** `fs_ops.rs`, `policy.rs` (doğrulayıcı listesi politika içinde), `mcp.ts` (ek parametre).
- **Bağımlılık:** Yok.
- **Efor:** 2–3 MH.
- **Güvenlik riskleri:** Doğrulayıcının kendisinin komut yürütmesi (→ sabit, politika tanımlı doğrulayıcılar; kullanıcı girdisi argüman olarak geçmez).
- **Test:** Bozuk nginx yapılandırmasının yazılıp otomatik geri alınması; doğrulayıcı yokken davranış; JSON/YAML ayrıştırma hataları.
- **Kabul:** Ubuntu'da bozuk `nginx.conf` yazma girişimi canlı yapılandırmayı bozmadan reddedilir.
- **Öncelik:** A

### WP-F4-2 · FO — Fleet işlemleri

- **Geliştirme:** MCP aracı ve UI: grup/etiket seç → komut veya dosya işlemi → **önizleme** (hangi cihazlar, hangi politika sonucu: izinli/onay/red) → tek onay paketi (cihaz başına satır, tek tek reddedilebilir) → **canary** (önce 1 cihaz, başarı ölçütü) → kalan cihazlarda sınırlı eşzamanlılık → toplu sonuç ve başarısızları yeniden deneme.
- **Bileşenler:** `gateway/src/mcp.ts`, `approvals.ts`, `approval-requests.ts`, `relay.ts`, UI.
- **Bağımlılık:** WP-F2-1.
- **Efor:** 3–4 MH.
- **Güvenlik riskleri:** Toplu onayın her şeyi onaylatması (→ onay paketi cihaz başına satır, yüksek riskli komutlar için toplu onay kapalı); hızla yayılan hata (→ canary zorunlu, durdurma düğmesi).
- **Test:** 3 cihazlı grupta canary başarısızlığında durma; tek cihaz reddinin diğerlerini etkilememesi; politika farklılıklarının önizlemede doğru görünmesi.
- **Kabul:** Windows + Ubuntu + (sanal) üçüncü cihazda `uptime`/`Get-Uptime` ve bir yapılandırma dosyası güncellemesi canary ile çalışır.
- **Öncelik:** A

### WP-F4-3 · RB — Change set geri alma (AD1-14 dilimi)

- **Geliştirme:** Bir MCP oturumu/görev kimliği altındaki tüm `fs_*` değişikliklerini `change_set` olarak gruplama; UI'da "bu görevin tüm değişikliklerini geri al" (ters sırada `fs_undo`, çakışma varsa durdur); isteğe bağlı hizmet yeniden başlatma (onaylı).
- **Bileşenler:** `fs_ops.rs`, `audit_logs`, UI.
- **Bağımlılık:** WP-F4-1.
- **Efor:** 2–3 MH.
- **Güvenlik riskleri:** Kısmi geri alma ile tutarsız durum (→ ön kontrol: tüm snapshot'lar mevcut ve hash eşleşiyor; değilse hiçbiri uygulanmaz).
- **Test:** 5 dosyalık değişiklik kümesi geri alma; arada elle değiştirilmiş dosyada durdurma.
- **Kabul:** Ubuntu'da AI'ın yaptığı çok dosyalı yapılandırma değişikliği tek işlemle geri alınır.
- **Öncelik:** B

---

## F5 — Kurumsal ve konfor (B)

| Kod | Geliştirme | Bileşenler | Bağımlılık | Efor | Güvenlik riski | Test / Kabul | Öncelik |
|---|---|---|---|---|---|---|---|
| **WP-F5-1 SPL** | Split view (yatay/dikey, aynı veya farklı cihaz) | `Terminal.tsx` | WT | 1–2 MH | Yok | 4 bölmede eşzamanlı oturum, gecikme bütçesi korunur | B |
| **WP-F5-2 SR** | Oturum kaydı (asciicast v2 uyumlu), hash zinciri, panelde oynatma, saklama süresi politikası | `terminal_history.rs`, gateway depolama, UI | WT | 3–4 MH | Kayıtta parola istemi girişleri (→ yankısız girişler kaydedilmez), depolama boyutu | Kayıt oynatma eşitliği; zincir kurcalama tespiti | B |
| **WP-F5-3 AE** | Denetim dışa aktarma: JSON Lines indirme, syslog (RFC 5424) ve S3 uyumlu hedef | `audit_logs`, yeni `audit-export.ts` | Yok | 1–2 MH | Hedef kimlik bilgileri (→ şifreli ayar, maskeleme) | Sahte syslog/S3 (MinIO) hedefi | B |
| **WP-F5-4 SSO** | OIDC (Google Workspace, Entra ID, Keycloak); SAML ileride | `browser-auth.ts`, `organizations` | MF | 3 MH | IdP karışıklığı, e-posta doğrulanmamış hesap bağlama | Keycloak konteyneriyle e2e | B |
| **WP-F5-5 SN** | Onaylı runbook'lar: parametreli komut şablonu, bir kez onay, izin listesine bağlı; AI ve insan ortak kullanır | `command-allowlist.ts`, UI | Yok | 2–3 MH | Parametre enjeksiyonu (→ tipli parametre, kabuk kaçışı yok, argv) | Enjeksiyon negatif testleri | B |
| **WP-F5-6 TP** | Görev durumunun diskte kalıcılığı; imzalı zamanlanmış işler (sabit komut + cihaz + takvim, değişince yeniden onay) | `task_manager.rs`, gateway zamanlayıcı | Yok | 3 MH | Unutulan zamanlanmış iş (→ süre sonu, panelde liste) | Ajan yeniden başlatmada görev durumu korunur | B |
| **WP-F5-7 DSK** | Windows Yönetim Merkezi'nden WT açma (WebView2); talep olursa macOS menü çubuğu | `center-windows/` | WT | 1–4 MH | Token saklama (DPAPI mevcut) | Windows'ta merkezden terminal | B |

---

## F6 — İkinci bağlantı modeli: ajan-aracılı SSH (B)

### WP-F6-1 · SSH — Bastion ajan üzerinden ajansız hedefler

- **Geliştirme:** Cihaz politikasına `ssh_targets` (host, port, kullanıcı, sabitlenmiş host key parmak izi) eklenir; hedef ekleme rol ≥ admin + step-up + onay. İlk dilim: ajan, mevcut PTY içinde sistem `ssh` ikilisini `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=<ajan yönetimli>` ile çalıştırır (yeni bağımlılık yok). İkinci dilim: `russh` ile yerleşik istemci (Windows'ta OpenSSH olmayan durumlar, keyboard-interactive). Hedefler UI'da bastion cihazın altında "alt cihaz" olarak görünür; terminal, dosya (SFTP arka ucu FM'ye) ve politika aynı hattan.
- **Bileşenler:** `terminal.rs`, `policy.rs`, yeni `ssh_target.rs`, `gateway/src/db.ts`, `mcp.ts`, UI.
- **Bağımlılık:** MF, WT, GR; ikinci dilimde `russh` (Apache-2.0, saf Rust) — gerekçe: OpenSSH ikilisinin her platformda bulunmaması ve programatik SFTP ihtiyacı.
- **Efor:** İlk dilim 4–6 MH; ikinci dilim + SFTP arka ucu 6–8 MH.
- **Güvenlik riskleri:** MITM (→ host key sabitleme zorunlu, değişince otomatik red + sahibe bildirim); yanal hareket (→ yalnız allowlist'teki hedefler, `ssh` argümanları kullanıcıdan alınmaz); anahtar sızıntısı (→ VLT modeli, `redact.rs` anahtar desenleri); ProxyCommand/LocalForward kötüye kullanımı (→ `-o` seçenekleri sabit beyaz liste, `-L/-R/-D` yasak).
- **Test:** Host key değişimi reddi; allowlist dışı hedef reddi; `-L` enjeksiyon girişimi reddi; Ubuntu bastion → ikinci Ubuntu VM'e terminal ve dosya; denetimde hedef bilgisi.
- **Kabul:** Ajan kurulamayan bir Linux hedefe bastion ajan üzerinden terminal ve dosya erişimi; AI aynı hedefe izin listesi ve onay kurallarıyla erişir; gateway veritabanında hiçbir private key yoktur (doğrulama sorgusu).
- **Öncelik:** B

### WP-F6-2 · VLT — Anahtar saklama (local-only + hardware-backed)

- **Geliştirme:** Bastion ajanda anahtar üretimi/içe aktarımı: Windows DPAPI/CNG, macOS Keychain, Linux Secret Service veya 0600 dosya + parola; FIDO2 `sk-ssh-ed25519@openssh.com` desteği (ilk dilimde OpenSSH ikilisi üzerinden); gateway yalnız meta veri (parmak izi, tip, oluşturma, son kullanım). Rotasyon: yeni anahtar üret → hedefe açık anahtarı ekleme komutunu öner (onaylı) → eskiyi kaldır.
- **Bileşenler:** yeni `crates/agent/src/keystore.rs`, `policy.rs`, UI.
- **Bağımlılık:** WP-F6-1; Rust `keyring` crate (MIT/Apache-2.0) veya doğrudan platform API'leri.
- **Efor:** 3–4 MH (istemci tarafı şifreli ekip senkronu bu pakete dahil değildir; ayrı kriptografi incelemesi gerektirir).
- **Güvenlik riskleri:** Anahtarın log/çıktıya düşmesi, dışa aktarma, cihaz kaybı.
- **Test:** Anahtar materyalinin hiçbir RPC yanıtında, logda, denetimde bulunmadığını tarayan test; rotasyon akışı; FIDO2 (gerçek anahtarla manuel kabul).
- **Kabul:** Rotasyon sonrası eski anahtar hedefte çalışmaz; gateway DB ve loglarında `PRIVATE KEY` deseni yok.
- **Öncelik:** B

---

## Bu yol haritasında bilinçli olarak yer almayanlar (C)

Port forwarding / SOCKS, çok yazarlı Multiplayer, yerel iOS/Android uygulamaları, IDE uzak bağlantıları, tek tıkla geliştirme ortamı / repo kurulumu / Dev Containers, uzak debugging, kendi AI komut tamamlama modelimiz, Mosh / Telnet / Serial. Gerekçeler analiz §5 ve §6.3'te.

## Toplam efor özeti

| Aşama | Öncelik | Efor (MH) |
|---|---|---|
| F0 | A | 1,5–2,5 |
| F1 | A | 6–8 |
| F2 | A | 7–11 |
| F3 | A | 6,5–9 |
| F4 | A/B | 7–10 |
| F5 | B | 14–21 |
| F6 | B | 13–18 |
| **A listesi toplamı (F0–F4, RB hariç)** | | **~26–38** |
