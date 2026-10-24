# WECOMMANDER — İleri Geliştirme Planı 1
## AI Bağımsız Uzaktan Altyapı ve Operasyon Yönetimi

**Durum:** ONAYLANMIŞ İLERİ GELİŞTİRME FİKİR HAVUZU / TASARIM TASLAĞI (v0.3) — önerilerin plana alınması onaylandı; uygulama başlangıcı, ayrıntılı gereksinimler, takvim ve gerçek kabul ayrıca kararlaştırılacaktır.
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
| AD1-15 | **Safe Execution & Environment Validation** | `analysis` (öngörü), `sandbox_test` (desteklenen izole gerçek test), `preview` (değişiklik farkı), `apply` (kapsamlı onay) modları; işlem türüne özel doğrulayıcılar; **Resilience & Chaos Testing** kontrollü alt modülü | eBPF sandbox değildir; chroot tam izolasyon değildir; container üretim ortamını birebir taklit etmez; kaos testleri varsayılan kapalı ve izole/staging hedefe sınırlı | Çok yüksek; AD1-06 ile entegre |
| AD1-16 | **Distributed Operation Orchestration** | Kullanıcının AI'ının önerdiği planı merkezi Gateway/Orchestrator'ın sıralaması; hedef bazlı izin, bağımlılık grafı, kademeli yürütme, iptal, tekil sonuç ve doğrulama | Agent'lar kendi AI'larıyla karşılıklı emir vermez; yetki merkezi olarak doğrulanır; yanlış hedefe toplu değişiklik ve race koşulları önlenir | Yüksek; AD1-01/08 ile entegre |
| AD1-17 | **Hardware-Backed Identity & Attestation** | İsteğe bağlı TPM/HSM destekli cihaz anahtarı koruması, donanım/ölçüm attestation ve uygun platformlarda TEE adaptörü; yazılımsal güvenlik varsayılan temel | HSM/TPM/SGX/SEV eşdeğer değildir; host ele geçirilmesine karşı mutlak garanti yok; zorunlu özel donanım veya ücretli hizmete bağımlılık oluşturulmaz | Kurumsal/sonraki faz; AD1-13 ile entegre |
| AD1-18 | **Infrastructure Digital Twin & Scenario Analysis** | Tam sistem kopyası yerine servis, ağ, topoloji, kaynak ve bağımlılıkları temsil eden güncel hafif dijital model; seçili izole senaryo testi ve ölçümlere dayalı etki aralığı | Firecracker/micro-VM zorunlu değil; canlı DB/trafik birebir modellenmez; gecikme ve başarısızlık kesin tahmin edilemez; simülasyon gideri ve veri gizliliği sınırlandırılır | Yüksek; AD1-04/12/15 sonrası |
| AD1-19 | **Infrastructure Optimization Workbench** | Kullanıcının AI'ının hazırladığı maliyet/performans/güvenlik önerilerini yapılandırılmış değişiklik planı, diff, deney, onay, sonuç ölçümü ve geri alma ile doğrulama | Kendiliğinden kernel derleme, Dockerfile/DB şema değiştirme veya otonom altyapı yeniden yazma varsayılan ve hedef davranış değil | Orta; AD1-11/14/15/18 sonrası |
| AD1-20 | **Kernel Observability & Runtime Security** | Linux Agent için opsiyonel eBPF destekli süreç/ağ/I/O gözlemleme ve güvenlik olayları; Windows/macOS için ayrı platform adaptörleri | Sıfır performans kaybı, bütün syscall/paket/byte'ı sınırsız izleme veya tüm zero-day'leri bulma garantisi yok; kernel/sürücü uyumluluğu ve en az yetki | Yüksek, opsiyonel; AD1-04/07/13 ile |
| AD1-21 | **Privacy-Preserving AI Access** | Veriyi mümkün olduğunca hedef cihazda veya güvenilir yönetim katmanında işleyip sınıflandırma, redaksiyon, salt-okunur sınırlı sorgular, özetler ve kullanıcıya ait AI'a en az gerekli bağlamı verme | ZKP, LLM'in gizli ham veriyi matematiksel kanıttan anlamasını sağlamaz; anonimleştirme garantisi verilmez; KVKK/GDPR/HIPAA uyumu otomatik iddia edilmez | Çok yüksek; AD1-12/13/17 ile |

**Not:** Desktop Commander ile karşılaştırmada “tek cihaz destekler”, “metrik sunamaz” veya “yalnız blacklist kullanır” gibi iddialar, güncel resmî kaynakla doğrulanmadıkça ürün gerçeği olarak kullanılmaz. Multi-device desteği tek başına farklılaştırıcı sayılmaz.

