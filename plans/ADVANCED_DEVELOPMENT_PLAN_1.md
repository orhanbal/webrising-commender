# WECOMMANDER — İleri Geliştirme Planı 1
## AI Bağımsız Uzaktan Altyapı ve Operasyon Yönetimi

**Durum:** TARTIŞMA / İLERİ GELİŞTİRME YOL HARİTASI (v0.2) — özelliklerin plana dahil edilmesi onaylandı; uygulama başlangıcı, geliştirme kapsamı ve kabulü ayrıca değerlendirilir.
**Oluşturulma tarihi:** 24 Ekim 2026
**Kapsam:** WECOMMANDER'ın Desktop Commander işlevsel eşdeğerlik kabulünden *sonraki* farklılaştırıcı yetenekleri.
**Kanonik mevcut öncelik:** [Desktop Commander Eşdeğerlik Planı](DESKTOP_COMMANDER_PARITY_PLAN.md). Bu belge, mevcut P0/P1/P2 işlerini veya saatlik görev kuyruğunu değiştirmez; yeni fikirler yalnız ileri geliştirme havuzuna dahil edilmiştir.

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
| AD1-04 | Yapılandırılmış telemetri ve akış analitiği | CPU/RAM/disk/ağ/süreç/servis sağlık snapshot'ları; zaman damgalı trendler, artış hızları ve yerel eşik tabanlı anomali sinyalleri | Hafif toplayıcı, veri hacmi, saklama, yanlış pozitifler; Agent'a zorunlu LLM/vektör DB yerleştirilmez | Yüksek |
| AD1-05 | Akıllı log sorgulama ve akış izleme | Büyük loglarda sunucu tarafı filtre, sayfalama, zaman aralığı, ERROR/WARN, örnekleme, akış takibi, regex ve belirti kümelendirme | Sır redaksiyonu, kaynak tüketimi, log enjeksiyonu, bounded tampon/retention | Yüksek |
| AD1-06 | Risk, etki analizi ve onay | İşlem planı, before/after, hedef sınırı, approval, audit, mümkünse rollback | Dry-run'ın gerçek olmayan güven hissi | Yüksek |
| AD1-07 | Olay/uyarı ve anomali tespiti | Eşik ve oran artışı tespiti (ör. SSH giriş hatası), korelasyon, tekilleştirme, kullanıcıya bildirim ve AI'a sorgulanabilir olay akışı | AI istemcisini kendiliğinden uyandırma varsayılmaz; yanlış pozitif, gürültü ve bildirim kanalı ayrıca yönetilir | Orta |
| AD1-08 | Kontrollü self-healing | Kullanıcı tanımlı runbook, allowlist aksiyonları, maksimum tekrar, canary, onay, rollback | Yanlış müdahale/döngü ve kesinti riski | Orta; önce salt-okunur tanılama |
| AD1-09 | SSH/SFTP erişim adaptörü | Agent bulunmayan yönetim hedefleri için alternatif erişim; host key doğrulama | Kimlik bilgisi ve host key güvenliği; mevcut outbound Agent ilk tercih | Orta |
| AD1-10 | Kubernetes adaptörü | Read-only cluster/pod/deployment ve log/olay; sonra kontrollü operasyon | Cluster RBAC, namespace isolation, blast radius | Sonraki faz |
| AD1-11 | IaC / Ansible / Terraform | Plan/diff/doğrulama, açık onayla apply, mevcut repo/state uyumu | State, kilit, sağlayıcı bağımlılığı, geri dönüş zorluğu | Sonraki faz |
| AD1-12 | AI'a güvenilir olay/bağlam paketleri | Zaman damgalı servis/topoloji/telemetri/log kanıtı, olay zinciri, açıklanabilir özet, kaynak ve güven etiketi, sorguya göre en küçük veri | Token/kontekst maliyeti, veri sızdırma, loglardan prompt injection; analiz AI istemcisinin sorumluluğunda | Yüksek |
| AD1-13 | Güvenli bağlantı modeli | Outbound Agent, cihaz kimliği, anahtar döndürme, isteğe bağlı tünel adaptörleri | Tünel hizmetine zorunlu bağımlılık ve yanlış E2EE iddiası | Yüksek; mevcut mimariyi derinleştir |
| AD1-14 | **Time Machine & Transactional Rollback** | Önce WECOMMANDER'ın yaptığı dosya/konfigürasyon değişikliklerinde işlem öncesi sürüm+diff+metadata; işlem grubu, doğrulama ve seçili güvenli geri alma; sonraki adımda dış değişikliklerin salt-okunur gözlemi ve desteklenen LVM/Btrfs/ZFS/sanal makine snapshot adaptörleri | Genel komutların ve canlı veritabanının her etkisi geri alınamaz; depolama alanı, kilitler, tutarlılık, sırlar, izinler, retention ve kısmi rollback ayrımı | Çok yüksek; AD1-06 ile entegre |
| AD1-15 | **Safe Execution & Environment Validation** | `analysis` (öngörü), `sandbox_test` (desteklenen izole gerçek test), `preview` (değişiklik farkı), `apply` (kapsamlı onay) modları; işlem türüne özel doğrulayıcılar | eBPF sandbox değildir; chroot tam izolasyon değildir; container üretim ortamını birebir taklit etmez; dry-run yapılamayan işte kesin güvenlik garantisi verilmez | Çok yüksek; AD1-06 ile entegre |
| AD1-16 | **Distributed Operation Orchestration** | Kullanıcının AI'ının önerdiği planı merkezi Gateway/Orchestrator'ın sıralaması; hedef bazlı izin, bağımlılık grafı, kademeli yürütme, iptal, tekil sonuç ve doğrulama | Agent'lar kendi AI'larıyla karşılıklı emir vermez; yetki merkezi olarak doğrulanır; yanlış hedefe toplu değişiklik ve race koşulları önlenir | Yüksek; AD1-01/08 ile entegre |
| AD1-17 | **Hardware-Backed Identity & Attestation** | İsteğe bağlı TPM/HSM destekli cihaz anahtarı koruması, donanım/ölçüm attestation ve uygun platformlarda TEE adaptörü; yazılımsal güvenlik varsayılan temel | HSM/TPM/SGX/SEV eşdeğer değildir; host ele geçirilmesine karşı mutlak garanti yok; zorunlu özel donanım veya ücretli hizmete bağımlılık oluşturulmaz | Kurumsal/sonraki faz; AD1-13 ile entegre |

