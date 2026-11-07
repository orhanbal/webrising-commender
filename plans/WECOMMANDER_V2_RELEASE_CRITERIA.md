# WECOMMANDER V2 — Sürüm ve Kabul Kriterleri

- **Sürüm:** v0.2 · **Tarih:** 2026-11-07
- **Kaynaklar:** [Master Plan](./WECOMMANDER_V2_MASTER_PLAN.md) (43 iş paketi) · [Takvim](./WECOMMANDER_V2_DEVELOPMENT_CALENDAR.md) · [Bağımlılık matrisi](./WECOMMANDER_V2_DEPENDENCY_MATRIX.md)
- Tarihler [`wecommander_v2_scheduler.py`](./tools/wecommander_v2_scheduler.py) ile varsayılan senaryo S2 için üretilir. Diğer senaryolar takvim belgesindedir. Tarihler doğrulanacak başlangıç tahminleridir; M1 sonrasında R1 revizyonuyla güncellenir.

## 1. Kavramlar

| Kavram | Tanım | Kimler kullanır | Neyi garanti etmez |
|---|---|---|---|
| **Prototip** | Uçtan uca bir akışın çalıştığını gösteren dahili derleme | Geliştirici ve sahip | Kararlılık, kurulum, veri biçimi |
| **MVP** | Günlük SSH işinin yapılabildiği ilk kullanılabilir sürüm (bağlan, host yönet, terminal, SFTP, jump host, local forward, güvenli kasa). Termius'un tüm özelliklerini içermez. | Davetli erken kullanıcılar | Özellik eşitliği, senkronizasyon, ekip |
| **Beta** | Üç işletim sisteminde genel kullanıma açık, otomatik güncellemeli, veri biçimi geriye dönük uyumlu sürüm | Herkes ("beta" etiketiyle) | Destek sözü, ekip özellikleri |
| **Release Candidate** | Özellik dondurulmuş, kapsamı tamam, yalnız hata düzeltmesi alan sürüm | Herkes | Uzun süreli kararlılık kanıtı |
| **Stable** | Destek sözü verilen sürüm: kırıcı değişiklik yok, güvenlik güncellemeleri zamanında, bilinen kritik/yüksek hata yok | Herkes, ekipler, ücretli paketler | — |

İki ayrı kararlı sürüm vardır:

- **User Mode 1.0 Stable (U1):** Temel SSH uygulaması. Kendi sürüm numarası (`desktop 1.0.x`) ve kendi bakım dalı vardır.
- **WECOMMANDER V2 Stable (M6):** User Mode + Agent Mode entegrasyonu, Termius eşitliği, senkronizasyon, ekip, AI ve farklılaştırıcılar (`desktop 2.0`, Agent Mode ile birlikte).

## 2. Sürüm tarihleri

<!-- GENERATED:BEGIN milestones-default -->
| Kilometre taşı | Plan tarihi (S2) | Hedef sürüm tarihi (S2, tampon dahil) | Kapsam |
|---|---|---|---|
| **M0** Agent Mode güvenlik ve production kapanışı | 2027-01-15 | 2027-01-29 | B01, B02, B03 |
| **M1** Çalışan User Mode SSH prototipi | 2027-03-12 | 2027-04-02 | A01, A02, A03 |
| **M2** User Mode kullanılabilir MVP | 2027-08-06 | 2027-09-17 | A04, A05, A06, A07, A08, A09, A10, A11 + S-MVP |
| **U1** User Mode 1.0 Stable | 2027-09-03 | 2027-10-22 | A19 + S-U1 |
| **M3** Genişletilmiş özellik Beta'sı (User Mode 1.x, 3 işletim sistemi) | 2028-01-14 | 2028-03-24 | A12, A13, A14, A15, A16 + S-BETA |
| **M4** Agent Mode entegrasyonu | 2028-03-17 | 2028-06-02 | B08, B09, A23 + S-INT |
| **M5** Termius masaüstü özellik eşitliği | 2028-09-15 | 2028-12-29 | A17, A18, A20, A21, A22, B10 + S-PAR |
| **M6** WECOMMANDER V2 Stable | 2028-10-13 | 2029-02-02 | A24, A25, A26, B04, B05, B06, B07, B12 + S-STABLE |
| **M7** Mobil ve kurumsal genişleme | 2029-04-20 | 2029-09-07 | A27, A28, A29, A30, B11, B13 + S-M7 |
<!-- GENERATED:END milestones-default -->

