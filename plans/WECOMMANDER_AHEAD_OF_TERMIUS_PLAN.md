# WECOMMANDER: Termius'un açık ara önüne geçme planı

Tarih: 28 Kasım 2026 · Durum: owner onayıyla kabul edildi, sıralı plan

## Amaç ve strateji

WECOMMANDER'ı klasik SSH istemcisi olarak Termius'la yarıştırmıyoruz.
Termius bu alanda yıllarca cilalanmış bir ürün. Biz **yapay zekâ ile
kontrollü sunucu yönetimi** kategorisinde önden gidiyoruz ve onu büyütüyoruz.
Termius'un bizden güçlü olduğu iki alanı (mobil ve kanıtlanmış güven)
bizim farkımızı büyüten bir sırayla kapatıyoruz.

Temel ilkeler:

- **Önce farkı büyüten iş.** Termius'ta olmayan bir değer üretmeyen
  eşitleme işi en sona kalır.
- **Gelir gelmeden ücretli iş yok.** SOC 2 ve ücretli dış denetim, gelir ve
  kurumsal talep oluşunca yapılır.
- **Talep verisi.** Bulut içe aktarma ve Kubernetes/Terraform gibi işler,
  kullanıcıların istediği yönetim konsolunun Büyüme bölümündeki veriyle
  görülünce sıraya girer.
- **Mevcut planlar korunur.** WTE2 (`docs/WTE2_PLAN.md`), masaüstü
  uygulamaları ve Marketplace Release V1 bu planla çakışmaz.

## Bugünkü durum: neyi zaten yapıyoruz

Dışarıdan yapılan karşılaştırmalarda gözden kaçan ama bugün **var olan**
özellikler:

| Konu | Durum | Kanıt |
| --- | --- | --- |
| Uçtan uca şifreli eşitleme | Var. Sunucular, anahtarlar ve parçacıklar istemcide şifrelenir; sunucu içeriği göremez. | A20 (E2E library sync) |
| Doğrudan SSH bağlantısı | Var. Masaüstü istemcisi sunucuya doğrudan bağlanır. Gateway yalnız yapay zekâ/MCP yolunda kullanılır. | `crates/wc-app-core` |
| Self-hosted gateway | Var, belgelenmemiş. `DEPLOYMENT_MODE` varsayılanı `self_hosted`. | `gateway/src/billing.ts:11`, `docker-compose*.yml` |
| Güvenlik testleri | Var, birleştirilmeyi bekliyor: SG-01–SG-10, sürüm engelleyici. | PR #207, `docs/SECURITY_GATE.md` |
| İnsan onayı, güvenlik ağı, denetim kaydı, geri alma | Var. | `docs/AI_PERMISSIONS.md` |

Asıl açıklar: **mobil uygulama yok**, **güven kanıtı dışarıya açık değil**,
**izleme yüzeysel** (alarm ve çok sunuculu pano yok).

## Sıralı plan

| Sıra | Aşama | Neden bu sırada |
| --- | --- | --- |
| 1 | Marketplace Release V1 | Güvenlik açıklarını kapatır, profilleri getirir, dizinlerde görünürlük sağlar: güven ve dağıtım tek işte |
| 2 | Mobil onay ve izleme uygulaması | En büyük açık; Termius'ta olmayan bir değerle kapatılır |
| 3 | Açık güvenlik sayfası ve E2E modelinin belgelenmesi | Var olanı kanıtlar; ücretsiz |
| 4 | İzleme derinliği: alarm, çok sunuculu pano, düzeltme önerileri | Kategorimizi Termius'un hiç olmadığı yere taşır |
| 5 | Self-hosted paketin belgelenmesi | Kurumsal talep için; altyapı zaten var |
| 6 | Tam mobil terminal/SFTP, Linux masaüstü, bulut içe aktarma | Talep verisine göre; Termius'la eşitleme işi |

---

## 1. Marketplace Release V1

- **Kaynak:** "WECOMMANDER Marketplace Release V1 Master Plan" belgesi
  (MR-00 – MR-20, Marketplace Security Acceptance Gate MSAG-01 – MSAG-22).
  Belgenin depo kopyası `docs/marketplace/` altına MR-14 kapsamında taşınacak.
- **Owner kararları (25 Kas):**
  - Yeni dizin bağlantılarında varsayılan profil MANAGED.
  - Hız sınırları: token başına 120/dk, yüksek riskli araçlar 20/dk, onay isteği 10/dk.
  - Demo cihazı mevcut altyapıda yalıtılmış bir konteynerde.
  - MSAG-22 incelemesini Claude, ayrı bir inceleme ajanıyla yapacak.
- **Çıkış ölçütü:** MSAG ilk platform başvurusu için geçti; Claude Connector
  başvurusu yapıldı.

## 2. Mobil onay ve izleme uygulaması (iOS + Android)

- **Amaç:** Telefon, yapay zekânın yaptığı işler için **güvenli bir onay cihazı**
  ve sunucular için **cepteki izleme ekranı** olur. Termius'un mobili bir
  terminal; bizimki bir kontrol merkezi.
