# WECOMMANDER — İleri Geliştirme Planı 1
## AI Bağımsız Uzaktan Altyapı ve Operasyon Yönetimi

**Durum:** TARTIŞMA TASLAĞI (v0.1) — uygulama için henüz onaylanmış bir geliştirme fazı değildir.
**Oluşturulma tarihi:** 24 Ekim 2026
**Kapsam:** WECOMMANDER'ın Desktop Commander işlevsel eşdeğerlik kabulünden *sonraki* farklılaştırıcı yetenekleri.
**Kanonik mevcut öncelik:** [Desktop Commander Eşdeğerlik Planı](DESKTOP_COMMANDER_PARITY_PLAN.md). Bu belge, mevcut P0/P1/P2 işlerini veya saatlik görev kuyruğunu değiştirmez.

## 1. Ürün konumu — üzerinde anlaşılan temel ilke

**WECOMMANDER yapay zekâ değildir.** Kullanıcının seçtiği ChatGPT, Claude veya başka bir MCP uyumlu AI istemcisi ile yetkilendirilmiş bilgisayarlar/sunucular arasında çalışan, **model/sağlayıcı bağımsız** uzaktan erişim, araç sunumu, yürütme, gözlem ve denetim platformudur.

- **Kullanıcı:** niyet, kapsam, işletim politikaları ve gerekli onayları belirler.
- **Harici / kullanıcı tarafından seçilen AI:** isteği yorumlar, kullanılabilir araçları çağırır, dönen verileri değerlendirir, öneri veya işlem planı üretir.
- **WECOMMANDER MCP + Gateway:** araç sözleşmelerini, kimliği/tenant sınırlarını, izinleri, onay akışını, kayıtları, yönlendirmeyi ve güvenli çıktı sınırlarını uygular.
- **WECOMMANDER Rust Agent:** izinli hedefte yürütme, güvenli dosya/terminal/sistem işlemleri ve yapılandırılmış telemetriyi sağlar.
- **Yönetilen Windows/macOS/Linux cihazlar:** yürütme hedefleridir; mümkün olduğunda yalnızca dışarıya bağlantı kurarlar.

**Ürün ilkesi:** “AI değişebilir, WECOMMANDER değişmez.” Kendi LLM'ini zorunlu tutmaz; kredi kartı isteyen API veya belirli bir AI sağlayıcısı çalışmak için şart değildir. Self-hosted core ücretsiz ve yapay kullanım kotası olmaksızın sunulur; kaynak güvenliği için teknik kotalar ayrıdır.

**Konumlandırma çalışma önerisi:** *WECOMMANDER — Universal Remote Management for AI.* Nihai pazarlama metni henüz onaylanmadı.

## 2. Tasarım ve güvenlik ilkeleri

1. **AI yürütücü değildir:** AI araç talep eder; WECOMMANDER kimlik, izin, risk ve onay doğrulaması sonrasında yürütür. Modelin güvenlik politikasına uyacağı varsayılmaz.
2. **Sıfır güven yaklaşımı:** karşılıklı kimlik doğrulama, cihaz/actor/tenant izolasyonu, en az yetki, kısa ömürlü operasyon onayları ve kapsamı daraltılmış anahtarlar. TLS/WSS tek başına uçtan uca şifreleme veya “tam Zero Trust” değildir; E2EE iddiası ayrı anahtar modeli ve tehdit analizi olmadan yapılmaz.
3. **Yapılandırılmış işlemler:** Docker/servis/IaC için mümkün olduğunca parametre doğrulayan API; ham shell yalnız açık yetkiyle. Log, değişiklik farkı ve redaksiyon varsayılan.
4. **Kontrollü otomasyon:** tanılama/öneri ile müdahaleyi ayır. Etkisi olan işlemde kapsam, risk, onay, zaman aşımı, ilerleme, sonucun bağımsız doğrulaması ve mümkünse geri alma planı.
5. **Dry-run sınırı:** her shell, SQL, ağ veya dış API eylemi gerçeğe uygun simüle edilemez. Gerçek dry-run yalnız desteklenen işlemlerde; diğerlerinde açıkça “etki ön analizi / tahmin” etiketi kullanılacak.
6. **Metrik ≠ karar:** metrik/topoloji/loglar AI'a güvenilir veri olarak aktarılabilir; AI teşhisleri hipotez olarak sunulur. Yanlış pozitif, değişiklik sırasında veri kaybı ve ayrıcalık yükseltme önlenir.
7. **Kurulumsuz bağımlılık ilkesi:** mevcut Rust Agent, TypeScript Gateway, PostgreSQL ve MCP altyapısı korunur. Dış sağlayıcıya veya ücretli/kapalı servise zorunlu runtime bağımlılığı eklenmez.