<!-- GENERATED:BEGIN releases -->
| Sürüm | Kilometre taşı | Plan (S2) | Hedef (S2) | Kanal |
|---|---|---|---|---|
| Agent Mode v1.0 | M0 | 2027-01-15 | 2027-01-29 | production (promote-production) |
| Desktop 0.1 prototip | M1 | 2027-03-12 | 2027-04-02 | dahili |
| Desktop 0.5 MVP | M2 | 2027-08-06 | 2027-09-17 | davetli erken erişim |
| **User Mode 1.0 Stable** | U1 | 2027-09-03 | 2027-10-22 | stable (Windows, macOS, Linux) |
| User Mode 1.x Beta | M3 | 2028-01-14 | 2028-03-24 | beta kanalı |
| Desktop 1.x + Agent Mode entegrasyonu | M4 | 2028-03-17 | 2028-06-02 | beta → stable |
| Termius eşitliği RC | M5 | 2028-09-15 | 2028-12-29 | sürüm adayı |
| **WECOMMANDER V2.0 Stable** | M6 | 2028-10-13 | 2029-02-02 | stable |
| V2.1 mobil ve kurumsal | M7 | 2029-04-20 | 2029-09-07 | stable + mobil test kanalları |
| Agent Mode v1.1 (MFA) | — | 2027-02-19 | 2027-03-12 | production |
| Agent Mode v1.2 (web terminali) | — | 2027-10-22 | 2027-12-17 | production |
| Agent Mode v1.3 (gözlem) | — | 2027-09-10 | 2027-10-29 | production |
<!-- GENERATED:END releases -->

## 3. Sürüm yönetimi