- **Kapsam (V1):**
  - Hesapla giriş ve cihaz bağlama: mevcut "Management Center" bağlama akışı
    (`center-link`) yeniden kullanılır.
  - Onay istekleri: anlık bildirim; parametre, hedef cihaz ve kalan süre
    görünür; Onayla/Reddet. Onay biyometrik doğrulama (Face ID / parmak izi) ister.
  - Otonom modu açma/kapatma ve süre seçimi; genişletme şifre ve biyometri ister.
  - Cihazlar ve SSH sunucuları: çevrimiçi durumu, CPU/RAM/disk özeti.
  - Agent Yetkilendirme: masaüstündeki gibi daraltma serbest, genişletme
    şifreli.
  - Alarm bildirimleri (Aşama 4 hazır olunca).
- **Teknik yaklaşım (öneri, karar verilecek):**
  - Mevcut Rust çekirdeği (`wc-app-core`) paylaşılır. Arayüz SwiftUI (iOS) ve
    Kotlin/Compose (Android) olur; masaüstündeki gibi yerel arayüz.
  - Anlık bildirimler için APNs ve FCM. Gateway'e yeni bir bildirim kanalı
    eklenir.
  - Ücretli geliştirici hesapları gerekir (Apple 99$/yıl, Google 25$ tek sefer).
    Bu, "gelir gelmeden ücretli iş yok" kuralı yüzünden **owner kararı**
    gerektirir.
- **Güvenlik gereksinimleri:**
  - Mobil uygulama bir yapay zekâ istemcisi değildir: MCP aracı çağıramaz,
    yalnız insan oturumu (`center` benzeri yeni bir `mobile` kimlik türü)
    olarak onay verir.
  - Bu kimlik türü, MR-02'deki "onayı yalnız insan oturumu verir" kuralına
    eklenir.
  - Token cihazın güvenli deposunda (Keychain / Android Keystore) tutulur.
  - Kayıp telefon web panelinden iptal edilebilir.
- **Kabul kriterleri:**
  - AI'ın başlattığı yüksek riskli bir işlem için 5 saniye içinde bildirim
    gelir. Onay telefondan verilince işlem çalışır, reddedilince çalışmaz.
  - Biyometri başarısızsa onay verilmez.
  - İptal edilen telefon bir sonraki istekte 401 alır.
- **Testler:** gateway için `mobile` kimlik türü e2e testi (onay verebilir, MCP
  çağıramaz, iptal); Security Gate'e yeni SG maddesi; iOS/Android arayüz
  testleri.
- **Çıkış ölçütü:** TestFlight ve Google Play kapalı test kanalında çalışan
  sürüm; ardından mağaza yayını.

## 3. Açık güvenlik sayfası ve E2E modelinin belgelenmesi

- **Amaç:** Var olan güvenlik özelliklerini **doğrulanabilir** hale getirmek.
  "Bize güvenin" yerine "bakın, böyle çalışıyor".
- **Kapsam:**
  - `wecommander.app/security` sayfasının genişletilmesi (6 dil):
    - Mimari çizim: istemci → gateway → ajan; doğrudan SSH yolu ayrı gösterilir.
    - E2E şifrelemenin nasıl çalıştığı: algoritmalar, anahtar türetme, sunucuda
      ne durduğu ve ne durmadığı.
    - Neyin, ne kadar süre saklandığı: denetim kaydı 90 gün, onay istekleri
      30 gün, kullanılmayan OAuth istemcileri 90 gün. Değerler koddaki temizlik
      işleriyle bir testle eşleştirilir.
    - Gateway'de ne loglanıyor, ne loglanmıyor; gizli bilgi maskeleme.
    - Yapay zekâ istemcisine hangi verinin gittiği.
  - `/.well-known/security.txt` ve `security@wecommander.app` sorumlu bildirim
    adresi; açıklama politikası.
  - Marketplace Security Acceptance Gate kanıt raporlarının özetinin yayımlanması.
  - Sürüm notlarında güvenlik düzeltmelerinin ayrı başlıkla duyurulması.
  - Gelir oluşunca: tek seferlik dış sızma testi ve özet raporunun yayımlanması.
    SOC 2, kurumsal müşteri talep edince değerlendirilir.
- **Bağımlılık:** Aşama 1'in MR-13'ü (gizlilik politikası) ile birlikte yürür.
- **Kabul kriterleri:**
  - Sayfadaki her saklama süresi ve iddia, koddaki değerle otomatik testle
    eşleşir.
  - `security.txt` RFC 9116'ya uygun.
- **Testler:** `legal-retention.test.ts` genişletilir; site içerik testleri.
- **Çıkış ölçütü:** Sayfa canlıda; bildirim adresi çalışıyor.

## 4. İzleme derinliği

- **Amaç:** Sorunu kullanıcı fark etmeden yakalamak ve ne yapılacağını önermek.
  Termius'ta bu alan hiç yok.