**Not:** Desktop Commander ile karşılaştırmada “tek cihaz destekler”, “metrik sunamaz” veya “yalnız blacklist kullanır” gibi iddialar, güncel resmî kaynakla doğrulanmadıkça ürün gerçeği olarak kullanılmaz. Multi-device desteği tek başına farklılaştırıcı sayılmaz.

## 4. Önerilen aşamalar — eşdeğerlik sonrasında

### Aşama 1 — Gözlem ve açıklanabilirlik (salt okunur)
- AD1-04 telemetri, AD1-05 güvenli log filtreleme, AD1-12 kanıt/bağlam paketleri; AD1-07 için basit oran/eşik tespit verileri.
- Büyük loglarda streaming/regex/istatistik önceliklidir; zorunlu yerel AI modeli veya vektör veritabanı yoktur.
- AI'a yapılandırılmış araç sonucu: `target_id`, `observed_at`, `source`, `measurement`, `confidence/limitations`, `pagination`, `redacted`.
- Başarı ölçütü: kaynaklar denetlenebilir, hassas veri sızmaz, büyük veride bounded çıktı ve pozitif/negatif E2E.

### Aşama 2 — Kapsamlı ama kontrollü yönetim
- AD1-01 çoklu hedef, AD1-02 Docker, AD1-03 servis yönetimi, AD1-06 etki/onay.
- AD1-14 kapsamında önce WECOMMANDER tarafından yapılan izinli dosya/konfigürasyon değişiklikleri için otomatik sürüm kaydı ve geri alma; AD1-15 için analysis/preview, yalnız desteklenen işlemler için sandbox_test ve açık onaylı apply. Bunlar operasyonların güvenli uygulamasının önkoşuludur.
- Önce salt-okunur araçlar; ardından hedefe bağlanan ve risk seviyesi belirlenen tekil değişiklikler; ancak sonra toplu değişiklik.
- Başarı ölçütü: yanlış hedef/tenant reddi, dry-run iddiası doğru, kademeli dağıtım, audit ve sonuç doğrulaması.