## 3. Özellik havuzu — öneriler, henüz uygulama kararı değil

| Kod | Özellik | Amaç / ilk kapsam | Temel risk ve koşul | Öncelik önerisi |
|---|---|---|---|---|
| AD1-01 | Çoklu cihaz ve gruplu operasyon | Gruplama, etiket, kapsam seçimi, kademeli toplu yürütme, per-device sonuçlar | Yanlış hedefte toplu değişiklik, blast radius | Yüksek |
| AD1-02 | Yapılandırılmış Docker yönetimi | Container/stack durum ve sağlık, log, inspect; kontrollü restart | Docker soketi yüksek yetkilidir; kök/daemon erişimi sınırlandırılmalı | Yüksek |
| AD1-03 | Linux servis yönetimi | systemd servis durumu, journal ve kontrollü restart | Yetki, bağımlı servisler, rolling/restart sırası | Yüksek |
| AD1-04 | Yapılandırılmış telemetri | CPU/RAM/disk/ağ/süreç/servis sağlık snapshot'ları, zaman damgalı trendler | Veri hacmi, saklama, yanlış tanı | Yüksek |
| AD1-05 | Akıllı log sorgulama | Büyük loglarda sunucu tarafı filtre, sayfalama, zaman aralığı, ERROR/WARN, örnekleme | Sır redaksiyonu, kaynak tüketimi, log enjeksiyonu | Yüksek |
| AD1-06 | Risk, etki analizi ve onay | İşlem planı, before/after, hedef sınırı, approval, audit, mümkünse rollback | Dry-run'ın gerçek olmayan güven hissi | Yüksek |
| AD1-07 | Olay/uyarı motoru | Kurala dayalı sağlık eşikleri, anomali işaretleme, kullanıcının AI'ına olay bağlamı sunma | AI istemcisini izinsiz/garantisiz “uyandırma” varsayımı; bildirim kanalı ayrı seçilir | Orta |
| AD1-08 | Kontrollü self-healing | Kullanıcı tanımlı runbook, allowlist aksiyonları, maksimum tekrar, canary, onay, rollback | Yanlış müdahale/döngü ve kesinti riski | Orta; önce salt-okunur tanılama |
| AD1-09 | SSH/SFTP erişim adaptörü | Agent bulunmayan yönetim hedefleri için alternatif erişim; host key doğrulama | Kimlik bilgisi ve host key güvenliği; mevcut outbound Agent ilk tercih | Orta |
| AD1-10 | Kubernetes adaptörü | Read-only cluster/pod/deployment ve log/olay; sonra kontrollü operasyon | Cluster RBAC, namespace isolation, blast radius | Sonraki faz |
| AD1-11 | IaC / Ansible / Terraform | Plan/diff/doğrulama, açık onayla apply, mevcut repo/state uyumu | State, kilit, sağlayıcı bağımlılığı, geri dönüş zorluğu | Sonraki faz |
| AD1-12 | Bağlam paketleri | AI'a güncel, zaman damgalı servis/topoloji/telemetri/log kanıtı; kaynak ve güven etiketi | Token/kontekst maliyeti, veri sızdırma, prompt injection | Yüksek |
| AD1-13 | Güvenli bağlantı modeli | Outbound Agent, cihaz kimliği, anahtar döndürme, isteğe bağlı tünel adaptörleri | Tünel hizmetine zorunlu bağımlılık ve yanlış E2EE iddiası | Yüksek; mevcut mimariyi derinleştir |

**Not:** Desktop Commander ile karşılaştırmada “tek cihaz destekler”, “metrik sunamaz” veya “yalnız blacklist kullanır” gibi iddialar, güncel resmî kaynakla doğrulanmadıkça ürün gerçeği olarak kullanılmaz. Multi-device desteği tek başına farklılaştırıcı sayılmaz.

## 4. Önerilen aşamalar — eşdeğerlik sonrasında

### Aşama 1 — Gözlem ve açıklanabilirlik (salt okunur)
- AD1-04 telemetri, AD1-05 güvenli log filtreleme, AD1-12 kanıt/bağlam paketleri.
- AI'a yapılandırılmış araç sonucu: `target_id`, `observed_at`, `source`, `measurement`, `confidence/limitations`, `pagination`, `redacted`.
- Başarı ölçütü: kaynaklar denetlenebilir, hassas veri sızmaz, büyük veride bounded çıktı ve pozitif/negatif E2E.

