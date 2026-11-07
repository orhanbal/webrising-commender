# WECOMMANDER V2 — Sürüm ve Kabul Kriterleri

- **Tarih:** 2026-11-07
- **Kaynaklar:** [`WECOMMANDER_V2_MASTER_PLAN.md`](./WECOMMANDER_V2_MASTER_PLAN.md) · [`WECOMMANDER_V2_DEVELOPMENT_CALENDAR.md`](./WECOMMANDER_V2_DEVELOPMENT_CALENDAR.md)
- Tarihler temel senaryo **S2** içindir: önce plan tarihi, parantez içinde %15 tampon dahil hedef sürüm tarihi. S1 ve S4 tarihleri takvim belgesindedir.

## 1. Kavramlar

| Kavram | Tanım | Kimler kullanır | Neyi garanti etmez |
|---|---|---|---|
| **Prototip** | Uçtan uca bir akışın çalıştığını gösteren dahili derleme | Geliştirici ve sahip | Kararlılık, kurulum, veri biçimi |
| **MVP** | Günlük SSH işinin tamamının yapılabildiği ilk kullanılabilir sürüm (bağlan, host yönet, terminal, SFTP, jump host, local forward, güvenli kasa). Termius'un tüm özelliklerini içermez. | Davetli erken kullanıcılar | Özellik eşitliği, senkronizasyon, ekip |
| **Beta** | Üç işletim sisteminde genel kullanıma açık, otomatik güncellemeli, Termius'un günlük kullanılan özelliklerinin çoğunu içeren sürüm. Veri biçimi geriye dönük uyumludur; kırıcı değişiklik yalnız göç (migration) aracıyla yapılabilir. | Herkes ("beta" etiketiyle) | Ekip özellikleri, dış güvenlik incelemesi |
| **Release Candidate** | Özellik dondurulmuş, eşitlik kapsamı tamamlanmış, dış güvenlik incelemesi kapanmış sürüm | Herkes | Uzun süreli kararlılık kanıtı |
| **Stable** | Destek sözü verilen sürüm: kırıcı değişiklik yok, güvenlik güncellemeleri zamanında, bilinen kritik/yüksek hata yok | Herkes, ekipler, ücretli paketler | — |

## 2. Tüm sürümler için ortak kapılar

1. **CI:** Tüm işler yeşil, yeni işler dahil (`desktop`, `wc-ssh-core` SSH sunucu konteyneri, `cargo-deny`, `cargo audit`).
2. **Regresyon:** B07 kontrol listesi doldurulmuş; Agent Mode mevcut testleri (`agent-e2e`, `rbac-matrix-e2e`, `mcp-client-acceptance`, `local-stdio-e2e`, `relay-e2e`) değişmeden geçer.
3. **Güvenlik negatifleri:** Sır taraması (log, kasa dosyası, çökme dökümü ve denetim kaydında `PRIVATE KEY`, parola, token yok); AI'ın tünel, agent forwarding, kasa ve SFTP yazma girişimlerinin reddi (A24 sonrası).
4. **Gerçek cihaz kabulü:** Aşağıdaki platform matrisi; her biri için `docs/` altında tarihli kanıt.
5. **Agent Mode yayını:** Yalnız `promote-production.yml` ve sahibin `production` onayı. Masaüstü yayını: imzalı güncelleme manifesti ve `SHA256SUMS`.
6. **Geri alma planı:** Agent Mode için önceki production SHA'sına promote; masaüstü için önceki sürüme güncelleme kanalı ve veri biçimi uyumluluğu.

### Platform kabul matrisi

| Platform | M1 | M2 | M3 | M5 | M6 |
|---|---|---|---|---|---|
| Windows 11 (x64) | Derleme | Gerçek cihaz | Gerçek cihaz + temiz kurulum + güncelleme | Gerçek cihaz | Gerçek cihaz + 2 hafta günlük kullanım |
| macOS (Apple Silicon) | Derleme | Gerçek cihaz | Gerçek cihaz (imza kararına göre Gatekeeper akışı belgelenir) | Gerçek cihaz | Gerçek cihaz + 2 hafta |
| Ubuntu 24.04 masaüstü | Derleme | Gerçek cihaz veya VM | Gerçek cihaz, .deb + AppImage | Gerçek cihaz | Gerçek cihaz + 2 hafta |
| SSH hedefleri | Konteyner | Ubuntu sunucu + Windows OpenSSH | + macOS sshd, eski OpenSSH (7.x) | + FIDO2 ile | Hepsi |