### Aşama 3 — Olaylar ve güvenli otomasyon
- AD1-07 olay/uyarı, AD1-08 kurala/runbook'a dayalı iyileştirme ve AD1-16 merkezî, bağımlılık farkındalıklı operasyon orkestrasyonu.
- AD1-14 ikinci aşama: WECOMMANDER dışındaki değişikliklerin opsiyonel salt-okunur gözlemi ve platformun gerçekten desteklediği snapshot adaptörleri; her değişiklik otomatik geri alınabilir iddiası yok.
- Otomasyon varsayılan kapalı; düşük riskli ve açıkça izinli işlemlerle başlanır; yüksek riskte kullanıcı onayı korunur.
- Başarı ölçütü: döngü önleme, rate limit, iptal, geri dönüş ve güvenli hata modu.

### Aşama 4 — Harici altyapı entegrasyonu
- AD1-09 SSH/SFTP, AD1-10 Kubernetes, AD1-11 IaC ve AD1-13 opsiyonel erişim adaptörleri; AD1-17 opsiyonel donanım kimliği/attestation adaptörleri.
- Adaptörler mevcut Agent ve model-bağımsız MCP mimarisini değiştirmemeli.
- Başarı ölçütü: zorunlu ticari servis yok, en az yetki, test edilebilir sağlayıcı uyumluluğu.

## 4.1 Yeni kabul edilen plan maddelerinin teknik sınırları (v0.2)

### AD1-14 — Time Machine / Rollback
- **İlk teslim:** WECOMMANDER üzerinden yapılan ve programın desteklediği dosya/konfigürasyon yazmalarında değişiklik öncesi içerik hash'i, izin/metadata, diff, operasyon kimliği, hedef/actor/tenant, saklama süresi ve şifreli/korumalı sürüm geçmişi. Dosya tabanlı geri alma yeni değişiklikleri ezmeden önce conflict/approval kontrolünden geçer.
- **İşlem grupları:** Bir operasyon birden fazla dosya etkiliyorsa bağımlılık, kısmi başarısızlık, kısmi rollback ve doğrulama sonuçları açıkça raporlanır; genel atomiklik vaat edilmez.
- **İkinci teslim:** Dış uygulama/kullanıcı değişiklikleri için *gözlem* (izleme kapasitesine göre), desteklenen dosya sistemi veya VM snapshot API'lerine isteğe bağlı entegrasyon. Bu bir “tüm makineyi belirli dakikaya kusursuz döndürme” garantisi değildir.
- **Kabul:** Aynı dosyada eşzamanlı dış değişiklik, büyük dosya, gizli veri, disk doluluğu, restart, bozuk snapshot, yanlış actor/tenant ve reddedilmiş geri alma testleri.

### AD1-15 — Safe Execution / Environment Validation
- **Dört açık mod:** `analysis` yalnız statik risk/etki tahmini; `preview` plan/diff; `sandbox_test` yalnız ortam izole edilebilen ve sınırları belgelenen işlemlerin gerçek testi; `apply` gerçek hedefe yetkili ve onaylı yürütme.
- **Doğrulama:** Nginx yapılandırma doğrulaması gibi belirli operasyon doğrulayıcıları kullanılabilir; sonuç gerçek ortamdaki tüm yan etkilerin kesin tahmini değildir.
- **Güvenlik:** Dosya sistemi, ağ, kimlik bilgileri, Docker soketi, syscalls ve kaynak limitleri izole edilir; izolasyon doğrulanamıyorsa sandbox_test reddedilir. `chroot` veya `eBPF` tek başına tam sandbox sayılmaz.
- **Kabul:** Sahte izole ortam, dış ağa kaçış, host mount, token sızıntısı, timeout/CPU/memory limitleri, test-uygula arasında durum değişimi ve onaysız apply negatif testleri.