### Aşama 2 — Kapsamlı ama kontrollü yönetim
- AD1-01 çoklu hedef, AD1-02 Docker, AD1-03 servis yönetimi, AD1-06 etki/onay.
- Önce salt-okunur araçlar; ardından hedefe bağlanan ve risk seviyesi belirlenen tekil değişiklikler; ancak sonra toplu değişiklik.
- Başarı ölçütü: yanlış hedef/tenant reddi, dry-run iddiası doğru, kademeli dağıtım, audit ve sonuç doğrulaması.

### Aşama 3 — Olaylar ve güvenli otomasyon
- AD1-07 olay/uyarı, AD1-08 kurala/runbook'a dayalı iyileştirme.
- Otomasyon varsayılan kapalı; düşük riskli ve açıkça izinli işlemlerle başlanır; yüksek riskte kullanıcı onayı korunur.
- Başarı ölçütü: döngü önleme, rate limit, iptal, geri dönüş ve güvenli hata modu.

### Aşama 4 — Harici altyapı entegrasyonu
- AD1-09 SSH/SFTP, AD1-10 Kubernetes, AD1-11 IaC ve AD1-13 opsiyonel erişim adaptörleri.
- Adaptörler mevcut Agent ve model-bağımsız MCP mimarisini değiştirmemeli.
- Başarı ölçütü: zorunlu ticari servis yok, en az yetki, test edilebilir sağlayıcı uyumluluğu.

## 5. Gerçek özellik için tamamlanma kriteri

Bir öneri **DONE** sayılmadan önce: MCP araç şeması ve dönüş/hata kontratı + Gateway yönlendirme/kimlik/yetki + Rust Agent veya güvenli yerel adaptör + kapsam/risk/onay/audit + performans ve kaynak sınırları + pozitif/negatif gerçek E2E + platform uyumluluğu + kanıtlı CI + kullanıcı dokümantasyonu gerekir. Fiziksel platform ve gerçek ChatGPT/Claude kabulü eksikse ilgili durum `PENDING` veya `BLOCKED_EXTERNAL` kalır.

## 6. Tartışma defteri — kararlar ve açık sorular

### Kabul edilen kavramsal kararlar (uygulama onayı değildir)
- WECOMMANDER bir AI/LLM ürünü değildir; kullanıcının AI'ı ile çalışan bağımsız uygulamadır.
- Model ve AI sağlayıcı bağımsızlığı korunur; MCP birincil entegrasyon yüzeyidir.
- Güvenlik ve kritik operasyon onayı WECOMMANDER'ın sorumluluğundadır.
- İlk hedef Desktop Commander işlevsel eşdeğerliğini tamamlamaktır; bu gelişmiş özellikler ardından ele alınacaktır.
- Plan birlikte tartışılarak yeni fikirlerle büyütülebilir; öncelikler nihai değildir.

### Birlikte tartışılacak sorular
1. WECOMMANDER tekil bilgisayar + sunucu + kümeyi aynı panelde mi, yoksa rol bazlı çalışma alanlarında mı göstermeli?
2. Docker için salt-okunur araç setinin sınırları ve hangi yazma işlemlerinin ilk sürüme gireceği?
3. Telemetriyi Agent mı toplayacak; saklama süresi, olay tetikleme ve veri mahremiyeti nasıl işleyecek?
4. AI istemcisine proaktif bildirim için hangi desteklenen mekanizmalar kullanılabilir? Kullanıcıya bildirim ve AI'a yeni tur başlatma ayrı kabiliyetlerdir.
5. Otomatik iyileştirmede asla otonom uygulanmayacak işlemler hangileri?
6. Maxiom gibi başka ürünlerle entegrasyon mümkün mü; ürün sınırları ve bağımsız dağıtım nasıl korunur?
7. Sürümleme ve paketlerin adlandırması nasıl olacak? (Bu belge **Plan 1** olarak kalır; yeni tartışmalar ayrıca numaralandırılabilir.)

## 7. Değişiklik geçmişi
- **v0.1 — 2026-10-24:** İlk tartışma taslağı. AI bağımsızlığı, sorumluluk ayrımı, 13 öneri ve 4 önerilen aşama kaydedildi.