## 3. Kilometre taşları

### M0 — Agent Mode güvenlik ve production kapanışı · 2026-12-25 (2027-01-08)
- **Kapsam:** B01, B02, B03.
- **Tamamlanma koşulları:** AI `terminal_input` boşluğu kapandı ve ajan tarafında zorunlu; onay iadesi ve açık hata metni; `health_snapshot` gürültüsü giderildi; A4 TLS raporu; production verisiyle restore raporu; GitHub sıkılaştırması; PR #29/#25 kararları; WinUI Urgent bildirimi doğrulandı.
- **Yayın kriterleri:** Production promote; `v1.0` etiketi; `PHASE_STATUS.md`'deki dış kabul listesi kanıtlı.

### M1 — Çalışan User Mode SSH prototipi · 2027-02-19 (2027-03-12)
- **Kapsam:** A01, A02, A03.
- **Tamamlanma koşulları:** Desktop uygulaması üç işletim sisteminde derlenir; parola veya anahtarla bir sunucuya bağlanılır; xterm.js'de `vim` ve `htop` çalışır; host key uyuşmazlığında bağlantı reddedilir.
- **Yayın kriterleri:** Dahili derleme; dağıtım yok; veri biçimi garantisi yok.

### M2 — User Mode kullanılabilir MVP · 2027-07-09 (2027-08-20)
- **Kapsam:** A04–A11.
- **Tamamlanma koşulları:**
  - Kasa: OS anahtar deposu veya ana parola; düz metne düşme yok; anahtar üretme ve içe aktarma.
  - Host key: ilk bağlantıda onay, değişimde kesin red, `known_hosts` içe aktarma.
  - Hosts, gruplar, etiketler; ssh_config içe ve dışa aktarma (ProxyCommand alınmaz).
  - Çoklu sekme, yerel kabuk sekmesi.
  - SFTP: 1 GB aktarım, kesinti sonrası devam.
  - Jump host zinciri; local forward (varsayılan loopback).
  - Kurulum, kaldırma ve imzalı otomatik güncelleme.
- **Yayın kriterleri:** A11 iç güvenlik incelemesi kapalı (kritik/yüksek bulgu yok); 3 işletim sisteminde kabul belgesi; bilinen sınırlamalar listesi yayımlanmış; davetli erken erişim kanalı. **Termius eşitliği bu sürümün şartı değildir.**

### M3 — Windows / Linux / macOS Beta · 2027-11-19 (2028-01-21)
- **Kapsam:** A12–A16, A19 (+ Agent Mode tarafında B05–B07, B12 bu tarihe kadar yayımlanmış olur).
- **Tamamlanma koşulları:** Split view ve önizlemeli broadcast; workspaces ve oturum geri yükleme; snippets, geçmiş, autocomplete; remote forward, SOCKS, proxy; imza onaylı agent forwarding; SSH sertifikaları; tema, font, kısayollar.
- **Yayın kriterleri:**
  - 3 işletim sisteminde temiz kurulum ve sürüm N → N+1 güncelleme kanıtı.
  - Linux WebKitGTK performans ölçümü kabul eşiğinde (10 MB akışta arayüz donmaz).
  - Veri biçimi uyumluluğu: MVP kasası göç aracıyla açılır.
  - Beta stabilizasyonunda (3 hafta) yeni özellik eklenmedi; açık kritik hata yok.
  - macOS dağıtım yöntemi (imzalı veya belgelenmiş imzasız akış) karara bağlanmış.