### AD1-16 — Distributed Operation Orchestration
- **Merkezî koordinatör:** Tek bir AI tarafından önerilen veya kullanıcı tarafından oluşturulan operasyon planı, Gateway üzerinden cihaz/tenant/actor/approval kapsamına bağlanır; Agent başka Agent'a doğrudan emir vermez.
- **Yürütme:** DAG bağımlılıkları, sıralı/kademeli yayma, hedef grubu sınırı, idempotency key, kilit, cancellation, retry budget, heartbeat ve her hedefin ayrı sonuç/rollback durumu.
- **Kabul:** Yanlış target/tenant, cihaz offline, kısmi başarısızlık, yeniden bağlanma, tekrar çağrı, toplu operasyon limiti, blast-radius ve yarış koşulu E2E.

### AD1-17 — Hardware-Backed Identity & Attestation
- **İlkeler:** Yazılımsal anahtar ve mevcut güvenlik modeli tüm cihazlarda desteklenmeye devam eder; TPM/HSM/TEE desteği opsiyonel ve platform kabiliyetine göre olmalıdır.
- **Teknik ayrım:** TPM/HSM anahtar koruması; platform-specific attestation ölçüm/kanıt; SGX/SEV gibi TEE teknikleri ayrı tehdit modelleridir. Hiçbiri ele geçirilmiş host üzerinde mutlak gizlilik veya yönetim güvenliği garanti etmez.
- **Kabul:** Desteklenen donanımda geçerli/geçersiz attestation, anahtar döndürme, cihaz iptali, fallback politika kararı, sürüm değişimi ve sahte kanıt negatif testleri. Desteksiz cihazlarda güvenli biçimde devre dışı.

### AD1-04/05/07/12 — Semantik anomali tespiti önerisinin entegrasyonu
- **Veri katmanı:** Hafif Agent gözlemi, Gateway tarafında mümkünse kural/istatistik ile oran değişimi, log streaming, regex, tekilleştirme ve zaman damgalı olaylar; isteğe bağlı arama indeksi, fakat zorunlu Agent-içi LLM/Vector DB yok.
- **AI sınırı:** WECOMMANDER bağlam/veri sunar; semantik yorumu kullanıcı tarafından seçilen AI yapabilir. İleride opsiyonel yerel analiz adaptörü tartışılabilir; platformun çalışması için zorunlu değildir.
- **Proaktiflik:** WECOMMANDER kullanıcıya bildirim/olay akışı gönderebilir; harici AI istemcisinde otomatik yeni konuşma başlatacağı varsayılmaz.
- **Kabul:** SSH başarısız giriş oranında artış, hatalı zaman damgası, noise/dedup, log enjekte edilmiş komut metni, veri redaksiyonu, bounded çıktı ve yanlış pozitif regresyonları.

## 5. Gerçek özellik için tamamlanma kriteri

Bir öneri **DONE** sayılmadan önce: MCP araç şeması ve dönüş/hata kontratı + Gateway yönlendirme/kimlik/yetki + Rust Agent veya güvenli yerel adaptör + kapsam/risk/onay/audit + performans ve kaynak sınırları + pozitif/negatif gerçek E2E + platform uyumluluğu + kanıtlı CI + kullanıcı dokümantasyonu gerekir. Fiziksel platform ve gerçek ChatGPT/Claude kabulü eksikse ilgili durum `PENDING` veya `BLOCKED_EXTERNAL` kalır.