## 4. Önerilen aşamalar — eşdeğerlik sonrasında

### Aşama 1 — Gözlem ve açıklanabilirlik (salt okunur)
- AD1-04 telemetri, AD1-05 güvenli log filtreleme, AD1-12 kanıt/bağlam paketleri; AD1-07 için basit oran/eşik tespit verileri.
- **AD1-21 Privacy Gateway** tasarımı bu aşamanın güvenli veri erişim temeli: hassas bilgiyi yerel/izinli işlemden önce sınıflandır, asgari veri ve izinli alanları AI istemcisine çıkar, maskeleme doğrulamasını tut.
- AD1-20'ye hazırlık: temel platform gözlemini önce sıradan Agent mekanizmalarıyla sağla; eBPF'yi sadece opsiyonel derinleştirme olarak değerlendir.
- Büyük loglarda streaming/regex/istatistik önceliklidir; zorunlu yerel AI modeli veya vektör veritabanı yoktur.
- AI'a yapılandırılmış araç sonucu: `target_id`, `observed_at`, `source`, `measurement`, `confidence/limitations`, `pagination`, `redacted`.
- Başarı ölçütü: kaynaklar denetlenebilir, hassas veri sızmaz, büyük veride bounded çıktı ve pozitif/negatif E2E.

### Aşama 2 — Kapsamlı ama kontrollü yönetim
- AD1-01 çoklu hedef, AD1-02 Docker, AD1-03 servis yönetimi, AD1-06 etki/onay.
- **AD1-18** başlangıcı: tam ortam kopyası olmadan topoloji ve bağımlılık temelli dijital model; seçilmiş test senaryolarında AD1-15 izolasyonuna bağlanır.
- AD1-14 kapsamında önce WECOMMANDER tarafından yapılan izinli dosya/konfigürasyon değişiklikleri için otomatik sürüm kaydı ve geri alma; AD1-15 için analysis/preview, yalnız desteklenen işlemler için sandbox_test ve açık onaylı apply. Bunlar operasyonların güvenli uygulamasının önkoşuludur.
- Önce salt-okunur araçlar; ardından hedefe bağlanan ve risk seviyesi belirlenen tekil değişiklikler; ancak sonra toplu değişiklik.
- Başarı ölçütü: yanlış hedef/tenant reddi, dry-run iddiası doğru, kademeli dağıtım, audit ve sonuç doğrulaması.

### Aşama 3 — Olaylar ve güvenli otomasyon
- AD1-07 olay/uyarı, AD1-08 kurala/runbook'a dayalı iyileştirme ve AD1-16 merkezî, bağımlılık farkındalıklı operasyon orkestrasyonu.
- **AD1-15 Resilience & Chaos Testing**: hipotez, kapsam, kill switch, gözlem, otomatik durdurma ve geri dönüş planıyla yalnız kullanıcının seçtiği izole/staging ortamında kontrollü deney; üretim ortamında rastgele kesinti veya saldırgan otomasyon yok.
- **AD1-19**: önerileri kullanıcı AI'ı hazırlar; WECOMMANDER karşılaştırır, test eder, onayla uygular ve ölçerek doğrular. Kendiliğinden mimari/genetik algoritmalı yeniden yazma yok.
- AD1-14 ikinci aşama: WECOMMANDER dışındaki değişikliklerin opsiyonel salt-okunur gözlemi ve platformun gerçekten desteklediği snapshot adaptörleri; her değişiklik otomatik geri alınabilir iddiası yok.
- Otomasyon varsayılan kapalı; düşük riskli ve açıkça izinli işlemlerle başlanır; yüksek riskte kullanıcı onayı korunur.
- Başarı ölçütü: döngü önleme, rate limit, iptal, geri dönüş ve güvenli hata modu.

### Aşama 4 — Harici altyapı entegrasyonu
- AD1-09 SSH/SFTP, AD1-10 Kubernetes, AD1-11 IaC ve AD1-13 opsiyonel erişim adaptörleri; AD1-17 opsiyonel donanım kimliği/attestation adaptörleri.
- **AD1-20 Kernel Observability**: Linux eBPF adaptörü yalnız desteklenen kernel/izinlerde ve ölçülmüş kaynak bütçesiyle; Windows/macOS eşdeğer veri için platforma özgü araçlar. Kernel-level otomatik freeze/karantina varsayılan kapalıdır.
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

## 4.2 Onaylanan yeni fikirlerin teknik çerçevesi (v0.3)