### M4 — Agent Mode entegrasyonu · 2028-01-21 (2028-03-31)
- **Kapsam:** B08, B09, A23.
- **Tamamlanma koşulları:** Desktop'tan Agent Mode'a oturum açma (MFA yeniden doğrulamalı); Agent sekmesinde onaylar, otonom mod, bildirimler, insan terminali; açık SSH oturumundan "Agent kur" ile Ubuntu, Debian ve macOS hedeflerine kurulum; yükseltilen sunucunun MCP'den görünmesi.
- **Yayın kriterleri:** Mevcut cihaz kimlikleri ve MCP sözleşmeleri değişmedi (sözleşme matrisi testi); WinUI Yönetim Merkezi ile özellik eşdeğerliği kontrol listesi; Windows'ta Urgent bildirim senaryosu Desktop'ta da geçer.

### M5 — Termius özellik eşitliği · 2028-07-21 (2028-10-27)
- **Kapsam:** A17, A18, A20, A21, A22, B10.
- **Tamamlanma koşulları:** FIDO2 (en az OpenSSH uyumluluk motoruyla, 3 işletim sisteminde gerçek anahtarla); SCP; uçtan uca şifreli kişisel senkronizasyon (self-hosted Gateway ve Cloud); ekip kasası, paylaşılan hostlar, ekip çalışma alanları, RBAC, ekip denetim olayları.
- **Yayın kriterleri:** **A21 dış güvenlik incelemesinde kritik/yüksek bulgu kalmadı**; sunucu veritabanı dökümünde host adı/IP düz metin olarak bulunmuyor (otomatik tarama); üye çıkarma sonrası eski anahtarla erişilemiyor; RC etiketi.
- **Eşitlik kontrol listesi:** SSH, SFTP, SCP, jump host, local/remote/dynamic forward, proxy, agent forwarding, sertifikalar, FIDO2, çoklu sekme, split view, workspaces, snippets, autocomplete, broadcast, tema/kısayol, hosts/groups/tags, ssh_config içe aktarma, kasa, senkronizasyon, ekip paylaşımı. Mobil ve Multiplayer bu listenin dışındadır (M7).

### M6 — WECOMMANDER V2 Stable · 2028-08-18 (2028-11-24)
- **Kapsam:** A24, A25, A26 ve M0–M5'in tamamı; Agent Mode B04–B07, B12 yayımlanmış.
- **Tamamlanma koşulları:** Kendi API anahtarıyla AI asistanı (öner modu varsayılan, maskelenmiş bağlam); komut risk değerlendirmesi broadcast, snippet ve AI önerilerinde; sunucular arası karşılaştırma.
- **Yayın kriterleri:**
  - 4 haftalık Stable stabilizasyonu; son 2 haftada 3 işletim sisteminde günlük kullanım ve kritik hata yok.
  - AI sağlayıcısı tanımlı değilken uygulama tam çalışıyor.
  - AI negatif testleri (tünel, agent forwarding, kasa, SFTP yazma) yeşil.
  - Güvenlik güncelleme süreci (`SECURITY.md`) masaüstünü kapsıyor.
  - Sürüm notları, kullanıcı belgeleri ve göç rehberi yayımlanmış.
  - Destek ve bakım kapasitesi ayrılmış (Master Plan §8).

### M7 — Mobil ve kurumsal genişleme · 2029-02-23 (2029-06-29)
- **Kapsam:** A27, A28, A29, A30, B11, B13.
- **Tamamlanma koşulları:** Multiplayer (tek yazar, uçtan uca şifreli relay); Android kapalı test ve iOS TestFlight; kurumsal politika zorlama; OIDC SSO; bastion SSH.
- **Yayın kriterleri:** Mobil cihazlarda gerçek kabul (en az bir Android ve bir iPhone); mağaza incelemeleri; SSO ile girişte kasanın ayrı parola istemesi; bastion için SSRF negatif testleri.

## 4. Değişiklik yönetimi

- Kapsam değişikliği yalnız kilometre taşı sınırında kabul edilir; Master Plan, Dependency Matrix ve Calendar birlikte güncellenir.
- Stabilizasyon dönemlerinde yalnız hata düzeltmesi yapılır.
- Bir kilometre taşı hedef tarihini 4 haftadan fazla aşarsa sahip kapsam daraltma veya kaynak artırma kararı verir; tarih sessizce kaydırılmaz.