## 6. Tartışma defteri — kararlar ve açık sorular

### Kabul edilen kavramsal kararlar (uygulama onayı değildir)
- WECOMMANDER bir AI/LLM ürünü değildir; kullanıcının AI'ı ile çalışan bağımsız uygulamadır.
- Model ve AI sağlayıcı bağımsızlığı korunur; MCP birincil entegrasyon yüzeyidir.
- Güvenlik ve kritik operasyon onayı WECOMMANDER'ın sorumluluğundadır.
- İlk hedef Desktop Commander işlevsel eşdeğerliğini tamamlamaktır; bu gelişmiş özellikler ardından ele alınacaktır.
- Plan birlikte tartışılarak yeni fikirlerle büyütülebilir; öncelikler nihai değildir.
- **v0.2 kapsam kararı:** AD1-14, AD1-15, AD1-16 ve AD1-17 adayları önerilen teknik sınırlarla ileri geliştirme havuzuna dahil edildi; AD1-04/05/07/12 genişletildi. Kodlamaya başlamak veya mevcut saatlik eşdeğerlik otomasyonunu değiştirmek anlamına gelmez.
- **Time Machine aşamalama kararı:** Önce yalnız WECOMMANDER tarafından yapılan değişikliklerin izlenmesi/geri alınması; sonra dış değişiklikleri gözlemleme ve desteklenen snapshot entegrasyonları.

### Birlikte tartışılacak sorular
1. WECOMMANDER tekil bilgisayar + sunucu + kümeyi aynı panelde mi, yoksa rol bazlı çalışma alanlarında mı göstermeli?
2. Docker için salt-okunur araç setinin sınırları ve hangi yazma işlemlerinin ilk sürüme gireceği?
3. Telemetriyi Agent mı toplayacak; saklama süresi, olay tetikleme ve veri mahremiyeti nasıl işleyecek?
4. AI istemcisine proaktif bildirim için hangi desteklenen mekanizmalar kullanılabilir? Kullanıcıya bildirim ve AI'a yeni tur başlatma ayrı kabiliyetlerdir.
5. Otomatik iyileştirmede asla otonom uygulanmayacak işlemler hangileri?
6. Maxiom gibi başka ürünlerle entegrasyon mümkün mü; ürün sınırları ve bağımsız dağıtım nasıl korunur?
7. Sürümleme ve paketlerin adlandırması nasıl olacak? (Bu belge **Plan 1** olarak kalır; yeni tartışmalar ayrıca numaralandırılabilir.)
8. Time Machine sürümleri cihazda mı, Gateway'de mi, kullanıcı tarafından seçilen depoda mı şifreli saklanmalı; toplam depolama bütçesi ve retention politikası nedir?
9. Güvenli işlemin ilk sürümünde hangi operasyon tipleri için gerçek sandbox_test yapılabilir; hangileri yalnız analysis/preview destekler?
10. Çoklu cihaz orkestrasyonunda tek hedef ve toplu hedef varsayılan onay politikaları nasıl ayrılmalı?
11. TPM/HSM/TEE adaptörlerinden hangileri gerçek kullanıcı cihazlarında talep görüyor; hangi platformlar önce desteklenmeli?

## 7. Değişiklik geçmişi
- **v0.2 — 2026-10-24:** Kullanıcı onayıyla AD1-14 Time Machine, AD1-15 Safe Execution, AD1-16 Distributed Operation Orchestration ve AD1-17 Hardware-Backed Identity adayları plana eklendi. AD1-04/05/07/12 akış analitiği ve anomali odaklı genişletildi. Time Machine başlangıcı WECOMMANDER işlemleriyle sınırlandı. Mevcut eşdeğerlik geliştirmesinin önceliği değişmedi.
- **v0.1 — 2026-10-24:** İlk tartışma taslağı. AI bağımsızlığı, sorumluluk ayrımı, 13 öneri ve 4 önerilen aşama kaydedildi.