### AD1-18 — Infrastructure Digital Twin & Scenario Analysis
- **Birinci dilim:** Servis/bağımlılık grafı, cihaz ve ağ bağlantı envanteri, telemetri zaman damgaları, gözlemin güvenilirlik derecesi, maliyetli tam klon yerine salt-okunur hafif model. Kaynak verinin eskiliği ve eksikliği raporda görünür.
- **İkinci dilim:** AD1-15 ile uyumlu belirli servis/config değişikliklerinin yalıtılmış senaryoları; aşırı trafik veya yük olayları için ölçülmüş veriyle tahmin aralıkları. Firecracker opsiyonel olabilir; zorunlu runtime bağımlılığı yapılamaz.
- **Kabul:** Eskimiş ölçüm, farklı gerçek/topoloji modeli, hassas veri, yüksek load, kapasite aşımı ve sahte kesinlik durumları; etki tahmini asla deterministik üretim garantisi diye sunulmaz.

### AD1-19 — Infrastructure Optimization Workbench
- **Akış:** Kullanıcının AI'ı veya operatör alternatifleri önerir → WECOMMANDER adayları ayrı sürümlü değişiklik planlarına dönüştürür → maliyet/performans/güvenlik ölçütleriyle kıyaslar → AD1-15 test/preview + AD1-14 rollback hazırlığı → yetkili kullanıcı onayı → güvenli apply ve son durum ölçümü.
- **Sınır:** AI hiçbir ek onay olmadan kernel derlemez, veritabanı parçalamaz veya üretim altyapısını “genetik evrim” adına değiştirmez.
- **Kabul:** Çelişen performans/maliyet hedefleri, hatalı öneriler, kısmi apply, bağlantı kopması, kaynak kilidi, geri alma sınırlılığı ve tekrarlı çağrı testleri.

### AD1-20 — Kernel Observability & Runtime Security
- **İlk dilim:** Opsiyonel Linux eBPF tabanlı süreç, ağ ve I/O olayı/sayaçlarını örneklemeyle topla; bounded arabellek, kaynak/kapasite sınırları, veri redaksiyonu, açık yönetici izni ve feature probing.
- **Güvenlik:** Kernel/eBPF erişimi yüksek ayrıcalık isteyebilir; başarısız yüklemelerde Agent çalışmaya devam eder; desteklenmeyen OS/kernel için açıkça unavailable yanıtı döner. Tam syscall/paket/disk izlenebilirliği ya da sıfır overhead/zero-day tespit garantisi yok.
- **Kabul:** Düşük kernel sürümü, yetkisiz eBPF load, hata/sonlandırma, sayaç kaybı, kaynak baskısı, platform farkı ve yanlış pozitif testleri.

### AD1-21 — Privacy-Preserving AI Access
- **Birinci dilim:** Hassas verinin sınıflandırılması, izinli alan şemaları, maskeleme/redaksiyon, kullanıcı/tenant/policy bazlı veri minimizasyonu, yerel güvenli agregasyon ve AI'a kontrollü bağlam API'si.
- **Örnek:** SSH başarısız giriş artışına ait sayısal trendi sunarken izin verilmedikçe IP, kullanıcı kimliği, anahtar ve ham loglar dışarı taşınmaz. Sırlar yanlışlıkla alanlarda veya hata mesajlarında bulunabilir; fail-closed kontroller gerekir.
- **Teknik sınır:** ZKP belirli ifadelerin doğru olduğunu kanıtlar; harici LLM'in gizli ham veriyi anlamasını sağlamaz. ZKP/TEE yalnız somut, doğrulanabilir ihtiyaç varsa opsiyonel modül olabilir. “KVKK/GDPR/HIPAA uyumu garantilidir” denmez.
- **Kabul:** PII/sır sızdırma, çoklu alan birleştirmesiyle yeniden kimliklendirme, prompt injection, yanlış actor/tenant, ayrıntılı hata/log dönüşü, audit veri kapsamı ve sahte redaksiyon negatif testleri.

### AD1-15 alt modülü — Resilience & Chaos Testing
- **Ön koşul:** AD1-15 güvenli ortam doğrulama, AD1-14 geri alma sınırları, AD1-04 sağlık ölçümleri. Varsayılan kapalıdır; kullanıcının açıkça seçtiği deney kapsamı, görev süresi, tekrarlama üst sınırı, durdurma ve acil iptal mekanizması zorunludur.
- **Aşama:** Önce staging/izole ortamda kontrollü servis kapanması, ağ gecikmesi, kaynak kısıtlama gibi düşük riskli ve geri alınabilir deneyler; üretimde otomatik rastgele saldırı, disk doldurma, honeypot açma veya kendiliğinden hot-patching yok.
- **Kabul:** Deneyin yanlış hedefe gitmesi, kill switch başarısızlığı, ölçüm eksikliği, beklenmedik kesinti, onay iptali, kaynak kota aşımı ve eksik geri alma testleri.