| Konu | User Mode 1.x | WECOMMANDER V2 |
|---|---|---|
| Sürüm numarası | `desktop-v1.0.0`, yamalar `1.0.x`, özellik sürümleri `1.1`, `1.2` … | `desktop-v2.0.0` + Agent Mode `v2.0` |
| Kanallar | `stable` (1.0.x), `beta` (1.x yeni özellikler) | `beta` → `rc` → `stable` |
| Bakım | 1.0.x için V2 Stable'dan sonra en az 6 ay güvenlik yaması | Sürekli |
| Veri biçimi | 1.0 kasası 2.0'da göç aracıyla açılır; geri dönüş için yedek alınır | — |
| Agent Mode bağımlılığı | Yok (hesapsız, gateway'siz) | Var (isteğe bağlı entegrasyon) |
| Etiketleme | `desktop-distribution.yml` iş akışı, imzalı güncelleme manifesti | Aynı + Agent Mode için `promote-production.yml` |

## 4. Tüm sürümler için ortak kapılar

1. **CI:** Bütün işler yeşil; buna `desktop`, `wc-ssh-core` SSH sunucu konteyneri, `cargo-deny`, `cargo audit` ve plan araç testleri dahildir.
2. **Regresyon:** B07 kontrol listesi doldurulmuş. Agent Mode'un mevcut testleri (`agent-e2e`, `rbac-matrix-e2e`, `mcp-client-acceptance`, `local-stdio-e2e`, `relay-e2e`) değişmeden geçer.
3. **Güvenlik negatifleri:**
   - Log, kasa dosyası, çökme dökümü ve denetim kaydında `PRIVATE KEY`, parola veya token bulunmaz.
   - A24'ten sonra AI'ın tünel, agent forwarding, kasa ve SFTP yazma girişimleri reddedilir.
   - B03'ten sonra 8 teslimat senaryosu yeşildir.
4. **Gerçek cihaz kabulü:** Platform matrisi (aşağıda); her platform için `docs/` altında tarihli kanıt.
5. **Yayın yolu:** Agent Mode yalnız `promote-production.yml` ve sahibin `production` onayıyla yayımlanır. Masaüstü için imzalı güncelleme manifesti ve `SHA256SUMS`.
6. **Geri alma planı:** Agent Mode için önceki production SHA'sına promote. Masaüstü için önceki sürüme güncelleme kanalı ve veri biçimi uyumluluğu.

### Platform kabul matrisi

| Platform | M1 | M2 | U1 | M3 / M5 | M6 |
|---|---|---|---|---|---|
| Windows 11 (x64) | Derleme | Gerçek cihaz | Temiz kurulum, güncelleme, 2 hafta günlük kullanım | Gerçek cihaz | Gerçek cihaz + 2 hafta |
| macOS (Apple Silicon) | Derleme | Gerçek cihaz | Temiz kurulum, güncelleme (imza kararına göre Gatekeeper akışı belgeli), 2 hafta | Gerçek cihaz | Gerçek cihaz + 2 hafta |
| Ubuntu 24.04 masaüstü | Derleme | Gerçek cihaz veya VM | .deb + AppImage, güncelleme, 2 hafta | Gerçek cihaz | Gerçek cihaz + 2 hafta |
| SSH hedefleri | Konteyner (G2 matrisi) | Ubuntu sunucu + Windows OpenSSH | + macOS sshd, OpenSSH 7.x | + FIDO2 (M5) | Hepsi |

## 5. Kilometre taşları

### M0 — Agent Mode güvenlik ve production kapanışı
- **Kapsam:** B01, B02, B03.
- **Tamamlanma koşulları:**
  - AI `terminal_input` boşluğu kapandı ve kontrol ajan tarafında zorunlu.
  - B03 durum makinesi çalışıyor: kalıcı işlem tablosu, ajan işlem günlüğü, uzlaştırma, ajan tarafında nonce tekrarı engeli; 8 teslimat senaryosunun testleri yeşil; kanıt yoksa otomatik iade yok.
  - A4 TLS raporu; production verisiyle restore raporu; GitHub sıkılaştırması.
  - PR #29 ve #25 için karar; WinUI Urgent bildirimi doğrulandı.
- **Yayın kriterleri:** Production promote; `v1.0` etiketi; `PHASE_STATUS.md` dış kabul listesi kanıtlı.

### M1 — Çalışan User Mode SSH prototipi
- **Kapsam:** A01, A02, A03.
- **Tamamlanma koşulları:**
  - Masaüstü uygulaması üç işletim sisteminde derlenir.
  - Parola veya anahtarla bir sunucuya bağlanılır; xterm.js'de `vim` ve `htop` çalışır; host key uyuşmazlığında bağlantı reddedilir.
  - G1, G2, G3 doğrulama raporları yazılmış ve gerçekleşen eforlar kayda geçmiş.
- **Yayın kriterleri:** Dahili derleme. **R1 takvim revizyonu PR'ı açılmadan M2 işleri planlanmış sayılmaz.**

### M2 — User Mode kullanılabilir MVP
- **Kapsam:** A04–A11.
- **Tamamlanma koşulları:**
  - Kasa: OS anahtar deposu veya ana parola; düz metne düşme yok.
  - Host key: ilk bağlantıda onay, değişimde red.
  - Hosts, Groups, Tags; ssh_config içe ve dışa aktarma.
  - Çoklu sekme; SFTP (1 GB, devam); jump host; local forward.
  - Kurulum, kaldırma ve imzalı otomatik güncelleme.
- **Yayın kriterleri:**
  - A11 iç güvenlik incelemesi kapalı (kritik/yüksek bulgu yok); 3 işletim sisteminde kabul belgesi.
  - Bilinen sınırlamalar listesi; davetli erken erişim.
  - **Termius eşitliği bu sürümün şartı değildir.**

### U1 — User Mode 1.0 Stable
- **Kapsam:** MVP (A04–A11) + A19 + S-U1 (4 hafta: genel beta → RC → 1.0).
- **Zorunlu özellikler:** Windows, Linux ve macOS kurulumu; SSH terminali; anahtar ve parola ile kimlik doğrulama; host key doğrulaması; yerel güvenli kasa; Hosts, Groups, Tags; çoklu terminal sekmeleri; SFTP; Jump Host; Local Port Forwarding; temel terminal ayarları (A19); otomatik güncelleme.
- **Zorunlu olmayanlar:** Ekip kasası, senkronizasyon, mobil, AI, split view, snippets, SOCKS, agent forwarding, FIDO2. Bunlar 1.x özellik sürümleriyle (M3, M5) gelir.
- **Tamamlanma koşulları:**
  - S-U1'in ilk 2 haftası genel beta, son 2 haftası RC; RC sırasında yalnız hata düzeltmesi.
  - Güvenlik negatifleri ve regresyon yeşil.
  - Üç işletim sisteminde temiz kurulum, güncelleme ve 2 hafta günlük kullanım kanıtı.
  - Kullanıcı belgeleri (A11) yayımlanmış.
- **Yayın kriterleri:**
  - Açık kritik veya yüksek hata yok.
  - Linux WebKitGTK performansı kabul eşiğinde. Değilse Linux sürümü "beta" etiketiyle çıkar; karar kayda geçer.
  - macOS dağıtım yöntemi karara bağlanmış.
  - 1.0.x bakım ve güvenlik yaması süreci (`SECURITY.md`) masaüstünü kapsıyor.
  - Veri biçimi sürümlenmiş ve göç testleri hazır.

### M3 — Genişletilmiş özellik Beta'sı (User Mode 1.x, 3 işletim sistemi)
- **Kapsam:** A12–A16.
- **Tamamlanma koşulları:** Split view ve önizlemeli broadcast; workspaces ve oturum geri yükleme; snippets, geçmiş, autocomplete; remote forward, SOCKS, proxy; imza onaylı agent forwarding; SSH sertifikaları.
- **Yayın kriterleri:**
  - Beta kanalında 3 işletim sistemi.
  - 1.0 kasası göç aracıyla açılıyor.
  - 3 haftalık stabilizasyonda yeni özellik yok; açık kritik hata yok.

### M4 — Agent Mode entegrasyonu
- **Kapsam:** B08, B09, A23.
- **Tamamlanma koşulları:**
  - Masaüstünden Agent Mode'a oturum açma (MFA yeniden doğrulamalı).
  - Agent sekmesinde onaylar, otonom mod, bildirimler, insan terminali.
  - Açık SSH oturumundan "Agent kur" ile Ubuntu, Debian ve macOS'a kurulum.
- **Yayın kriterleri:**
  - Mevcut cihaz kimlikleri ve MCP sözleşmeleri değişmedi.
  - WinUI Yönetim Merkezi ile eşdeğerlik kontrol listesi tamam.
  - Windows'ta Urgent bildirim senaryosu masaüstü uygulamasında da geçiyor.

### M5 — Termius masaüstü özellik eşitliği
- **Kapsam:** A17, A18, A20, A21, A22, B10.
- **Tamamlanma koşulları:** FIDO2 (3 işletim sisteminde gerçek anahtarla); SCP; uçtan uca şifreli kişisel senkronizasyon; ekip kasası, paylaşılan hostlar, ekip çalışma alanları, RBAC, ekip denetimi.
- **Yayın kriterleri:**
  - A21 dış incelemede kritik/yüksek bulgu kalmadı.
  - Sunucu veritabanı dökümünde host adı veya IP düz metin olarak yok.
  - Üye çıkarıldıktan sonra eski anahtarla erişilemiyor.
  - RC etiketi.
- **Eşitlik kontrol listesi:** SSH, SFTP, SCP, jump host, local/remote/dynamic forward, proxy, agent forwarding, sertifikalar, FIDO2, çoklu sekme, split view, workspaces, snippets, autocomplete, broadcast, tema/kısayol, hosts/groups/tags, ssh_config, kasa, senkronizasyon, ekip paylaşımı. Mobil ve Multiplayer bu listede yok (M7).

### M6 — WECOMMANDER V2 Stable
- **Kapsam:** A24, A25, A26 ve Agent Mode B04–B07, B12; bağımlılık zinciriyle M0–M5 ve U1'in tamamı.
- **Tamamlanma koşulları:** Kullanıcının kendi API anahtarıyla AI asistanı (öner modu varsayılan, maskelenmiş bağlam); komut risk değerlendirmesi; sunucular arası karşılaştırma.
- **Yayın kriterleri:**
  - 4 haftalık stabilizasyon; son 2 haftada 3 işletim sisteminde günlük kullanım ve kritik hata yok.
  - AI sağlayıcısı tanımlı değilken uygulama tam çalışıyor; AI negatif testleri yeşil.
  - Göç rehberi (1.x → 2.0) yayımlanmış.
  - Destek ve bakım kapasitesi ayrılmış.

### M7 — Mobil ve kurumsal genişleme
- **Kapsam:** A27, A28, A29, A30, B11, B13.
- **Tamamlanma koşulları:** Multiplayer (tek yazar, uçtan uca şifreli relay); Android kapalı test; iOS TestFlight; kurumsal politikalar; OIDC SSO; bastion SSH.
- **Yayın kriterleri:**
  - En az bir Android ve bir iPhone'da gerçek kabul; mağaza incelemeleri.
  - SSO ile girişte kasa ayrıca parola istiyor.
  - Bastion için SSRF negatif testleri yeşil.

## 6. Değişiklik yönetimi

- Kapsam değişikliği yalnız kilometre taşı sınırında kabul edilir. Değişiklik veri dosyasında yapılır ve belgeler araçla yeniden üretilir.
- Stabilizasyon dönemlerinde yalnız hata düzeltmesi yapılır.
- Bir kilometre taşı hedef tarihini 4 haftadan fazla aşarsa sahip kapsam daraltma veya kaynak artırma kararı verir; tarih sessizce kaydırılmaz.
