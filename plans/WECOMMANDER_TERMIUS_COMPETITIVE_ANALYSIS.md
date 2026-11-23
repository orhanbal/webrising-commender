# WECOMMANDER vs TERMIUS — Teknik, Ürün ve Rekabet Analizi

- **Tarih:** 2026-11-07 (Türkiye saati)
- **İncelenen kod:** `main` = `production` = `3b6734a` ("Discoverability for search engines and AI assistants (#95)")
- **Açık PR'lar (inceleme anında):** [orhanbal/webrising-commender#29](https://github.com/orhanbal/webrising-commender/pull/29) (Draft, Windows ConPTY test düzeltmesi), [orhanbal/webrising-commender#25](https://github.com/orhanbal/webrising-commender/pull/25) (1C/1D kabul kapıları, yalnız doküman)
- **Durum:** Bu belge bir analizdir. Kod, mevcut planlar, production veya PR durumu değiştirilmemiştir. Ana planla çelişen öneriler §13.3'te ayrıca listelenmiştir ve plana işlenmemiştir.
- **Eşlik eden belge:** [`WECOMMANDER_TERMIUS_DEVELOPMENT_ROADMAP.md`](./WECOMMANDER_TERMIUS_DEVELOPMENT_ROADMAP.md)

### Kanıt sınıflandırması (tüm belgede)

| Kod | Anlamı |
|---|---|
| **[1]** | Kodda mevcut ve test edilmiş (birim/entegrasyon testi veya CI işi var) |
| **[2]** | Kodda mevcut, gerçek cihaz/kabul testi eksik veya kısmi |
| **[3]** | Kısmen geliştirilmiş |
| **[4]** | Yalnızca planlanmış (plan dosyasında var, kodda yok) |
| **[5]** | Hiç bulunmuyor |
| **[6]** | Doğrulanamıyor |

Rakip bilgileri için ayrıca: **R** = resmî kaynak (vendor sitesi/dokümanı/blogu/App Store kaydı), **R\*** = resmî URL'nin yalnızca arama motoru özetiyle görülebildiği (tam sayfa okunamadı), **Ü** = üçüncü taraf kaynak, **?** = doğrulanamadı.

### Kaynak erişim kısıtı (önemli)

Bu analizin yapıldığı bulut oturumunun ağ politikası `termius.com` ve `docs.termius.com` alan adlarını çözümlemedi (DNS engeli). Bu nedenle Termius'un resmî sayfaları **doğrudan okunamadı**; bilgiler arama motoru üzerinden resmî URL'lerin özetleri (R\*), App Store kayıtları (R) ve üçüncü taraf incelemelerden (Ü) toplandı. Termius satırlarındaki R\* işaretli iddialar, bir sonraki revizyonda termius.com'un oturum ağına izin verilerek tam sayfa okumasıyla yeniden doğrulanmalıdır. Erişim tarihi tüm kaynaklar için 2026-11-07'dir.

---

## 1. Executive Summary

**Kısa sonuç:** Termius ile "SSH istemcisi" ekseninde birebir rekabet etmek WECOMMANDER için ekonomik ve teknik olarak doğru değildir. Termius; SSH/Mosh/Telnet/Serial/SFTP, host chain, üç tip port yönlendirme, uçtan uca şifreli kasa ve 5 platformda olgun bir istemci sunar ve ücretsiz Starter planı SSH + SFTP + port forwarding'i zaten verir (R\*). WECOMMANDER'da ise **SSH kodunun tek satırı yoktur** ([5]); buna karşılık Termius'ta olmayan, gerçek kodla desteklenen bir çekirdeği vardır: **giden bağlantılı Rust ajanı + MCP + komut düzeyinde politika/onay + denetim + geri alma**.

Doğru hedef: *"AI ajanlarının ve insanların aynı sunucuda, aynı yetki ve onay kuralları altında güvenle çalıştığı, self-hosted kontrol düzlemi"*. Bunun için Termius'tan kopyalanması gereken tek kritik şey **günlük terminal deneyimidir** (etkileşimli web terminali, sekmeler, gruplar, dosya yöneticisi). SSH protokol yığını değil.

**En önemli 10 bulgu**

1. **SSH/SFTP/SCP/Mosh/Telnet/Serial kodu yok [5].** `crates/` ve `gateway/` içinde `ssh`, `sftp`, `russh`, `ssh2` araması boş; tek SSH referansları plandadır (`plans/ADVANCED_DEVELOPMENT_PLAN_1.md` AD1-09 "SSH/SFTP erişim adaptörü", `plans/V1_2_PLUS_ROADMAP.md` tablo satırı) [4].
2. **Web panelinde etkileşimli terminal yok [5].** `gateway/ui/src/pages/Workspace.tsx:86` komut çıktısını bir `<pre>` içinde gösterir; UI bağımlılıklarında `xterm` yoktur. Ajan tarafındaki PTY altyapısı ise güçlüdür (bkz. 3).
3. **Ajan PTY altyapısı olgun [1].** `crates/agent/src/terminal.rs` → `TerminalManager::{start,list,input,read,read_page,resize,stop}` (satır 168–488), `portable-pty 0.9`, Windows ConPTY + Job Object (`windows_job.rs`), kalıcı geçmiş `terminal_history.rs` (1 MiB halka, 24 saat TTL, 64 arşiv, 32 canlı slot, `WCTH0002` sağlama toplamlı biçim). Yani "insan terminali" için eksik olan katman **sunucu değil, istemci UI**'dır.
4. **Güvenlik çekirdeği Termius'ta karşılığı olmayan bir farklılaştırıcı [1].** Tek kullanımlık onaylar (`gateway/src/approvals.ts`, `approval-requests.ts`), cihaz başı komut izin listesi (`command-allowlist.ts` + `command-allowlist.test.ts`, tablo `device_command_allowlist`), güven seviyeleri `strict|standard|full` (`gateway/src/db.ts:287–291`, süreli `trust_full_until`), çıktı maskeleme (`crates/agent/src/redact.rs`), dosya geri alma (`fs_versions`/`fs_undo`, `fs_ops.rs`), `audit_logs` tablosu. Termius'ta komut düzeyinde politika/onay **bulunamadı** (?).
5. **Kimlik ve kurumsal katmanda Termius'un gerisindeyiz [5].** Gateway'de MFA/TOTP/WebAuthn, SSO/OIDC/SAML kodu yok. Roller `viewer/operator/admin/owner` (`gateway/src/auth.ts:24`) [1]; `organizations`, `organization_members`, `invitations`, `api_tokens` tabloları var [1]. Termius App Store kaydında hesap 2FA'sı var (R); SSO Enterprise'da (R\*).
6. **Cihaz grupları/etiketleri yok [5].** `devices` tablosunda grup/etiket kolonu yok; çoklu sunucu işlemleri ve "workspace" bu eksik yüzünden kurulamaz.
7. **Arka plan görevleri ajan yeniden başlatmasına dayanıklı değil [3].** `task_manager.rs` görevleri bellekte tutar; gateway kopmasına dayanır, ajan yeniden başlamasına dayanmaz. Terminal geçmişi diskte kalıcıdır, görevler değildir.
8. **Termius'un AI yönü bizimkiyle çakışmıyor, yakınsıyor.** Termius ücretsiz planda AI komut tamamlama (Ü/R\*), "Gloria" adlı deneysel DevOps ajanı (2025-08-20 blog, sınırlı önizleme, kasa entegrasyonu yok — R\*) ve 2025-10-29'da "Multiplayer" duyurdu (R\*). Termius'un ajanı **kendi bulutunda** çalışır; WECOMMANDER'ın modeli "kullanıcının seçtiği AI istemcisi + kullanıcının sunucusu + kullanıcının politikası"dır. Bu, self-hosted ve BYO-AI müşterisi için gerçek farktır.
9. **Termius kasası istemci tarafı şifreli (R\*).** Şifreleme parolası cihazdan çıkmaz, kaybedilirse veri kurtarılamaz; ekip kasalarında her kasanın anahtarı üyenin açık anahtarıyla şifrelenip bulut üzerinden dağıtılır; SSO kullanıcıları da ayrıca kasa parolası girer (docs.termius.com/security/encryption-overview, R\*). Bizim olası SSH kasamız bundan **daha zayıf** olmamalıdır; gateway'de çözülebilir private key saklamak bu çıtanın altındadır.
10. **Yedek/geri yükleme ve kabul kapanışı hâlâ açık [2].** `scripts/backup-compose.sh`, `restore-compose.sh`, `test-postgres-restore.sh`, `ci-postgres-restore.sh` ve `plans/BACKUP_RECOVERY_RUNBOOK.md` var; gerçek restore tatbikatı, A4 (canlı TLS) ve A8 (v1.0 kapanışı) bekliyor. Yeni bir SSH/kasa yüzeyi açmadan önce bu temel kapanmalıdır.

**Önerilen ilk 5 geliştirme** (ayrıntı §10–§11)