## 4.3 Karar/yürütme mimarisinin merkezi ilkesi

WECOMMANDER'ın kalbi “asla çökmeyen otonom karar veren AI” değildir; **Deterministic Policy & Execution Engine** olarak tanımlanır: AI'dan gelen veya operatörün oluşturduğu araç isteği → sözleşme/schema doğrulama → actor/tenant/device/policy/risk ve tek-kullanımlık onay → gerekiyorsa analiz/preview/izole test → idempotent ve sınırlandırılmış Agent yürütmesi → çıktı denetimi, audit, sonraki durum doğrulama, desteklenen rollback. Deterministik güvenlik kararı hedeflenir, sıfır hata veya mutlak canlılık garantisi verilmez.

**Sorumluluk ayrımı:** Kullanıcının AI'ı önerir/değerlendirir; WECOMMANDER doğrular/yetkilendirir/yürütür/denetler; kullanıcı kritik değişikliklerin kontrolünü tutar. Üçüncü taraf LLM, donanım, vektör veritabanı, Firecracker veya bulut platformu çekirdeğin çalışması için zorunlu değildir.

**Önerilen değer önceliği (eşdeğerlikten sonra):** AD1-21 veri gizliliği → AD1-20 opsiyonel derin gözlem → AD1-18 hafif dijital ikiz → AD1-19 karşılaştırmalı optimizasyon; kontrollü dayanıklılık testleri AD1-15'in alt modülüdür. Bu sıralama AD1-14 Time Machine ve AD1-15 Safe Execution için daha önce verilmiş erken güvenlik önceliğini ortadan kaldırmaz; teknik bağımlılıklara göre düzeltilebilir.

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
- **v0.3 kapsam kararı:** AD1-18 Dijital İkiz, AD1-19 Optimizasyon, AD1-20 Opsiyonel Kernel Gözlemi ve AD1-21 Gizlilik Koruyan AI Erişimi plana dahil edildi. Resilience & Chaos Testing, AD1-15'in kontrollü alt modülü olarak belirlendi; “kuantum karar”, “otonom genetik yeniden yazma”, “sıfır overhead”, “her zero-day'i yakalama”, “ZKP sayesinde LLM'in gizli içeriği anlaması” veya “asla çökmeyen motor” iddiaları teknik taahhüt olarak kabul edilmedi.

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
12. Privacy Gateway hangi veri türlerini varsayılan olarak tamamen yerelde tutacak; kullanıcı hangi alanları AI istemcisine açabilecek?
13. Dijital ikizin ilk sürümünde hangi servis/topoloji/bağımlılık katmanları izlenecek ve tahminler nasıl kalibre edilecek?
14. eBPF'nin hedef Linux kernel ve gerekli ayrıcalık matrisi nasıl belirlenecek; yetkisiz sunucularda hangi salt-okunur alternatifler kullanılacak?
15. Optimizasyon önerilerinin maliyet, SLO, güvenlik ve enerji hedefleri hangi politikalarla karşılaştırılacak?
16. Kontrollü kaos deneylerinde laboratuvar/staging kimliği ve acil durdurma nasıl doğrulanacak?

## 7. Değişiklik geçmişi
- **v0.3 — 2026-10-24:** Kullanıcı onayıyla AD1-18 hafif dijital ikiz, AD1-19 insan kontrollü altyapı optimizasyonu, AD1-20 opsiyonel Linux eBPF gözlemi ve AD1-21 veri gizliliği koruyan AI erişimi eklendi. Kaos/dayanıklılık testleri AD1-15 altına alındı; deterministik politika/yürütme mimarisi ve teknik garanti sınırları belirtildi. Eşdeğerlik planı ve saatlik görev kuyruğu değiştirilmedi.
- **v0.2 — 2026-10-24:** Kullanıcı onayıyla AD1-14 Time Machine, AD1-15 Safe Execution, AD1-16 Distributed Operation Orchestration ve AD1-17 Hardware-Backed Identity adayları plana eklendi. AD1-04/05/07/12 akış analitiği ve anomali odaklı genişletildi. Time Machine başlangıcı WECOMMANDER işlemleriyle sınırlandı. Mevcut eşdeğerlik geliştirmesinin önceliği değişmedi.
- **v0.1 — 2026-10-24:** İlk tartışma taslağı. AI bağımsızlığı, sorumluluk ayrımı, 13 öneri ve 4 önerilen aşama kaydedildi.