- **Kapsam:**
  - **Alarm kuralları:** disk doluluk, CPU/RAM eşiği, servis veya konteyner
    durması, zombi süreç artışı, sertifika süresi, yedek başarısızlığı.
    Varsayılan kurallar hazır gelir.
  - **Bildirim:** e-posta, masaüstü, mobil (Aşama 2) ve isteğe bağlı webhook.
  - **Çok sunuculu pano:** tüm sunucuların sağlık özeti tek ekranda
    (web + masaüstü).
  - **Düzeltme önerileri:** her alarm için önerilen işlem; ör. "disk %92 →
    temizlik taraması" veya "zombiler → `--init` önerisi". Mevcut sunucu
    yönetimi araçlarına bağlanır. Öneri insan onayıyla uygulanır.
  - **Yapay zekâya bağlam:** alarmlar MCP üzerinden okunabilir
    (`alerts_list`); AI ancak kullanıcının profiline ve onayına göre işlem yapar.
  - **AI etkinlik raporu:** yapay zekânın hangi cihazda ne yaptığının günlük ve
    haftalık özeti (denetim kaydından).
- **Mevcut temel:** sunucu genel bakışı, disk/süreç/zamanlayıcı araçları, Dock
  ve menü çubuğu canlı izleme, zamanlanmış görevler, hata e-postaları.
- **Güvenlik gereksinimleri:** Alarmdan tetiklenen hiçbir işlem onaysız
  çalışmaz. Önerilen işlem Capability Profile ve güven seviyesine uyar.
- **Kabul kriterleri:**
  - Disk eşiği aşılınca 2 dakika içinde bildirim gelir.
  - Öneri tek tıkla, onay ekranından uygulanır.
  - Pano 50 sunucuda akıcı çalışır.
- **Testler:** alarm motoru birim testleri; ajan + gateway e2e (sahte disk
  doluluğu); Dock ve pano görsel testleri.
- **Çıkış ölçütü:** Varsayılan alarm seti canlıda; haftalık AI etkinlik raporu
  e-postası çalışıyor.

## 5. Self-hosted paketin belgelenmesi

- **Amaç:** Şirketlerin gateway'i kendi sunucusunda kurup işletebilmesi.
  Altyapı zaten var (`DEPLOYMENT_MODE=self_hosted`, Docker Compose); eksik olan
  belge ve destek süreci.
- **Kapsam:**
  - `docs/SELF_HOSTED.md`: gereksinimler, kurulum, TLS, e-posta, yedek ve geri
    yükleme (mevcut `BACKUP_RECOVERY_RUNBOOK.md`), güncelleme ve sürüm takibi.
  - Masaüstü uygulamalarında kendi sunucu adresini kullanma (mevcut ayar)
    belgelenir.
  - Kurumsal lisans ve destek koşulları owner tarafından belirlenir.
  - "Air-gapped" (internetsiz) kurulum: yalnız somut kurumsal talep gelirse
    planlanır.
- **Kabul kriterleri:** Temiz bir Linux sunucusunda belgedeki adımlarla
  1 saatten kısa sürede çalışan kurulum. Ajan ve masaüstü uygulaması bağlanır;
  onay akışı çalışır.
- **Testler:** CI'daki `compose-smoke` işinin self-hosted senaryosu.
- **Çıkış ölçütü:** Belge yayında; bir deneme kurulumunun tutanağı.

## 6. Talebe bağlı işler

Bu işler, Büyüme panosundaki talep verisi ve kullanıcı geri bildirimiyle
sıraya girer:

- **Tam mobil terminal ve SFTP.** Aşama 2 uygulamasına eklenir. WTE2 çekirdeği
  (`wte-core`) mobilde de kullanılabilir.
- **Linux masaüstü uygulamasının önizlemeden çıkması** (N3 bugün ertelenmiş).
- **Bulut içe aktarma:** AWS, DigitalOcean, Azure ve Hetzner sunucularını tek
  tıkla listeye ekleme.
- **Kubernetes ve Terraform araçları** (MCP + masaüstü).
- **Daha akıllı onay politikaları:** zaman pencereli izinler, komut kalıbı
  önerileri, kişiye ve role özel kurallar.

## Ölçülecekler

| Metrik | Kaynak | Hedef yönü |
| --- | --- | --- |
| Haftalık aktif kullanıcı ve bağlı cihaz | Büyüme panosu | Artış |
| AI onay isteği → karar süresi (medyan) | Denetim kaydı | Mobil sonrası düşüş |
| Alarmlardan uygulanan öneri oranı | Alarm motoru | Artış |
| Dizinlerden gelen yeni bağlantı | OAuth istemci kayıtları | Artış |
| Güvenlik bildirimleri ve kapanış süresi | security@ | Hızlı kapanış |

## Bu planda yapılmayacaklar

- SOC 2 (kurumsal talep ve gelir olmadan).
- Termius'un her özelliğini birebir kopyalamak.
- Talep verisi olmadan yeni bulut veya altyapı entegrasyonu.
- Mağaza politikası yüzünden ana üründen özellik kaldırmak.