1. **WT — Etkileşimli web terminali** (xterm.js, mevcut `terminal_*` üzerine, sekmeler; step-up kimlik doğrulama ile) — puan 4.45
2. **GR — Cihaz grupları, etiketleri ve workspace'ler** — 4.05
3. **FM — Ajan tabanlı dosya yöneticisi** (SFTP yerine mevcut `fs_*` araçları üzerinden) — 3.90
4. **DX — Servis keşfi + teşhis paketi** (salt-okunur; systemd/docker/port/log/son değişiklikler) — 4.00 / 4.10
5. **SH — İnsan–AI paylaşımlı terminal oturumu** (AI'ın insanın açtığı terminali onaylı ve görünür biçimde kullanması) — 4.15

Bunlara **MFA (TOTP + WebAuthn)** bir *güvenlik ön koşulu* olarak eşlik eder: insanlara web üzerinden tam kabuk açılmadan önce zorunludur (§9).

**Özellikle reddedilen / ertelenen öneriler**

- **P1 Port Forwarding / SOCKS (yakın vadede ret, C):** Ajanı genel amaçlı tünele çevirir; "gelen port açmayan ajan" güvenlik iddiasını ve politika modelini delip geçer. Jump host yalnızca ileride SSH adaptörünün iç ayrıntısı olarak ele alınır.
- **P2 Terminal Multiplayer (Termius tarzı, C):** Yerine SH (insan–AI paylaşımlı oturum + salt-okunur izleme) önerilir.
- **P2 Yerel iOS/Android uygulaması (C):** Yerine PWA onay gelen kutusu + mobil uyumlu terminal önerilir.
- **P0 Agentless SSH (P0'dan B'ye düşürüldü):** İkinci bağlantı modeli olarak değerli, ama ancak "ajan-aracılı SSH" (bir ajanın bastion olduğu, anahtarın gateway'e gelmediği) biçiminde ve WT + MFA + kasa kararı sonrasında.
- **P0 SSH Vault (P0'dan B'ye):** SSH olmadan değeri yok; birincil model "cihaz-yerel + donanım destekli", senkron yalnız istemci tarafı şifreli (§9.3).
- **P0 SFTP (biçim değişikliğiyle A):** SFTP protokolü değil, ajan dosya API'leri üzerinden dosya yöneticisi.
- **Bağımsız alanlardan reddedilenler:** Tek tıkla geliştirme ortamı, GitHub deposundan ortam kurulumu, Dev Containers, IDE bağlantıları, uzak debugging, geliştirme ortamı senkronizasyonu — WECOMMANDER'ın değil DevAgent / WebRising Starter Pack'in alanı veya VS Code Remote-SSH, Coder gibi ürünlerde zaten iyi çözülmüş (§6.3).

---

## 2. WECOMMANDER'ın mevcut teknik durumu

### 2.1 Bileşenler ve ölçek

| Bileşen | Konum | Ölçek / Not | Kanıt |
|---|---|---|---|
| Rust ajanı | `crates/agent/src/*.rs` | ~20,8k satır; 284 `#[test]`/`#[tokio::test]` | `grep -c` ile sayıldı |
| Gateway (TS/Node) | `gateway/src/*.ts` | ~13,5k satır; 40 birim test dosyası + `gateway/test/*.mjs` entegrasyon/e2e | `ls gateway/src/*.test.ts` |
| Web UI | `gateway/ui/src` | React SPA | — |
| Yönetim Merkezi (Windows) | `center-windows/` (WinUI 3) + `tray/` (Tauri, yedek) | Core.Tests xUnit 7 test; CI `center-winui`, `center-windows` işleri | `.github/workflows/ci.yml` |
| Veritabanı | PostgreSQL | 37 tablo (`gateway/src/db.ts`) | `create table if not exists` |
| Dağıtım | Docker Compose / Coolify | `docker-compose*.yml`; production yalnız `promote-production.yml` | `docs/RELEASE_POLICY.md` |

Ajan bağımlılıkları (Cargo): `portable-pty 0.9`, `tokio-tungstenite`, `sysinfo`, `reqwest` (rustls), `calamine`, `lopdf`, `umya-spreadsheet`, `windows-service`. SSH kütüphanesi yok.

### 2.2 Özellik envanteri

| Alan | Durum | Kanıt / not |
|---|---|---|
| Ajan mimarisi (giden WebSocket, yeniden bağlanma) | [1] | `crates/agent/src/protocol.rs`; `gateway/test/agent-liveness.mjs`, `native-restart-e2e.mjs`; Ubuntu kabulü `docs/UBUNTU_DEVICE_ACCEPTANCE.md` |
| Gateway bağlantı yönetimi, bölgesel röle | [1]/[2] | `gateway/src/relay.ts`, `relay-cluster.ts`, `relay-stream.test.ts`, `relay-cancellation.test.ts`, `gateway/test/relay-e2e.mjs`; çok bölgeli gerçek kurulum kabulü yok [2] |
| SSH (ajanlı ya da ajansız) | [5] | Kodda yok; AD1-09 plan [4] |
| SFTP / SCP / Mosh / Telnet / Serial | [5] | Kodda yok |
| PTY terminal (başlat/oku/yaz/boyutlandır/durdur) | [1] | `terminal.rs:168–488`; Windows ConPTY testi Draft PR #29'da düzeltiliyor |
| Kalıcı terminal geçmişi | [1] | `terminal_history.rs` (CAP 1 MiB, TTL 24 s, MAX_ARCHIVES 64, MAX_LIVE_TERMINAL_SLOTS 32) |
| Arka plan görevleri | [3] | `task_manager.rs` (`start/list/status/cancel/prune`); bellek içi, ajan yeniden başlayınca kaybolur |
| Dosya yönetimi ve düzenleme | [1] | `fs_ops.rs` (okuma/yazma/taşıma/silme/arama/`edit_block`), `fs_versions`/`fs_undo`; DOCX/XLSX/PDF/görsel araçları `docx_ops.rs`, `spreadsheet_ops.rs`, `pdf_ops.rs`, `image_ops.rs` |
| MCP entegrasyonu (uzak, OAuth) | [1] | `gateway/src/mcp.ts`, `oauth.ts`, `oauth-validation.test.ts`, `gateway/test/mcp-client-acceptance.mjs`, `oauth-integration.mjs`; canlı istemcide ~75 araç görülür |
| Yerel stdio MCP modu | [1] | `crates/agent/src/stdio_mcp.rs`, `gateway/test/local-stdio-e2e.mjs`, `docs/LOCAL_MODE.md` |
| Desktop Commander uyumlu takma adlar | [1] | `gateway/src/dc-compat.ts` + test |
| Kullanıcı paneli | [1] | `gateway/ui/src/pages/*`, `gateway/test/dashboard-ui.test.mjs`, `modern-ui-visual.mjs` |
| Etkileşimli terminal UI | [5] | `Workspace.tsx:86` `<pre>` çıktı; xterm yok |
| Kimlik doğrulama (e-posta/parola, tarayıcı oturumu) | [1] | `browser-auth.ts` + test, `auth_tokens`, `browser_sessions` |
| MFA / SSO | [5] | Kodda yok |
| RBAC (4 rol) | [1] | `auth.ts:24` `roleRank`; `gateway/test/rbac-matrix-e2e.mjs` |
| Cihaz eşleştirme | [1] | `pairing_codes`, `device_link_requests`, `device-link.ts`; kurulumda tarayıcı onayı |
| Cihaz grupları / etiketleri | [5] | `devices` tablosunda yok |
| Komut yetkilendirme (izin listesi) | [1] | `command-allowlist.ts`, `command-allowlist-rules.ts`, testler, `gateway/test/command-allowlist-api.mjs` |
| İnsan onayı (tek kullanımlık, süreli) | [1] | `approvals.ts`, `approval-requests.ts`, `approval-notify.ts`; süresi geçen istek `409 approval_request_expired` |
| Güven seviyeleri / otonom mod | [1]/[2] | `db.ts:287` `strict|standard|full`, `trust_full_until`, `index.ts:180` süre sonu süpürmesi; Yönetim Merkezinden kullanım gerçek cihazda doğrulandı, kabul belgesi yok [2] |
| Masaüstü onay merkezi | [2] | `center-windows/` WinUI 3; bildirim ve Onayla akışı sahibi tarafından Windows'ta denendi, "Urgent" senaryosu son kurulumda doğrulanmayı bekliyor |
| Denetim kayıtları | [1] | `audit_logs`, `platform_admin_audit` tabloları; dışa aktarma/SIEM yok [5] |
| Çıktı maskeleme | [1] | `redact.rs` (komut/görev/terminal çıktısı; dosya okumaları kasıtlı olarak maskelenmez) |
| Oturum kaydı (session recording/replay) | [5] | Terminal geçmişi var ama denetim amaçlı, değiştirilemez kayıt yok |
| Windows / Linux / macOS | [1]/[1]/[2] | CI `rust-platforms` (windows/ubuntu/macos); Ubuntu ve Windows gerçek cihaz kabulü yapıldı; macOS kabul belgesi `docs/MACOS_DEVICE_ACCEPTANCE.md` var, gerçek cihaz kanıtı bekliyor [2] |
| Kurulum | [1] | `install.sh`, `install.ps1`, `gateway/src/install-scripts.ts` + test, SHA-256 doğrulama |
| Kaldırma | [2] | `scripts/` altında linux/macos/windows kaldırma betikleri; CI kabulü yok |
| Çok kullanıcı / ekip | [1] | `organizations`, `organization_members`, `invitations`, kota geçersiz kılma; Paddle faturalama (`paddle.ts` + test) |
| Konsol / süper yönetici | [1] | `platform_administrators`, `SUPER_ADMIN_MASTER_PLAN.md` |
| Yedekleme ve geri yükleme | [2] | Betikler + `ci-postgres-restore.sh`; gerçek restore tatbikatı açık (A7/A8) |
| İzolasyon | [2] | Ajan ayrı servis hesabıyla çalışır (Ubuntu kabulü); Windows Job Object ile süreç ağacı sahipliği; kapsam (`scope`) her terminal API'sinde zorunlu |
| `health_snapshot` | [3] | Çalışıyor; Ubuntu'da bind-mount disk tekrarları, docker `veth` gürültüsü ve tekrarlı `dockerd` girdileri görülen bilinen kusurlar |

### 2.3 Mimari gerçekler (öneriler bunlara dayanır)

- **Ajan dışa bağlanır; sunucuya gelen port açılmaz.** `docs/UBUNTU_INSTALL.md`: "no inbound SSH or HTTP port is added by WECOMMANDER". Bu, ürün konumlandırmasının ana iddiasıdır.
- **Tüm işlemler gateway → ajan RPC'sidir ve aynı politika hattından geçer** (izin listesi → güven seviyesi → onay → denetim). Yeni her bağlantı tipi bu hattın *içinden* geçmelidir.
- **Terminal API'si zaten akış/sayfalama/boyutlandırma destekler**; web terminali için yeni bir ajan protokolü gerekmez, yalnız düşük gecikmeli akış (WebSocket'e push) eklenmesi gerekir.

---

## 3. Termius özellik ve mimari analizi

### 3.1 Ürün ve platform

Termius; Windows, macOS, Linux, iOS ve Android için SSH istemcisidir (App Store kayıtları, R). Çekirdek: host yönetimi, kasa, senkronizasyon, ekip paylaşımı.

### 3.2 Paketler ve fiyatlar

| Paket | Fiyat | Kaynak ve doğrulama |
|---|---|---|
| Starter | Ücretsiz; SSH, SFTP, port forwarding, yerel kasa, AI autocomplete; senkron yok | Ü (makerstack.co 2026 inceleme, termai.sh) + R (App Store "Starter: SSH, Mosh, Telnet, Port Forwarding, SFTP") |
| Pro | ~10 USD/kullanıcı/ay, yıllık faturada; aylık faturada daha yüksek (bir izleyici ~19,99 USD aylık diyor) | Ü; Japonya App Store: ¥1.600/ay, ¥13.000/yıl (R) |
| Team | ~20 USD/kullanıcı/ay (yıllık) | Ü |
| Business | ~30 USD/kullanıcı/ay (yıllık); SAML SSO eklenti olabilir | Ü |
| Enterprise | Teklif usulü; SOC2 Type II raporu ve Enterprise SSO listelenir | R\* (termius.com/pricing özeti) |

Team/Business yalnızca hesap portalından alınabilir, uygulama mağazası/PayPal üzerinden alınamaz (docs.termius.com/administration/billing-and-plans, R\*). **Fiyatlar R\*/Ü düzeyindedir; termius.com/pricing tam okunmadan kesin kabul edilmemelidir.**

### 3.3 Protokoller ve bağlantı

| Yetenek | Termius | Kaynak |
|---|---|---|
| SSH, Mosh, Telnet, SFTP | Var | R (App Store), R\* (docs "connecting to a server") |
| Serial | Masaüstünde var (docs protokol listesinde); bir App Store yorumu COM port bulamadığını söylüyor → platform/plan kapsamı belirsiz | R\* / ? |
| Jump host ("Host Chain", `-J`/ProxyJump eşdeğeri) | Var | R\* (termius.com/documentation/jump-hosts) |
| Port forwarding (local, remote, dynamic/SOCKS) | Var, üç tip | R\* (docs "port-forwarding-and-tunneling") |
| Agent forwarding | Var; işletim sistemi ajanı değil Termius'un yerleşik SSH ajanı, host başına | R\* |
| SSH sertifikaları | Resmî kaynakta doğrulanamadı | ? |
| FIDO2 donanım anahtarı | App Store kaydında "Authenticate using hardware FIDO2 keys"; plan/platform kapsamı belirtilmemiş | R (kapsam ?) |
| SCP | Resmî kaynakta ayrı özellik olarak bulunamadı | ? |

### 3.4 Kasa ve şifreleme mimarisi

- Hesap oluşturulurken istemcide anahtar çifti üretilir; **şifreleme parolası cihazdan çıkmaz, ağa gönderilmez; kaybedilirse veri kurtarılamaz** (termius.com/documentation/encryption, R\*).
- Kasada: host'lar, gruplar, SSH anahtarları, snippet'ler, port forwarding kuralları, known hosts (R\*).
- Ekip kasaları: her kasanın ayrı anahtarı, üyenin açık anahtarıyla şifrelenip bulut üzerinden dağıtılır; MAC sahibinin özel anahtarıyla (R\*).
- SSO sonrasında da kasa için ayrı parola istenir (R\*).
- iOS'ta anahtarlar Keychain'de, Android'de Keystore ile şifreli (R\*).
- İstemci kapalı kaynak; uçtan uca şifreleme iddiasının bağımsız denetimi kamuya açık değil (?). SOC2 Type II raporu Enterprise müşterisine sunuluyor (R\*), rapor içeriği doğrulanamadı.

### 3.5 AI ve işbirliği

- **AI autocomplete / komut üretimi:** Ücretsiz planda (Ü, çelişkili kaynaklar; R\* plan tablosunda "AI autocomplete").
- **Gloria (DevOps AI ajanı):** 2025-08-20 duyuru, deneysel, sınırlı önizleme; görev tarif edilir (ör. Apache kurulumu), Termius Cloud'da çalışır, SSH ile erişilir; **Termius kasasıyla entegre değil**, altyapı elle eklenir (termius.com/blog/devops-ai-agent-gloria, R\*). Komut düzeyinde onay/politika anlatılmıyor (?).
- **Multiplayer:** 2025-10-29 blog yazısı, uzaktan eşli çalışma ve sorun giderme (R\*). Eski sürümlerde 2021'den beri oturum paylaşımı (Ü, softpedia changelog).
- **MCP:** Termius'un MCP sunucusu/istemcisi resmî kaynakta bulunamadı (?).

### 3.6 Termius'un güçlü ve zayıf yanları (WECOMMANDER açısından)

**Güçlü:** Olgun çok protokollü istemci, 5 platform, iyi mobil deneyim, istemci tarafı şifreli kasa, ücretsiz katmanın cömertliği, ekip paylaşımı.
**Zayıf / boşluk:** Sunucu tarafı yürütme politikası yok (yetki SSH kullanıcısının yetkisidir); AI ajanı vendor bulutunda; self-hosted kontrol düzlemi yok; kullanıcının kendi AI istemcisini (Claude, ChatGPT, Cursor) sunucuya güvenle bağlama hikâyesi yok; SSH portunun açık olmasını gerektirir.

---

## 4. Termius vs WECOMMANDER karşılaştırma matrisi

Sütunlar: **WC** = WECOMMANDER durum kodu ve kanıt, **Termius** = durum ve kaynak.

### 4.1 Bağlantı ve protokoller

| Yetenek | WC | Termius |
|---|---|---|
| SSH | [5] | Var (R) |
| Agentless SSH | [5] (AD1-09 [4]) | Var — ürünün kendisi (R) |
| Ajan tabanlı erişim (giden bağlantı) | [1] `protocol.rs` | Yok (?) — Gloria bulutta, ajan modeli yok |
| SFTP | [5]; dosya işlemleri ajan API'siyle [1] | Var (R) |
| SCP | [5] | ? |
| Mosh | [5] | Var (R) |
| Telnet | [5] | Var (R) |
| Serial | [5] | Masaüstü (R\*), kapsam ? |
| SSH Jump Host | [5] | Var, Host Chain (R\*) |
| SSH Tunneling / Port Forwarding | [5] | Var: local/remote/dynamic (R\*) |
| SOCKS Proxy | [5] | Var (dynamic) (R\*) |
| SSH Agent Forwarding | [5] | Var, yerleşik ajan (R\*) |
| SSH Certificates | [5] | ? |
| FIDO2 / donanım anahtarı | [5] (ne SSH ne panel girişi için) | Var, kapsam ? (R) |

### 4.2 Terminal deneyimi

| Yetenek | WC | Termius |
|---|---|---|
| Çoklu terminal sekmeleri | Ajan çoklu PTY [1]; UI [5] | Var (R) |
| Split View | [5] | Var (R\*, Ü) |
| Çalışma alanları | [5] | ? (grup/workspace kavramları var) |
| Oturum kaydetme / geri yükleme | Geçmiş arşivi [1] (`terminal_history.rs`); UI [5] | Yeniden bağlanma (2023 "auto-reconnect" blog, R\*) |
| Kalıcı oturumlar | [1] — terminal gateway kopmasına dayanır, 24 s geçmiş | Mosh ile (R); sunucu tarafı kalıcılık yok (?) |
| Terminal arama | `terminal_read_page` [1]; UI [5] | Var (Ü) |
| Komut geçmişi | [3] (terminal çıktısı; ayrı komut geçmişi yok) | Var (Ü) |
| Snippets | [5] | Var (Pro'da senkron, Ü) |
| Autocomplete | [5] | Var, AI destekli (Ü/R\*) |
| Broadcast Input | [5] | ? |
| Tema / kişiselleştirme | Panel teması [1]; terminal [5] | Var (R) |
| Kopyala / yapıştır | [5] (etkileşimli terminal yok) | Var (R) |
| Terminal boyutlandırma | `resize` [1]; UI [5] | Var (R) |
| Mobil terminal deneyimi | [5] (panel mobil uyumlu, terminal yok) | Var, güçlü (R) |

### 4.3 Sunucu ve bağlantı yönetimi

| Yetenek | WC | Termius |
|---|---|---|
| Hosts | Cihazlar [1] (`devices`) | Var (R) |
| Host Groups | [5] | Var (R\*) |
| Tags | [5] | Var (Ü) |
| Bağlantı profilleri | Güven seviyesi + izin listesi cihaz başı [1] | Var (R) |
| SSH Keychain | [5] | Var (R\*) |
| Encrypted Vault | [5] (OAuth/ajan tokenları gateway'de hash'li) | Var, istemci tarafı (R\*) |
| Kimlik bilgisi paylaşımı | [5] (ajan modeli paylaşım gerektirmez) | Var, ekip kasası (R\*) |
| Cihazlar arası senkron | Gateway merkezli doğal [1] | Var, Pro+ (Ü) |
| Host import/export | [5] | ? (ssh_config içe aktarma Ü) |
| SSH Config entegrasyonu | [5] | ? |
| Otomatik bağlantı | Ajan otomatik yeniden bağlanır [1] | Auto-reconnect (R\*) |
| Oturum/cihaz sağlık kontrolü | `health_snapshot` [3], çevrimiçi durumu [1] | ? |

### 4.4 Kurumsal

| Yetenek | WC | Termius |
|---|---|---|
| Organizations | [1] | Var (R\*) |
| Teams | Üyelik + davet [1] | Team planı (Ü) |
| RBAC | 4 rol [1], `rbac-matrix-e2e.mjs` | ? (Business'ta rol kavramı, ayrıntı ?) |
| Shared Vault | [5] | Var (R\*) |
| Shared Hosts | Cihazlar organizasyona aittir [1] | Var (R\*) |
| Multiplayer | [5] | Var (R\*) |
| Audit Logs | [1] `audit_logs` | ? (Enterprise'da olduğu iddiası Ü) |
| Session Recording | [5] | ? |
| SSO | [5] | Enterprise / Business eklentisi (R\*/Ü) |
| MFA | [5] | Hesap 2FA'sı (R) |
| Ekip yetkilendirme | Rol + API token rolü [1] | ? |
| Merkezi politika | İzin listesi, güven seviyesi, onay [1] | ? (bulunamadı) |

### 4.5 Güvenlik

| Yetenek | WC | Termius |
|---|---|---|
| SSH anahtarı saklama | Uygulanamaz (anahtar yok) [5] | İstemci tarafı şifreli kasa, iOS Keychain/Android Keystore (R\*) |
| Zero-knowledge iddiası | Yok; gateway kullanıcı verisini görür (dosya içerikleri relay'den geçer) | İddia var (R\*), bağımsız doğrulama ? |
| Uçtan uca şifreleme | TLS (istemci↔gateway, ajan↔gateway); gateway'de açık metin | Kasa için var (R\*); SSH trafiği doğrudan istemci↔sunucu |
| Sunucu tarafı erişim kontrolü | Ajan politikası + kapsam [1] | SSH kullanıcısının izinleri (sunucunun kendisi) |
| Komut bazlı izinler | [1] izin listesi | Yok (?) |
| Riskli işlem onayı | [1] | Yok (?) |
| Gizli bilgi maskeleme | [1] `redact.rs` | ? |
| Anahtar rotasyonu | Ajan/API token yenileme [1]; SSH yok | ? |
| Şifreli senkronizasyon | Uygulanamaz | Var (R\*) |
| Güvenlik sertifikaları | Yok (SOC2 vb.) | SOC2 Type II raporu Enterprise'a (R\*) |

### 4.6 Yapay zekâ ve otomasyon

| Yetenek | WC | Termius |
|---|---|---|
| AI komut tamamlama | [5] (bilinçli: AI kullanıcının istemcisinde) | Var (Ü/R\*) |
| AI destekli terminal | MCP üzerinden `terminal_*` [1] | Gloria önizleme (R\*) |
| MCP entegrasyonu | [1] uzak + yerel stdio + OAuth | ? (bulunamadı) |
| Otonom işlem | Süreli `full` güven modu [1] | Gloria (R\*) |
| İnsan onaylı operasyon | [1] web + e-posta + Windows Yönetim Merkezi | ? |
| Tekrarlanan komut otomasyonu | [5] | Snippets (Ü) |
| Çoklu sunucu işlemleri | [5] (AI istemcisi sırayla çağırabilir; toplu API yok) | ? (broadcast belirsiz) |
| Görev zamanlama | [5] | ? |
| Hata tespiti | `log_query`, `health_snapshot` [3] | ? |
| İşlem geri alma | Dosya düzeyinde [1] `fs_undo`; sistem düzeyinde [4] (AD1-14) | Yok (?) |

---

## 5. Mevcut önerilerimizin eleştirel değerlendirmesi

Her öneri için 10 soru: (1) var mı, (2) Termius nasıl sunuyor, (3) gerçek fayda, (4) mimariyle uygulanabilirlik, (5) yeni servis/bağımlılık, (6) güvenlik riskleri, (7) karmaşıklık/efor, (8) bakım/teknik borç, (9) bağımsız mı modül parçası mı, (10) öneriyor muyum.

Efor tahminleri tek bir deneyimli mühendis-haftası (MH) cinsindendir ve test + kabul dahildir; ±%40 belirsizlik taşır.

### 5.1 P0 — Agentless SSH bağlantısı

1. **Var mı:** Hayır [5]. AD1-09 olarak planlı [4].
2. **Termius:** Ürünün çekirdeği; istemciden doğrudan SSH, host chain ile jump (R\*).
3. **Fayda:** Ajan kurulamayan hedefler (ağ cihazları, kilitli sunucular, geçici VM'ler, müşteri sunucuları). MSP/sistem yöneticisi için gerçek ihtiyaç; tek başına geliştirici için düşük.
4. **Uygulanabilirlik:** İki model var:
   - **(a) Gateway'den SSH:** Gateway SSH istemcisi olur. Gateway'e private key ve dışa SSH erişimi gerekir; self-hosted gateway'i yüksek değerli hedef yapar. **Önerilmez.**
   - **(b) Ajan-aracılı SSH ("bastion agent"):** Kurulu bir ajan, aynı ağdaki hedefe SSH yapar; anahtar o ajanın cihazında (OS keystore/donanım) kalır. Politika, onay, maskeleme, denetim aynen uygulanır; gateway anahtar görmez. Mevcut mimariye uyar. **Önerilir.**
5. **Bağımlılık:** Rust tarafında `russh` (saf Rust, Apache-2.0) veya sistem `ssh` ikilisinin PTY içinde çalıştırılması. İlk dilim için `ssh` ikilisini mevcut PTY'de çalıştırmak sıfır yeni bağımlılık demektir ama host key ve anahtar yönetimini işletim sistemine bırakır.
6. **Riskler:** Host key doğrulamasının atlanması (MITM), anahtar sızıntısı, ajanın yanal hareket aracına dönüşmesi, politika kapsamı dışı hedefler. Zorunlu: hedef listesi (allowlist) cihaz politikasında, host key sabitleme, her yeni hedef için onay.
7. **Efor:** (b) ilk dilim 4–6 MH; tam (russh, known_hosts yönetimi, UI) 10–14 MH.
8. **Bakım:** SSH uç durumları (algoritma uyumu, keyboard-interactive, MFA'lı sunucular) kalıcı destek yükü getirir.
9. **Yer:** Ajanın `terminal` ve `fs` modüllerine yeni bir "hedef" (target) kavramı; ayrı ürün değil.
10. **Öneri:** **Evet, ama P0 değil, B listesinde**; yalnız model (b) ile, WT + MFA + kasa kararından sonra.

### 5.2 P0 — Güvenli SSH Keychain / Vault

1. **Var mı:** Hayır [5].
2. **Termius:** İstemci tarafı şifreli kasa, ekip kasası anahtarları üye açık anahtarıyla dağıtılır (R\*).
3. **Fayda:** Yalnız SSH (5.1) varsa anlamlı. Ajan modeli zaten "anahtarsız" çalışır; bu bir avantajdır.
4. **Uygulanabilirlik:** §9.3 karşılaştırması. Birincil öneri: anahtar bastion ajanın cihazında, OS keystore (Windows DPAPI/CNG, macOS Keychain, Linux Secret Service veya 0600 dosya + parola) ya da donanım (FIDO2 `sk-ssh-ed25519`, TPM). Gateway yalnız **meta veri** (anahtar parmak izi, hangi hedef) tutar.
5. **Bağımlılık:** Rust `keyring` ya da platform API'leri; isteğe bağlı istemci tarafı şifreli senkron için tarayıcıda WebCrypto.
6. **Riskler:** Gateway'de çözülebilir anahtar = tek noktadan toplu ele geçirme; loglara/çıktılara anahtar sızması (`redact.rs` kapsamı genişletilmeli); kurtarma akışının zayıflığı.
7. **Efor:** Cihaz-yerel model 3–4 MH; istemci tarafı şifreli ekip kasası 8–12 MH + bağımsız kriptografi incelemesi.
8. **Bakım:** Kripto kodu ve anahtar kurtarma, en yüksek riskli bakım alanlarından biridir.
9. **Yer:** 5.1'in alt modülü.
10. **Öneri:** **5.1 ile birlikte, B listesi.** Gateway'de çözülebilir anahtar saklama **reddedilir**.

### 5.3 P0 — Modern çoklu terminal ve Split View

1. **Var mı:** Ajan çoklu PTY [1]; etkileşimli UI yok [5].
2. **Termius:** Sekmeler, split view, temalar, mobil terminal (R/Ü).
3. **Fayda:** En yüksek. Bugün kullanıcı sunucusuna "bakmak" için bile SSH istemcisine gidiyor; panel yalnız AI'ın işini izletiyor. İnsanın günlük işini panelde yapabilmesi ürünün tutunması için kritik.
4. **Uygulanabilirlik:** Çok yüksek. Ajan API'leri hazır; gateway'e terminal başına WebSocket akışı (bugünkü `read` sorgulamasının push karşılığı) ve UI'da xterm.js eklenir. Politika: insan terminalleri ayrı `scope` + rol (≥operator) + step-up kimlik doğrulama; komutlar AI yolu gibi izin listesinden geçmez (insan etkileşimli kabuk), bunun yerine **oturum açma onaya ve denetime tabidir** (V1_2 planındaki 8 saatlik oturum ile uyumlu).
5. **Bağımlılık:** `@xterm/xterm` + `@xterm/addon-fit` (+ isteğe bağlı `addon-search`) — MIT, yaygın, kanıtlanmış. Yeni servis yok.
6. **Riskler:** Web üzerinden tam kabuk = çalınan tarayıcı oturumu = tam kabuk. Bu nedenle MFA + step-up + kısa ömürlü terminal bileti + oturum başına denetim kaydı zorunlu. XSS'e karşı CSP sıkılaştırma.
7. **Efor:** Tek terminal + sekmeler 3–4 MH; split view +1–2 MH.
8. **Bakım:** Düşük–orta; xterm.js kararlı.
9. **Yer:** Mevcut Workspace sayfasının ve `terminal` modülünün parçası.
10. **Öneri:** **Evet, A listesinin 1 numarası.** Split view ikinci dilim.

### 5.4 P0 — SFTP dosya yöneticisi

1. **Var mı:** SFTP yok [5]; ajan dosya API'leri kapsamlı [1] (`fs_*`, `edit_block`, `fs_undo`).
2. **Termius:** SFTP paneli (R).
3. **Fayda:** Yüksek: yükleme/indirme, gözatma, hızlı düzenleme.
4. **Uygulanabilirlik:** SFTP protokolü gerekmez; mevcut `fs_list/fs_read/fs_write/fs_move/fs_delete` üzerine UI kurulur ve büyük dosyalar için parçalı aktarım eklenir. Geri alma (snapshot) ve politika otomatik gelir — SFTP'de olmayan bir avantaj.
5. **Bağımlılık:** Yok (UI bileşenleri). Büyük dosya için gateway'de akış (stream) yükleme.
6. **Riskler:** Büyük aktarımların relay'i boğması (kota/hız sınırı gerekir), yol geçişi (mevcut kapsam kontrolleri korunur), kötü amaçlı dosya yükleme.
7. **Efor:** 3–5 MH (parçalı aktarım dahil).
8. **Bakım:** Düşük.
9. **Yer:** Mevcut `fs` modülü + UI.
10. **Öneri:** **Evet, biçim değiştirilerek A listesi** ("SFTP" yerine "ajan dosya yöneticisi"). Gerçek SFTP yalnız 5.1 SSH adaptörü geldiğinde aynı UI'ya ikinci arka uç olarak eklenir.

### 5.5 P1 — Host Groups ve Workspaces

1. **Var mı:** Hayır [5].
2. **Termius:** Gruplar, etiketler, kasada paylaşım (R\*).
3. **Fayda:** 3+ cihazdan sonra zorunlu; çoklu sunucu işlemlerinin (I2) ve grup bazlı politikanın ön koşulu.
4. **Uygulanabilirlik:** Yüksek: `device_groups`, `device_group_members`, `device_tags` tabloları, API, UI filtreleri. MCP'de `devices_list` filtreleme. Workspace = kaydedilmiş sekme/terminal/dosya düzeni (UI durumu, kullanıcıya ait).
5. **Bağımlılık:** Yok.
6. **Riskler:** Grup bazlı politika eklenirse kalıtım karmaşası; ilk dilimde politika gruba **bağlanmaz**, yalnız düzen ve filtre.
7. **Efor:** 2–3 MH (+ grup politikası 2 MH ayrı dilim).
8. **Bakım:** Düşük.
9. **Yer:** Gateway cihaz modülü.
10. **Öneri:** **Evet, A listesi.**

### 5.6 P1 — Snippets ve gelişmiş komut geçmişi

1. **Var mı:** Hayır [5]; terminal çıktı geçmişi var [1].
2. **Termius:** Snippet'ler, Pro'da senkron (Ü).
3. **Fayda:** Orta. Asıl değer, snippet'lerin **politikayla birleşmesinde**: "onaylı runbook" (bir kez onaylanmış, parametreli, izin listesine bağlı komut) — AI ve insan aynı runbook'u kullanır.
4. **Uygulanabilirlik:** Yüksek; komut geçmişi için kabuk geçmişini okumak yerine WECOMMANDER'dan geçen komutların (AI + insan terminal girişi değil, `process_exec`) kaydı kullanılır.
5. **Bağımlılık:** Yok.
6. **Riskler:** Snippet'lerde gizli bilgi saklanması (kaydetme anında maskeleme/uyarı), parametre enjeksiyonu.
7. **Efor:** 2–3 MH.
8. **Bakım:** Düşük.
9. **Yer:** İzin listesi modülüne yakın.
10. **Öneri:** **B listesi**, "onaylı runbook" biçimiyle.

### 5.7 P1 — Jump Host ve Port Forwarding

1. **Var mı:** Hayır [5].
2. **Termius:** Host Chain, local/remote/dynamic (R\*).
3. **Fayda:** Jump host: SSH adaptörü varsa yararlı. Port forwarding: geliştiricinin uzak DB/servise erişimi için yararlı, ama VS Code, Tailscale, cloudflared, `ssh -L` bunu zaten iyi çözüyor.
4. **Uygulanabilirlik:** Ajan üzerinden TCP tüneli teknik olarak mümkün, fakat ajanı genel amaçlı ağ köprüsüne çevirir; komut politikası, maskeleme ve denetim TCP akışına uygulanamaz.
5. **Bağımlılık:** Gateway'de ham TCP multiplexing, ölçek ve kota yönetimi.
6. **Riskler:** **Yüksek.** İç ağa yanal erişim, veri sızdırma kanalı, "gelen port yok" güvenlik iddiasının fiilen boşa çıkması.
7. **Efor:** 6–10 MH.
8. **Bakım:** Yüksek (relay kapasitesi, kötüye kullanım).
9. **Yer:** —
10. **Öneri:** **Port forwarding / SOCKS: C (reddedildi).** Jump host: 5.1'in iç ayrıntısı olarak B'de. İleride kurumsal talep çıkarsa yalnız "tek hedef, süreli, onaylı, kayıtlı" bir tünel ayrıca değerlendirilir.

### 5.8 P2 — Terminal Multiplayer

1. **Var mı:** Hayır [5].
2. **Termius:** Multiplayer (2025-10-29, R\*), eşli çalışma.
3. **Fayda:** Ekip içi canlı yardım; nişte değerli, ödeme kararını nadiren belirler.
4. **Uygulanabilirlik:** WT üzerine çok izleyicili akış kolay; çok yazarlı giriş zor (giriş sahipliği, sıra, denetim).
5. **Bağımlılık:** Yok.
6. **Riskler:** Kimin hangi tuşa bastığının denetimi, yetkisiz katılım.
7. **Efor:** Salt-okunur izleme 1–2 MH; çok yazarlı 4–6 MH.
8. **Bakım:** Orta.
9. **Yer:** WT'nin parçası.
10. **Öneri:** **Termius tarzı çok yazarlı Multiplayer: C.** Yerine **SH (insan–AI paylaşımlı oturum)** ve **salt-okunur izleme** önerilir; bu, bizim farklılaşma eksenimizdir.

### 5.9 P2 — Windows, macOS, Linux için gelişmiş masaüstü deneyimi

1. **Var mı:** Windows WinUI 3 Yönetim Merkezi [2]; Tauri tepsi yedek [2]; macOS/Linux masaüstü yok [5].
2. **Termius:** Yerel masaüstü istemcileri (R).
3. **Fayda:** Onay ve bildirim için yüksek (zaten yapıldı); masaüstünde tam terminal istemcisi için orta — web terminali (WT) bunu büyük ölçüde karşılar.
4. **Uygulanabilirlik:** Yönetim Merkezi'ne "terminali aç" (WebView2 içinde WT) eklemek kolay; ayrı yerel terminal yazmak gereksiz.
5. **Bağımlılık:** Mevcut.
6. **Riskler:** Masaüstü token saklama (DPAPI ile çözüldü), imzasız ikili uyarıları.
7. **Efor:** WT'yi merkezden açma 1 MH; macOS menü çubuğu uygulaması 3–4 MH.
8. **Bakım:** Her platform ayrı paketleme yükü.
9. **Yer:** Yönetim Merkezi.
10. **Öneri:** **B**: WT'yi Yönetim Merkezi'nde barındır; macOS menü çubuğu sürümü talep olursa. Ayrı yerel terminal uygulaması **önerilmez**.

### 5.10 P2 — iOS ve Android

1. **Var mı:** Hayır [5]; panel mobil tarayıcıda çalışır [2].
2. **Termius:** Güçlü yerel mobil uygulamalar (R).
3. **Fayda:** Mobilde en değerli iş **onay vermek** ve durum görmek; mobilde uzun terminal çalışması azınlık kullanımıdır.
4. **Uygulanabilirlik:** PWA + Web Push ile onay gelen kutusu mevcut API'lerle yapılabilir; yerel uygulama ayrı ekip ve mağaza süreci ister.
5. **Bağımlılık:** PWA: yok (Web Push için VAPID anahtarı). Yerel: Swift/Kotlin veya React Native, mağaza hesapları (ücretli Apple geliştirici hesabı — "gelir gelene kadar ücretli imzalama yok" ilkesiyle çelişir).
6. **Riskler:** Mobilde onay sahteciliği (bildirimden tek dokunuşla onay → step-up gerekli).
7. **Efor:** PWA onay kutusu 2–3 MH; yerel uygulamalar 12+ MH/platform.
8. **Bakım:** Yerel: yüksek.
9. **Yer:** Web UI.
10. **Öneri:** **Yerel uygulamalar: C. PWA onay gelen kutusu + mobil uyumlu WT: A/B** (onay kutusu A).

---

## 6. Claude'un bağımsız geliştirme önerileri

### 6.1 Seçilen öneriler

| Kod | Öneri | Neden WECOMMANDER'a ait | Mevcut temel |
|---|---|---|---|
| **SH** | **İnsan–AI paylaşımlı terminal oturumu.** İnsan bir terminal açar; AI istemcisi (MCP) bu oturumu *görür*, bağlam olarak okuyabilir ve yazmak istediğinde her giriş için onay ister (veya insan oturuma "AI'a X dakika yazma izni" verir). İnsan her an devralır; tüm girişler kimin yazdığıyla birlikte kayıtlıdır. | Termius'un Gloria'sı vendor bulutunda ayrı çalışır; burada AI kullanıcının kendi istemcisidir ve insanın canlı oturumunda, politikayla çalışır. Pazarda bu biçimde bulunamadı (?). | `terminal_*`, `scope`, onaylar, Yönetim Merkezi bildirimleri |
| **DX-1** | **Servis keşfi (salt-okunur).** systemd birimleri, docker konteynerleri/compose projeleri, dinlenen portlar, sertifika bitiş tarihleri, disk/bellek baskısı; cihaz başına "envanter" kartı ve MCP aracı. | AI'ın sunucuyu tanımadan komut üretmesini azaltır; `health_snapshot` doğal genişlemesi. | `system_ops.rs`, `health_snapshot`, `log_ops.rs` |
| **DX-2** | **Teşhis paketi.** "Servis neden çalışmıyor?" için tek çağrıda: durum, son N log satırı (maskelenmiş), son yapılandırma değişiklikleri (`fs_versions`), port çakışmaları, yeniden başlatma sayısı. | Hata teşhisi isteği; salt-okunur olduğu için düşük risk, yüksek AI değeri. | `log_query`, `fs_versions`, `redact.rs` |
| **FO** | **Çoklu cihaz (fleet) işlemleri.** Grup/etiket seçip aynı komutu veya dosya işlemini *önizleme → tek onay paketi (cihaz başına satır) → kademeli yürütme (önce 1 cihaz canary) → toplu sonuç*. | "Broadcast input"un güvenli karşılığı; Termius'ta politika yok. | GR, `process_exec`, onaylar |
| **PV** | **Değişiklik öncesi doğrulama.** Yapılandırma dosyası yazılmadan önce doğrulayıcı (`nginx -t`, `sshd -t`, `systemd-analyze verify`, JSON/YAML/TOML ayrıştırma); başarısızsa yazma geri alınır. | AD1-15 olarak V1_2 planında zaten var [4]; bu rapor önceliğini yükseltmeyi önerir. | `fs_write` + `fs_undo` |
| **RB** | **Kontrollü geri alma (değişiklik kümeleri).** Bir AI görevinde yapılan tüm dosya değişikliklerini tek "change set" olarak gruplayıp tek tıkla geri alma; servis yeniden başlatma ile birlikte. | AD1-14 [4]; `fs_undo` tek dosya düzeyinde [1]. | `fs_versions`, `audit_logs` |
| **MF** | **MFA (TOTP + WebAuthn/passkey) ve step-up.** Panel girişi, onay verme, terminal açma, güven seviyesini `full` yapma için yeniden doğrulama. | WT ve SH'nin güvenlik ön koşulu; Termius'ta 2FA var. | `browser-auth.ts`, `browser_sessions` |
| **PW** | **PWA onay gelen kutusu + Web Push.** Mobil ve macOS/Linux masaüstünde yerel uygulama olmadan onay bildirimi. | Windows'ta WinUI ile yapılan deneyimin diğer platformlara ucuz taşınması. | `approval-notify.ts`, center-link API |
| **SR** | **Oturum kaydı ve tekrar oynatma (denetim).** AI ve insan terminal oturumlarının değiştirilemez (hash zincirli) kaydı, panelde oynatma, dışa aktarma. | Kurumsal/MSP ödeme kararını etkiler; `terminal_history` biçiminin üzerine kurulur. | `terminal_history.rs`, `audit_logs` |
| **TP** | **Kalıcı görevler ve zamanlanmış işler.** Görevlerin ajan yeniden başlamasına dayanması (diskte durum), onaylı zamanlanmış görevler (her çalıştırma yeniden onay istemeden, ama kapsamı sabit "imzalı iş"). | Bulgu 7'deki boşluk; tekrarlanan otomasyon ihtiyacı. | `task_manager.rs` |
| **AE** | **Denetim dışa aktarma (syslog/JSON/S3 uyumlu, self-hosted).** | Kurumsal gereksinim, düşük efor. | `audit_logs` |
| **SSO** | **OIDC SSO (kurumsal).** | Ekip/Enterprise paketinin ödeme tetikleyicisi. | `browser-auth.ts` |

### 6.2 Değerlendirilen ama birleştirilen

- **Ortam bağımlılıklarını analiz etme** → DX-1'in parçası (paket yöneticisi listesi, çalışma zamanı sürümleri).
- **AI ajanlarının mevcut uzak terminal oturumlarıyla güvenli çalışması** → SH'nin kendisi.
- **Hata teşhisi ve kontrollü rollback** → DX-2 + RB.
- **Deployment öncesi kontrol** → PV (cihaz düzeyi). Uygulama düzeyi CI/CD kontrolleri DevAgent'ın alanıdır (aşağıya bakınız).

### 6.3 Reddedilen bağımsız fikirler (sınır ve değer gerekçesiyle)

> **Sınır notu (varsayım):** Depoda DevAgent, Autonomos ve WebRising Starter Pack için resmî bir sorumluluk tanımı bulunamadı (yalnız PR #29 gövdesinde "DEVAGENT" atfı var). Aşağıdaki sınırlar şu çalışma varsayımına dayanır: **WECOMMANDER** = cihaz erişimi, politika, onay, denetim (kontrol düzlemi); **DevAgent** = kod/depo/CI düzeyindeki geliştirme ajanı; **Autonomos** = çok adımlı otonom iş akışlarının planlayıcısı; **WebRising Starter Pack** = proje/ortam şablonları ve hazır kurulumlar. Bu varsayım sahibi tarafından doğrulanmalıdır.

| Fikir | Karar | Gerekçe |
|---|---|---|
| Tek tıkla geliştirme ortamı | C | Starter Pack + DevAgent alanı; Coder, Codespaces, Gitpod iyi çözmüş |
| GitHub deposundan otomatik ortam kurulumu | C | DevAgent alanı; WECOMMANDER yalnız komutların güvenli yürütüleceği yer olmalı |
| Docker / Dev Containers entegrasyonu | C (keşif hariç) | Dev Containers spesifikasyonu VS Code/Coder ekosisteminde olgun; DX-1 konteynerleri *görür*, yönetmez |
| VS Code / Cursor / JetBrains bağlantıları | C | Remote-SSH/JetBrains Gateway olgun; bunun için ajanı SSH sunucusuna veya tünele çevirmek gerekir (5.7 riski). Cursor/Claude zaten MCP ile bağlanıyor [1] |
| Uzak debugging | C | IDE alanı; değer/efor düşük |
| Geliştirme ortamı senkronizasyonu | C | Git ve IDE'lerin işi |
| AI komut tamamlama (kendi modelimizle) | C | "AI sağlayıcısı zorunlu olmamalı" ilkesiyle çelişir; Termius ücretsiz veriyor, farklılaşma sağlamaz |

---

## 7. Rakip ürün karşılaştırması

| Ürün | Modeli | Güçlü yanı | WECOMMANDER'a göre | Fiyat (doğrulama) |
|---|---|---|---|---|
| **Termius** | Kapalı kaynak, bulut senkronlu çok platformlu SSH istemcisi | Mobil + masaüstü olgunluk, şifreli kasa, ekip paylaşımı | SSH ekseninde çok önde; politika/MCP/self-hosted yok | Starter ücretsiz; Pro ~10, Team ~20, Business ~30 USD/kullanıcı/ay yıllık (Ü, R\* kısmen) |
| **Tabby** | Açık kaynak (Electron) terminal | SSH, Telnet, Serial yerleşik; SFTP eklentiyle; eklenti ekosistemi | Yerel istemci; sunucu tarafı politika yok | Ücretsiz (R: GitHub README `Eugeny/tabby`) |
| **MobaXterm** | Windows, kapalı kaynak | X11 sunucusu, çok protokol, SFTP yan paneli | Windows sistem yöneticisi standardı; AI/politika yok | Professional ~69 USD/kullanıcı; tek seferlik mi yıllık mı kaynaklar çelişiyor (Ü) → **doğrulanamadı** |
| **Royal TS / TSX** | Windows/macOS bağlantı yöneticisi (RDP, SSH, VNC, web) | Belge tabanlı paylaşılan bağlantı dosyaları, kimlik bilgisi yönetimi | MSP/sistem yöneticisi; AI/politika yok | Bireysel kullanıcı lisansı 49 EUR, kalıcı (sürüm için), Site 849 EUR; ücretsiz modda 10 bağlantı / 10 kimlik bilgisi sınırı (R: royalapps.com/ts/buy, blog) |
| **SecureCRT** | VanDyke, kapalı kaynak | Kurumsal SSH/Serial, betikleme, uyumluluk | Klasik kurumsal; AI/MCP yok | Fiyat bu oturumda **doğrulanamadı** (G2: vendor fiyat bildirmiyor) |
| **WindTerm** | Kısmen açık kaynak (Apache-2.0 kısmı) | Hızlı, SSH/Telnet/Raw TCP/Serial/Shell, yerleşik SFTP/SCP | Ücretsiz güçlü istemci; politika yok | Ücretsiz (R: GitHub `kingToolbox/WindTerm`, "partial open source") |
| **Teleport** | Altyapı erişim platformu (SSH, K8s, DB, RDP), sertifika tabanlı | Oturum kaydı, erişim istekleri, kısa ömürlü sertifikalar, SSO | **En yakın kurumsal rakip** (onaylı erişim, denetim); ama ağır, SSH merkezli, MCP'li AI yürütme ve komut düzeyi onay odaklı değil | Community Edition v16'dan beri ticari lisans: <100 çalışan ve <10 M USD gelirli şirketlere ücretsiz; Enterprise teklif usulü (R: goteleport.com blog/FAQ) |
| **Coder** | Self-hosted bulut geliştirme ortamları (Terraform) | Geliştirme ortamı yaşam döngüsü, IDE bağlantıları, AI ajan çalışma alanları | DevAgent/Starter Pack alanıyla çakışır; WECOMMANDER'ın rakibi değil, olası tamamlayıcısı | Community ücretsiz/açık kaynak; Premium yıllık kullanıcı başı, fiyat yayımlanmıyor; Community/Premium'da 5 eşzamanlı ajan sınırı, AI Premium'da sınırsız (R: coder.com/pricing) |

### 7.1 Ticari sorular

- **Pazarda iyi çözülmüş ihtiyaçlar:** SSH istemcisi, SFTP, port forwarding, sekmeler, şifreli kasa (Termius, Tabby, WindTerm, MobaXterm); geliştirme ortamları (Coder, Codespaces); kurumsal SSH erişim yönetimi (Teleport).
- **Ödeme kararını etkileyebilecekler:** (1) AI'ın sunucuda ne yaptığının denetimi ve onayı, (2) ekipte kimin neye eriştiği (RBAC, SSO, MFA), (3) oturum kaydı/denetim dışa aktarma, (4) çoklu sunucu güvenli işlem, (5) self-hosted veri egemenliği.
- **İlk hedef profil:** **AI kodlama/operasyon araçlarını (Claude Code, Cursor, ChatGPT) kendi sunucularında kullanan bireysel geliştiriciler ve küçük DevOps ekipleri** (1–20 sunucu). İkinci halka: **MSP'ler** (çok müşteri organizasyonu, denetim, onay) — ama SSO/SR/ajansız SSH gerektirdiği için ikinci aşama. Sistem yöneticisi pazarı Termius/MobaXterm/Royal TS ile doymuş; oraya protokol yarışıyla girilmez.
- **Self-hosted avantajı:** Veri egemenliği/KVKK-GDPR hassasiyeti olan şirketler, kamu ve sağlık tedarikçileri, AI'ın vendor bulutundan geçmesine izin vermeyen ekipler, hava boşluklu (air-gapped) iç ağlar.
- **Ücretsiz kalmalı (varsayım):** Self-hosted çekirdek tamamı; ajan, MCP, onay, izin listesi, web terminali, dosya yöneticisi, gruplar, MFA (güvenlik asla ücretli olmamalı), kişisel kullanım.
- **Ekip / kurumsal pakete (varsayım):** SSO (OIDC/SAML), oturum kaydı ve tekrar oynatma, denetim dışa aktarma, fleet işlemlerinin büyük ölçekli sürümü, grup bazlı politika, ajan-aracılı SSH hedef sayısı, barındırılan (managed) gateway, öncelikli destek.
- **Termius'a rakip olmak mantıklı mı:** Protokol/istemci ekseninde **hayır** (kaynak ve olgunluk farkı yıllar; ücretsiz katmanları bizim ücretli hâle getirebileceğimiz her şeyi veriyor). "AI'ın sunucuya güvenli erişimi" ekseninde **evet** — bu eksende Termius henüz deneysel (Gloria önizleme) ve mimari olarak bulut merkezli.

---

## 8. Farklılaşma ve ürün konumlandırması

**Konum cümlesi (öneri):** *"WECOMMANDER, Claude, ChatGPT ve Cursor gibi AI araçlarının ve ekibinizin sunucularınızda aynı kurallarla çalıştığı self-hosted kontrol merkezidir: gelen port açmaz, her riskli adımı onaya bağlar, her şeyi kayda alır ve geri alınabilir kılar."*

| Eksen | Termius | WECOMMANDER hedefi |
|---|---|---|
| Kim çalışır | İnsan (+ önizlemede vendor AI) | İnsan + kullanıcının kendi AI istemcisi, aynı oturumda (SH) |
| Yetki nerede uygulanır | SSH kullanıcısı | Ajan politikası (komut, yol, güven seviyesi, onay) |
| Ağ | SSH portu açık olmalı | Giden bağlantı, gelen port yok |
| Veri | Vendor bulutu (şifreli kasa) | Self-hosted gateway |
| Hata sonrası | — | Geri alma (dosya → change set) |
| Ölçek | Host listesi | Gruplar + güvenli fleet işlemleri |

**Konumlandırma riskleri:** "SSH istemcisi" diye pazarlanırsak karşılaştırmayı kaybederiz. Landing ve `/alternatives` sayfası (PR #95) bu eksende kalmalı; WT eklendiğinde "Termius'un yerine" değil "SSH istemcinize gerek kalmadan günlük işlerinizi de panelden yapın" dili kullanılmalı.

---

## 9. Güvenlik ve mimari kararlar

### 9.1 Korunacak ilkeler (görevdeki ilkelerin uygulanışı)

| İlke | Bu rapordaki uygulanışı |
|---|---|
| Rust ajanı korunur | Tüm yeni yetenekler (SSH dahil) ajanda; gateway yürütücü olmaz |
| MCP korunur | Her yeni yetenek önce MCP aracı + politika, sonra UI |
| Agentless SSH ikinci model | Yalnız ajan-aracılı (bastion) model; ajan modelinin yerini almaz |
| Self-hosted | Yeni harici servis yok; Web Push (VAPID) ve OIDC standart, self-hosted çalışır |
| Ücretli servis bağımlılığı yok | xterm.js (MIT), `russh` (Apache-2.0); mağaza/imza zorunluluğu getiren yerel mobil uygulama reddedildi |
| BYO AI | Kendi AI tamamlama modelimiz reddedildi; AI daima kullanıcının MCP istemcisi |
| Gateway/PostgreSQL/WebSocket yeniden kullanımı | WT akışı mevcut ajan WebSocket'i üzerinden; yeni tablolar mevcut migration sistemiyle |
| Bağlantı tipine göre zayıflatma yok | SSH hedefleri aynı izin listesi/onay/maskeleme/denetim hattından geçer |
| Riskli komutlarda açık onay | İnsan terminali: oturum açma onayı + MFA; AI: komut bazlı onay aynen |
| Sırlar loglanmaz | `redact.rs` kapsamına SSH anahtar biçimleri, `-----BEGIN ... PRIVATE KEY-----`, TOTP sırları; WT girişleri denetimde *komut satırı olarak değil olay olarak* kaydedilir (parola istemine yazılanlar loglanmaz) |
| Geriye dönük uyumluluk | Yeni MCP araçları ek; mevcut araç sözleşmeleri (`MCP_TOOL_CONTRACT_MATRIX`) değişmez |
| Kanıtlanmış bağımlılık | Her yeni paket için gerekçe yol haritasında |

### 9.2 İnsan terminali (WT) güvenlik modeli

- Terminal açma: rol ≥ operator, **MFA step-up (son 10 dk)**, cihazın güven seviyesi ≠ `strict` veya `strict`'te sahibin onayı.
- Gateway kısa ömürlü (ör. 60 sn), tek kullanımlık **terminal bileti** üretir; WebSocket bu biletle açılır.
- Oturum süresi en fazla 8 saat (V1_2 planıyla uyumlu), boşta kalma zaman aşımı.
- Denetim: oturum başlangıç/bitiş, açan kullanıcı, cihaz, boyut; SR etkinse içerik kaydı.
- AI ve insan oturumları farklı `scope` ile ayrılır; AI, insan oturumuna yalnız SH kuralları ile erişir.

### 9.3 SSH Vault — private key saklama modelleri

| Model | Güvenlik | Kullanılabilirlik | Self-hosted / maliyet | Uygun mu |
|---|---|---|---|---|
| **Local-only** (anahtar yalnız bastion ajanın cihazında, OS keystore) | Yüksek; gateway ele geçse bile anahtar yok | Cihaz kaybında anahtar yeniden üretilir/dağıtılır; ekip paylaşımı yok | Sıfır maliyet | **Birincil** |
| **Client-side encrypted sync** (tarayıcı/masaüstünde şifreleme, gateway yalnız şifreli blob) | Yüksek (doğru uygulanırsa); Termius modeli | Çok cihaz ve ekip paylaşımı; kurtarma zor | Kripto kodu ve bağımsız denetim maliyeti | **İkincil**, ekip ihtiyacı kanıtlanınca |
| **Gateway üzerinde şifreli saklama** (sunucu anahtarıyla) | Düşük–orta: gateway (ve yedekleri) ele geçerse tüm anahtarlar; çözme anahtarı aynı sistemde | Kolay | Kolay | **Reddedildi** |
| **Harici secret manager** (Vault, Infisical, 1Password, AWS/Azure KMS) | Yüksek; kurumsal standart | Kurulum yükü | Bazıları ücretli; çekirdeğe zorunlu olamaz | **Kurumsal eklenti** (opsiyonel arka uç) |
| **Hardware-backed** (FIDO2 `sk-*` anahtarları, TPM, Secure Enclave) | En yüksek; anahtar dışa aktarılamaz | Donanım gerekir; sunucuda OpenSSH ≥ 8.2 | Kullanıcı donanımı | **Birincil ile birlikte desteklenen tercih** |

**Öneri:** *Local-only + hardware-backed* birincil mimaridir. Gerekçe: (1) WECOMMANDER'ın ajan modeli zaten "anahtar gateway'e gelmez" ilkesine dayanır; (2) Termius'un istemci tarafı şifreli kasasının güvenlik çıtasını, kripto kodu yazmadan karşılar; (3) self-hosted gateway'in hedef değerini artırmaz; (4) ücretsiz çekirdekte ek servis gerektirmez. Ekip paylaşımı ihtiyacı ölçülürse ikinci aşamada *client-side encrypted sync* (WebCrypto, kullanıcı başına anahtar çifti, kasa anahtarının üye açık anahtarlarıyla sarılması) bağımsız kriptografi incelemesinden geçtikten sonra eklenir. En iyi uzun vadeli seçenek ise anahtar yerine **kısa ömürlü SSH sertifikaları** (gateway'de değil, ayrı bir CA anahtarıyla ve tercihen donanımda) olabilir; bu Teleport'un modelidir ve SSH adaptörü olgunlaşınca araştırılmalıdır.

### 9.4 Diğer güvenlik ön koşulları

- **MF (MFA) WT'den önce veya aynı sürümde yayınlanmalı.**
- **A4 (canlı TLS doğrulaması) ve yedek geri yükleme tatbikatı** yeni yüzey açılmadan kapanmalı.
- CSP: WT ile birlikte `script-src 'self'` sıkılaştırması ve xterm.js'in `allowProposedApi=false` ile kullanımı.

---

## 10. Ağırlıklı önceliklendirme tablosu

Formül: **Toplam = 0,30·İhtiyaç + 0,25·Uyum + 0,20·Kolaylık + 0,15·Ticari + 0,10·Farklılaşma** (1–5).

| Kod | Özellik | İht. | Uyum | Kol. | Tic. | Fark. | **Toplam** | Risk notu | Liste |
|---|---|---|---|---|---|---|---|---|---|
| WT | Etkileşimli web terminali + sekmeler | 5 | 5 | 4 | 4 | 3 | **4,45** | MFA şart | **A** |
| SH | İnsan–AI paylaşımlı terminal oturumu | 4 | 5 | 3 | 4 | 5 | **4,15** | WT'ye bağlı | **A** |
| DX-2 | Teşhis paketi | 4 | 5 | 4 | 3 | 4 | **4,10** | Salt-okunur | **A** |
| GR | Cihaz grupları, etiketler, workspace | 4 | 5 | 4 | 4 | 2 | **4,05** | Düşük | **A** |
| DX-1 | Servis keşfi | 4 | 5 | 4 | 3 | 3 | **4,00** | Salt-okunur | **A** |
| PW | PWA onay gelen kutusu + Web Push | 4 | 5 | 4 | 3 | 3 | **4,00** | Step-up | **A** |
| FM | Ajan dosya yöneticisi (P0 SFTP yerine) | 4 | 5 | 4 | 3 | 2 | **3,90** | Kota | **A** |
| FO | Fleet işlemleri (önizleme, canary, toplu onay) | 4 | 4 | 3 | 4 | 4 | **3,80** | GR'ye bağlı | **A** |
| PV | Değişiklik öncesi doğrulama (AD1-15) | 4 | 4 | 3 | 4 | 4 | **3,80** | Düşük | **A** |
| MF | MFA (TOTP + WebAuthn) + step-up | 4 | 4 | 3 | 4 | 2 | **3,60** | Güvenlik ön koşulu — puandan bağımsız zorunlu | **A** |
| RB | Change set geri alma (AD1-14) | 4 | 4 | 3 | 3 | 4 | **3,65** | PV'ye bağlı | **B** |
| SR | Oturum kaydı + tekrar oynatma | 3 | 4 | 3 | 4 | 3 | **3,40** | Depolama, gizlilik | **B** |
| AE | Denetim dışa aktarma | 3 | 5 | 4 | 3 | 1 | **3,50** | Düşük | **B** |
| SN | Onaylı runbook / snippets | 3 | 4 | 4 | 3 | 2 | **3,35** | Sır saklama | **B** |
| TP | Kalıcı ve zamanlanmış görevler | 3 | 4 | 3 | 3 | 3 | **3,25** | Onay modeli | **B** |
| SSO | OIDC SSO | 3 | 4 | 3 | 4 | 1 | **3,20** | Düşük | **B** |
| SSH | Ajan-aracılı (bastion) SSH, P0 Agentless | 4 | 3 | 2 | 4 | 2 | **3,15** | Yüksek: host key, yanal hareket | **B** |
| VLT | SSH kasası (local + hardware) | 3 | 3 | 2 | 4 | 2 | **2,85** | Yüksek; SSH'ye bağlı | **B** |
| DSK | Masaüstü deneyimi (WT'yi merkezde aç; macOS menü çubuğu) | 3 | 3 | 2 | 3 | 2 | **2,70** | Paketleme | **B** |
| SPL | Split view | 3 | 5 | 4 | 2 | 1 | **3,35** | Düşük — WT ikinci dilimi | **B** |
| MOB | Yerel iOS/Android | 3 | 3 | 1 | 3 | 2 | **2,50** | Ücretli mağaza/imza; bakım | **C** |
| PF | Port forwarding / SOCKS | 3 | 2 | 2 | 3 | 2 | **2,45** | **Kabul edilemez risk** | **C** |
| MP | Çok yazarlı Multiplayer | 2 | 3 | 2 | 3 | 2 | **2,40** | SH ile değiştirildi | **C** |
| IDE | VS Code/Cursor/JetBrains uzak bağlantı | 3 | 2 | 2 | 3 | 2 | **2,45** | Tünel riski; pazar çözmüş | **C** |
| DEV | Tek tıkla dev ortamı / repo kurulumu / Dev Containers | 3 | 2 | 2 | 3 | 2 | **2,45** | Ürün sınırı (DevAgent/Starter Pack) | **C** |
| DBG | Uzak debugging | 2 | 2 | 2 | 2 | 2 | **2,00** | IDE alanı | **C** |
| AIC | Kendi AI komut tamamlama | 2 | 2 | 3 | 2 | 1 | **2,10** | BYO-AI ilkesine aykırı | **C** |
| PROT | Mosh / Telnet / Serial | 2 | 2 | 2 | 2 | 1 | **1,90** | Niş; pazar çözmüş | **C** |

Not: MF puanı A eşiğinin üstünde olmasa da (3,60) WT ve SH için **zorunlu güvenlik ön koşulu** olduğundan A listesindedir. Split view (3,35) WT'nin genişletmesi olduğundan B'de ikinci dilim olarak tutuldu. RB (3,65) MF'den yüksek puanlı olsa da PV'ye bağımlı olduğu için B'dedir; puan eşiği tek başına sıralamayı belirlemez, bağımlılık ve risk notu da hesaba katılır.

**A. Kesinlikle geliştirilmesi önerilenler:** WT, MF, GR, FM, DX-1, DX-2, SH, PW, FO, PV
**B. Sonraki aşamalar:** SPL, RB, AE, SR, SN, TP, SSO, SSH (ajan-aracılı), VLT, DSK
**C. Önerilmeyenler:** MOB (yerel), PF, MP (çok yazarlı), IDE, DEV, DBG, AIC, PROT

---

## 11. Aşamalara bölünmüş geliştirme yol haritası

Ayrıntılı iş paketleri (kod, bileşen, bağımlılık, efor, risk, test, kabul, öncelik) [`WECOMMANDER_TERMIUS_DEVELOPMENT_ROADMAP.md`](./WECOMMANDER_TERMIUS_DEVELOPMENT_ROADMAP.md) dosyasındadır. Özet:

| Aşama | İçerik | Bağımsız yayınlanabilir mi | Tahmini efor |
|---|---|---|---|
| **F0 — Zemin** | A4 TLS, restore tatbikatı, `health_snapshot` gürültü düzeltmeleri, PR #29 | Evet | 1,5–2,5 MH |
| **F1 — Güvenli insan erişimi** | MF (TOTP + WebAuthn, step-up) → WT (xterm.js, sekmeler, bilet) | Evet (MF tek başına da) | 6–8 MH |
| **F2 — Düzen** | GR (gruplar/etiketler/workspace) + FM (dosya yöneticisi) + PW (PWA onay kutusu) | Her biri ayrı | 7–11 MH |
| **F3 — AI farklılaşması** | DX-1, DX-2, SH | Her biri ayrı (SH, F1'e bağlı) | 6,5–9 MH |
| **F4 — Güvenli değişiklik** | PV, FO, RB | PV bağımsız; FO GR'ye; RB PV'ye bağlı | 7–10 MH |
| **F5 — Kurumsal** | SR, AE, SSO, SN, TP, SPL, DSK | Her biri ayrı | 14–21 MH |
| **F6 — İkinci bağlantı modeli** | SSH (bastion ajan) + VLT (local + hardware) + FM'ye SFTP arka ucu | F1 ve F2 sonrası | 13–18 MH |

---

## 12. Test ve kabul kriterleri

Genel kurallar (her iş paketi için):

1. **Kanıt sınıfı [1] olmadan "tamamlandı" denmez:** birim + entegrasyon testi + CI işi yeşil.
2. **Gerçek cihaz kabulü** (Windows + Ubuntu zorunlu, macOS mümkünse) olmadan [2]'de kalır; `docs/*_DEVICE_ACCEPTANCE.md` biçiminde kanıt.
3. **Negatif güvenlik testleri:** yetkisiz rol, süresi geçmiş bilet, MFA'sız step-up, başka organizasyonun cihazı, kapsam dışı yol, sır sızıntısı (log/çıktı/denetimde `PRIVATE KEY`, TOTP sırrı, parola istemi girişi aranır).
4. **Geriye dönük uyumluluk:** mevcut MCP istemci kabulü (`gateway/test/mcp-client-acceptance.mjs`) ve araç sözleşme matrisi değişmeden geçer.
5. **Performans:** WT için tuş→yankı gecikmesi aynı bölgede p95 < 150 ms; FM için 100 MB dosya aktarımı relay'i diğer oturumlar için engellemez.
6. **Production'a geçiş yalnız `promote-production.yml` ile.**

Paket bazlı test senaryoları ve kabul kriterleri yol haritası dosyasındadır.

---

## 13. Riskler ve teknik borç

### 13.1 Ürün riskleri

| Risk | Olasılık | Etki | Azaltma |
|---|---|---|---|
| "SSH istemcisi" algısına kayıp Termius ile protokol yarışına girmek | Orta | Yüksek | §8 konumlandırma; PROT ve PF C listesinde |
| WT'nin web üzerinden tam kabuk açması nedeniyle oturum hırsızlığı | Orta | Çok yüksek | MF + step-up + bilet + kısa oturum + denetim |
| SSH adaptörünün yanal hareket aracına dönüşmesi | Düşük–orta | Çok yüksek | Bastion modeli, hedef allowlist, host key sabitleme, onay |
| Kasa kriptografisinde hata | Düşük (local-only seçilirse) | Çok yüksek | Kripto kodu yazmayan birincil model; sync için bağımsız inceleme |
| Relay kapasitesinin WT/FM trafiğiyle dolması | Orta | Orta | Oturum/hız kotası, `relay-cluster` bölgesel dağılım, metrikler |
| Ekip (tek geliştirici + AI) kapasitesine göre aşırı kapsam | Yüksek | Yüksek | Aşamalar bağımsız; F1–F3 dışındakiler talep kanıtına bağlı |

### 13.2 Mevcut teknik borç (yeni işlerden önce/ile birlikte)

- `task_manager.rs` bellek içi görevler (TP).
- `health_snapshot` Ubuntu gürültüsü (F0).
- Draft PR #29 (Windows ConPTY testi) ve PR #25 (1C/1D kabul kapıları) açık.
- macOS gerçek cihaz kabulü, kaldırma betiklerinin CI kabulü, restore tatbikatı.
- Web UI'da etkileşimli terminal yokluğu nedeniyle terminal API'lerinin insan kullanımına dair hiç UI testi yok.

### 13.3 Mevcut master plan ile çelişen / plana işlenmemiş noktalar

Bu maddeler **plan dosyalarına işlenmemiştir**; sahibinin kararına sunulur.

1. **AD1-09 SSH/SFTP adaptörü** (`ADVANCED_DEVELOPMENT_PLAN_1.md`, "Orta" öncelik) — bu rapor modeli **ajan-aracılı (bastion)** ile sınırlar ve gateway'den doğrudan SSH'yi reddeder; ayrıca önceliği F6'ya (WT, MF, GR, FM sonrası) erteler. Plan "mevcut outbound Agent ilk tercih" diyerek uyumlu, ama gateway-SSH seçeneğini açıkça dışlamıyor.
2. **V1_2 "İnsan terminali" planı** (PR #93, "8 saatlik oturumda bir kez kimlik doğrulama") — bu rapor buna **MFA step-up ve tek kullanımlık terminal bileti** ön koşulunu ekler; plan MFA'yı ön koşul olarak tanımlamıyor.
3. **V1_2 konumlandırma cümlesi** ("SSH portu ve VPN gerekmez") — ajan-aracılı SSH bu iddiayı korur; gateway-SSH veya port forwarding bozardı. Bu nedenle PF reddedildi.
4. **AD1-15 (Safe Execution) ve AD1-14 (Rollback)** — planda var; bu rapor PV'yi F4'e, RB'yi PV sonrasına koyar ve PV'yi A listesine yükseltir. Plan sıralamasında değişiklik önerisidir.
5. **Ürün sınırları** — DevAgent, Autonomos, WebRising Starter Pack sorumlulukları depoda tanımlı değil; §6.3'teki varsayım resmî bir sınır belgesiyle doğrulanmalı.
6. **Fiyatlandırma** — Gateway'de planlar veritabanından yönetiliyor (`billing.ts`, `billing_plans`); §7.1'deki "ücretsiz / ekip" ayrımı mevcut Paddle planlarını değiştirme önerisidir ve **varsayımdır**.

---

## 14. Nihai ürün önerisi

1. **Termius'un kopyası olma; Termius'un yapmadığını yap.** WECOMMANDER'ın savunulabilir değeri: giden bağlantılı ajan, MCP ile kullanıcının kendi AI istemcisi, komut düzeyinde politika/onay, denetim ve geri alma, self-hosted.
2. **Günlük terminal deneyimi açığını hemen kapat** (F1–F2): MFA ile korunan etkileşimli web terminali, gruplar ve ajan tabanlı dosya yöneticisi. Bu üçü, kullanıcıların "sunucuya bakmak için" başka araca gitmesini büyük ölçüde bitirir ve ek protokol yükü getirmez.
3. **Farklılaşmayı inşa et** (F3–F4): insan–AI paylaşımlı oturum, servis keşfi ve teşhis, güvenli fleet işlemleri, değişiklik öncesi doğrulama ve change set geri alma. Bu eksende pazarda olgun bir rakip bulunamadı (Teleport en yakın, ama farklı odak).
4. **Kurumsal katmanı talep kanıtıyla aç** (F5): SSO, oturum kaydı, denetim dışa aktarma — ekip/kurumsal pakete.
5. **Ajansız SSH'yi ikinci bağlantı modeli olarak, en son ve en güvenli biçimde ekle** (F6): bastion ajan, local/hardware anahtar, aynı politika hattı.
6. **Yapma:** port forwarding/SOCKS, çok yazarlı multiplayer, yerel mobil uygulamalar, IDE/dev ortamı/debug özellikleri, kendi AI tamamlama modelimiz, Mosh/Telnet/Serial.
7. **İlk hedef kitle:** AI araçlarını kendi sunucularında kullanan geliştiriciler ve küçük DevOps ekipleri; MSP'ler F5 sonrası.

---

## Kaynaklar

Erişim tarihi: 2026-11-07. R\* = resmî URL, yalnız arama özeti görüldü (oturum ağı termius.com / docs.termius.com'u engelledi).

**Termius**
- Fiyatlandırma: https://termius.com/pricing (R\*)
- Faturalama ve planlar: https://docs.termius.com/administration/billing-and-plans (R\*)
- Şifreleme: https://termius.com/documentation/encryption , https://docs.termius.com/security/encryption-overview , https://termius.com/vault (R\*)
- Bağlantı ve protokoller: https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server (R\*)
- Port forwarding: https://docs.termius.com/organize-and-connect-to-hosts/port-forwarding-and-tunneling (R\*)
- Jump hosts: https://termius.com/documentation/jump-hosts (R\*)
- Gloria (2025-08-20): https://termius.com/blog/devops-ai-agent-gloria (R\*)
- Auto-reconnect (2023-08-31) ve Multiplayer (2025-10-29) blog listesi: https://termius.com/blog/stay-connected-with-auto-reconnect (R\*)
- App Store kayıtları: https://apps.apple.com/app/id549039908 , https://apps.apple.com/app/id1176074088 (R)
- Üçüncü taraf: https://makerstack.co/reviews/termius-review/ , https://termai.sh/blog/termius-free-vs-paid (çıkar çatışması: rakip ürün sahibi), https://www.softpedia.com/progChangelog/Termius-Changelog-265341.html (Ü)

**Diğer rakipler**
- Tabby: https://github.com/Eugeny/tabby (R)
- WindTerm: https://github.com/kingToolbox/WindTerm (R)
- Royal TS: https://royalapps.com/ts/buy , https://blog.royalapps.com/blog/royalapps-license-fees (R)
- MobaXterm: https://www.softwareadvice.com.au/software/115290/mobaxterm , https://www.trustradius.com/products/mobaxterm/pricing (Ü — fiyat modeli çelişkili)
- SecureCRT: https://www.g2.com/products/securecrt/pricing (Ü — fiyat yayımlanmıyor)
- Teleport: https://goteleport.com/blog/teleport-community-license , https://goteleport.com/blog/march-newsletter-2024/ (R)
- Coder: https://coder.com/pricing (R)
