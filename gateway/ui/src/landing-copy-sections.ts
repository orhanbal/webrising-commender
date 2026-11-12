// Keep the editable CMS catalog in sync with copy() keys in Landing.tsx.
// Every entry has a safe literal key; the server stores values as plain text.
// gateway/test/i18n-keys.test.mjs checks the sync and the English texts.
export const landingCopySections = [
  {
    "name": "Hero & navigation",
    "keys": [
      "Giriş Yap",
      "Ücretsiz başla",
      "Kurulum rehberi",
      "Tek satırda kur",
      "Kurulum komutunu kopyala",
      "Kopyalandı",
      "Açık port gerekmez",
      "Root olmayan agent",
      "Örnek MCP oturumu: yapay zekâ bir sunucuda komut çalıştırıyor, yüksek riskli komut onay bekliyor.",
      "ubuntu-prod'da disk doluluğunu kontrol et ve 7 günden eski logları temizle.",
      "İzinli komut",
      "Onay bekliyor",
      "Onayla",
      "Reddet",
      "Her çağrı denetim kaydına yazılır.",
      "Desteklenen yapay zekâ istemcileri",
      "Her MCP istemcisi",
      "SSH istemcisi + yapay zekâ erişimi · Windows ve Mac",
      "Sunucuların için tek uygulama.",
      "Senin ve yapay zekânın.",
      "WECOMMANDER; SSH, Mosh, Telnet ve seri port terminalini, SFTP'yi, tünelleri ve şifreli eşitlemeyi Windows ve Mac'te tek uygulamada toplar. Aynı uygulama, kullandığın yapay zekâyı (Claude, ChatGPT ve her MCP istemcisi) makinelerine onaylı ve denetimli şekilde bağlar.",
      "Uygulamayı indir",
      "Uçtan uca şifreli eşitleme",
      "Windows ve Mac uygulaması"
    ]
  },
  {
    "name": "The app",
    "keys": [
      "UYGULAMA",
      "Günlük SSH işin için",
      "her şey tek pencerede.",
      "Sunucularına bağlan, dosya taşı, tünel aç; listen her bilgisayarında hazır olsun.",
      "SSH, Mosh, Telnet, seri port",
      "Sekmeler, bölünmüş ekran ve aynı komutu birden çok terminale yazma. Mosh ile bağlantı kopsa da oturum sürer.",
      "SFTP dosya yöneticisi",
      "İki panelli dosya yöneticisiyle yükle, indir, taşı ve yeniden adlandır.",
      "Tüneller",
      "Yerel, uzak ve SOCKS port yönlendirme; uygulama açıkken arka planda çalışır.",
      "Anahtarlar ve kimlikler",
      "Anahtar oluştur ya da içe aktar; SSH ajanı ve donanım anahtarlarıyla gir. Parolalar ve özel anahtarlar işletim sisteminin anahtar zincirinde kalır.",
      "Otomatik tamamlama ve parçacıklar",
      "Komut geçmişinden ve kayıtlı parçacıklardan öneri. Parola istemlerine yazılanlar asla kaydedilmez.",
      "Eşitleme ve ekip",
      "Sunucu listen bilgisayarların arasında uçtan uca şifreli eşitlenir. Team planında ekip kitaplığı ve ortak terminal."
    ]
  },
  {
    "name": "Capabilities & cards",
    "keys": [
      "YAPAY ZEKÂ ERİŞİMİ",
      "Yapay zekâya gerçek yetki.",
      "Sınırları sen çiz.",
      "Terminal ve dosyalara tam erişim; her adımda kimin, neyi, nerede yaptığı belli.",
      "Tek MCP adresi, tüm cihazlar",
      "Sunucularını ve bilgisayarlarını tek uç noktaya bağla; yapay zekân istediği makinede çalışır. Gelen bağlantı portu açman gerekmez.",
      "Sunucu tarafında onay",
      "Yüksek riskli işlemler tek kullanımlık onay ister. Cihaz başına Sıkı, Standart veya Tam güven seviyesi ve izinli komut listesi seç.",
      "Root olmayan agent",
      "Agent ayrı bir servis kullanıcısıyla, yalnızca izin verdiğin klasörlerde çalışır. Yazma ve komut yetkileri cihazda ayrıca açılır.",
      "Dosyalarda cerrahi düzenleme",
      "edit_block, SHA-256 korumalı yazma, sürümler ve geri alma. PDF, DOCX ve XLSX okuma dahil.",
      "Gerçek terminal ve görevler",
      "Etkileşimli terminal oturumları, uzun süren görevler, süreç listesi ve süreç ağacı temizliği.",
      "Eksiksiz denetim kaydı",
      "Kim, hangi yapay zekâyla, hangi cihazda ne yaptı: her çağrı rol ve sonuçla birlikte kaydedilir."
    ]
  },
  {
    "name": "How it works",
    "keys": [
      "3 ADIMDA BAŞLA",
      "İki dakikada hazır.",
      "İki işlemle bağlı.",
      "Bir komut çalıştır, tarayıcıda onayla, MCP adresini yapay zekâna ekle.",
      "Kurulum rehberi",
      "01 / KUR",
      "Tek satırla kur",
      "Cihazda kurulum komutunu çalıştır. Paket, yayınlanan SHA-256 özetiyle doğrulanır.",
      "02 / ONAYLA",
      "Tarayıcıda onayla",
      "Terminalde çıkan bağlantıyı aç, hesabınla giriş yap ve cihazı çalışma alanına ekle.",
      "03 / BAĞLA",
      "Yapay zekâna ekle",
      "MCP adresini Claude, ChatGPT veya başka bir istemciye ekle ve OAuth ile izin ver."
    ]
  },
  {
    "name": "Comparison",
    "keys": [
      "KARŞILAŞTIRMA",
      "Yerel MCP araçlarının ötesinde.",
      "Masaüstü MCP araçları tek makinede, kullanıcının tüm yetkileriyle çalışır. WECOMMANDER aynı gücü tüm makinelerine güvenlik katmanlarıyla taşır.",
      "Yerel masaüstü MCP araçları ile WECOMMANDER karşılaştırması",
      "Özellik",
      "Yerel masaüstü MCP araçları",
      "Çalıştığı istemciler",
      "Yerel masaüstü istemcileri",
      "claude.ai web, ChatGPT, mobil ve her MCP istemcisi",
      "Uzak sunucular",
      "Her makinede ayrı kurulum ve bağlantı",
      "Tek uç nokta, açık port yok",
      "Yetki",
      "Kullanıcının tüm yetkileri",
      "Root olmayan servis kullanıcısı, izinli klasörler",
      "Onay",
      "İstemci tarafında",
      "Sunucu tarafında, tek kullanımlık",
      "Denetim",
      "Yerel",
      "Merkezi, rol ve sonuçla",
      "Geri alma",
      "Yok",
      "Sürümler ve geri alma"
    ]
  },
  {
    "name": "Security",
    "keys": [
      "ÖNCE GÜVENLİK",
      "Yapay zekâya erişim ver.",
      "Kontrolü bırakma.",
      "Her komutun, her cihazın ve her yetkinin hesabı belli olsun. Bağlantı kurmak kadar güvenli yönetmek de önemli.",
      "Çalışma alanını oluştur",
      "Tek kullanımlık, imzalı onaylar",
      "Cihaz başına güven seviyesi ve izinli komutlar",
      "OAuth ile bağlanan yapay zekâ istemcileri",
      "Denetim kaydı ve e-posta bildirimleri",
      "Self-hosted çalışma seçeneği"
    ]
  },
  {
    "name": "Pricing",
    "keys": [
      "PAKETLER",
      "İhtiyacın kadar kullan.",
      "Şeffaf şekilde büyü.",
      "Kendi altyapınızda çalıştırma seçeneğini keşfedin.",
      "Paket ve ödeme bilgileri Paddle üzerinden güvenle yönetilir.",
      "Kontrol sizde",
      "Mevcut altyapınızda, kendi sunucunuzda yönetim.",
      "Kendi sunucunuz",
      "Cihaz ve MCP yönetimi",
      "Yetki ve denetim",
      "Seçenekleri incele",
      "Bulutta çalışın",
      "Bireysel ve ekip kullanımı için abonelik seçenekleri.",
      "Merkezi kontrol paneli",
      "Plan bazlı kaynak limitleri",
      "Paddle ile faturalama",
      "Paketleri görüntüle"
    ]
  },
  {
    "name": "FAQ",
    "keys": [
      "SIK SORULANLAR",
      "Merak ettiklerin.",
      "Hangi yapay zekâ istemcileriyle çalışır?",
      "Uzak MCP destekleyen her istemciyle: claude.ai ve Claude Desktop, ChatGPT, Cursor, VS Code ve diğerleri. Bağlantı OAuth ile kurulur.",
      "Sunucumda port açmam gerekir mi?",
      "Hayır. Agent WECOMMANDER'a dışarıya doğru güvenli bir bağlantı kurar; gelen bağlantı portu gerekmez.",
      "Yapay zekâ onaysız ne yapabilir?",
      "Okuma işlemleri onaysız çalışır. Komut çalıştırma, silme ve terminal gibi yüksek riskli işlemler cihazın güven seviyesine göre onay ister; izinli komut listesindekiler onaysız çalışır.",
      "Hangi işletim sistemleri destekleniyor?",
      "Paket ücretini nerede ödeyeceğim?",
      "Self-hosted sürümü kullanabilir miyim?",
      "Evet, kendi altyapınızda çalıştırma için dağıtım modu destekleniyor. Kurulum ve işletim sorumluluğu size ait olabilir.",
      "Termius gibi bir SSH istemcisi mi?",
      "Evet: SSH, Mosh, Telnet ve seri port, SFTP, tüneller, anahtarlar, parçacıklar, otomatik tamamlama, oturum kaydı, şifreli eşitleme ve ekip paylaşımı tek uygulamada. Ayrıca yapay zekânı makinelerine onaylı ve denetimli şekilde bağlar.",
      "Ücretsiz deneyebilir miyim?",
      "Evet. Free plan kart istemez. Ücretli planlarda ilk ödemeden sonraki 14 gün içinde gerekçe göstermeden tam iade alabilirsin; aboneliği istediğin an iptal edebilirsin.",
      "Sunucu bilgilerim ve parolalarım nerede saklanıyor?",
      "Parolalar ve özel anahtarlar bilgisayarının anahtar zincirinde (Windows Kimlik Bilgisi Yöneticisi, macOS Anahtar Zinciri) kalır. Eşitleme açıksa sunucu listen senin parolanla şifrelenip gönderilir; biz içini göremeyiz.",
      "Kurulumda Windows neden uyarı veriyor?",
      "Uygulama henüz kod imzalı değil. Tek satırlık PowerShell komutuyla kurarsan uyarı çıkmaz; kurulum dosyasıyla kurarsan Windows bir kez “Yine de çalıştır” diye sorar. Paket, yayınlanan SHA-256 özetiyle doğrulanır.",
      "Uygulama: Windows 10/11 ve macOS (Apple Silicon ve Intel). Linux sunucular için ajan (Ubuntu/Debian, amd64) ve tepsi uygulaması.",
      "Ödeme, resmi satıcımız Paddle'ın güvenli ödeme ekranında yapılır; faturaları Paddle keser."
    ]
  },
  {
    "name": "Final CTA",
    "keys": [
      "Cihazların hazır.",
      "Sıra sende.",
      "İlk sunucunu iki dakikada bağla ve yapay zekânla çalışmaya başla.",
      "Giriş Yap",
      "Ücretsiz başla"
    ]
  },
  {
    "name": "Footer",
    "keys": [
      "Sunucuların için SSH istemcisi ve güvenli yapay zekâ erişimi.",
      "Ürün",
      "Özellikler",
      "Paketler",
      "Kurulum",
      "Uygulama",
      "Hesap",
      "Giriş Yap",
      "Kayıt Ol",
      "Şifre Sıfırla",
      "Kaynaklar",
      "Dokümantasyon",
      "Sık sorulanlar",
      "Alternatifler",
      "Güvenlik",
      "Yasal",
      "Gizlilik",
      "Kullanım Koşulları",
      "İade ve İptal",
      "Sistem durumu",
      "Uzak MCP · Root olmayan agent · Sunucu tarafı onaylar"
    ]
  }
] as const;
