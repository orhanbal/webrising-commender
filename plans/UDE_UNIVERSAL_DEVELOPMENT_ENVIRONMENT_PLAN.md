# WECOMMANDER UDE — Universal Development Environment
## İsteğe bağlı geliştirme ve deney ortamları modülü — ürün ve teknik geliştirme planı

**Durum:** ONAYLANMIŞ GELİŞTİRME PLANI / TASARIM; **uygulama başlamadı, hiçbir çalışma ortamı dağıtılmadı**.  
**Karar tarihi:** 19 Kasım 2026  
**Ürün:** WECOMMANDER (ayrı uygulama veya ayrı sunucu ürünü değil)  
**Kısa ad:** UDE — Universal Development Environment  
**Yönetim yüzü:** Workspaces; Core'un yanında, isteğe bağlı modül.  
**İlişkili belgeler:** [İleri Geliştirme Planı 1](ADVANCED_DEVELOPMENT_PLAN_1.md), [v1.2+ yol haritası](V1_2_PLUS_ROADMAP.md), [Desktop Commander eşdeğerlik planı](DESKTOP_COMMANDER_PARITY_PLAN.md).

> **Değişmez karar:** WECOMMANDER Core tek başına eksiksiz bir uzak sistem yönetimi ürünü olmaya devam eder. **UDE, Core'u kullanır; Core, UDE'ye bağımlı olmaz.** UDE kullanılmadığında veya kurulmadığında mevcut Agent/User modları, terminal, PTY, dosya, süreç, cihaz eşleme, MCP, onay ve denetim akışları hiçbir UDE çalışma zamanı bağımlılığı olmadan çalışır.

## 1. Sorun, ürün hedefi ve sınır

- **Sorun:** Geliştiricinin mevcut Windows/macOS/Linux bilgisayarını ya da izinli uzak sunucusunu projeye özgü, doğrulanabilir, yeniden oluşturulabilir bir çalışma ortamına dönüştürmesi WSL, container runtime, dil araçları, DB, IDE, sırlar ve izinler arasında parçalı ilerler.
- **Hedef:** Yetkili kullanıcı, mevcut WECOMMANDER cihazından hedef seçer, ortam şablonu (ör. Python + PostgreSQL) seçer, **ön koşul / kaynak / izin / risk planını** görür, onaylar ve izole çalışma ortamının kurulumunu ve sağlığını yönetir.
- **Ürünleşme:** Yerel ve uzak kullanıcı cihazları ilk sınıf hedeflerdir; başka bir zorunlu bulut hesabı, LLM, ücretli servis veya yeni WECOMMANDER dağıtımı yoktur.
- **Asıl farklılaşma hipotezi:** Core'un hâlihazırda bağladığı cihazları, mevcut güvenlik modeli ile *aynı panelden* onaylı, denetlenebilir, sökülebilir geliştirme kapasitesine dönüştürmek. Bu hipotez rakiplerle saha testinde doğrulanmadan kanıtlanmış üstünlük sayılmaz.
- **Kapsam dışı (MVP):** yeni container/VM motoru geliştirmek; genel amaçlı paket yöneticisi yazmak; Kubernetes, GPU zamanlayıcısı veya dağıtık iş yürütme; otomatik güvenilmeyen-kod çalıştırma; herkes için tam VM taşınabilirliği; production sistemde doğrudan otomatik kurulum.

## 2. Mimari ve modül sözleşmesi

```text
WECOMMANDER UI / MCP (mevcut)
    |-- CORE: Agent/User modes, device/FS/process/PTY, identity/approval/audit (UDE'siz çalışır)
    |
    +-- UDE (feature gate: opt-in; kapalıyken hiçbir UDE işi/servisi çalışmaz)
          |-- Workspace API + Orchestrator (Gateway üzerinden yetki, idempotency, audit)
          |-- Template Registry (sürümlü, kaynağı doğrulanan şablonlar)
          |-- Capability & Preflight (salt okunur)
          |-- Runtime Adapters (WSL2/Dev Containers ilk; Linux containers sonraki)
          |-- Workspace Lifecycle (plan, provision, verify, start, stop, delete)
          |-- Workspace Terminal/FS/Logs (mevcut Core araçlarını yetkili kapsamla kullan)
          +-- Workspace Resources/Secrets/TTL (CPU, RAM, disk, ağ, scope)
```

- **Bağımlılık yönü:** `UDE -> Core APIs`, tersine bağımlılık yok. UDE'nin yokluğu Core migration, agent pairing, MCP schema, session veya UI davranışını bozmaz.
- **Agent:** Mevcut Rust Agent üzerinden sınırlı yetenek saptama ve UDE için ayrı, tipli workspace operasyonları; ham `process_exec` bütün güvenlik mimarisinin yerine geçemez. Yetki kontrolleri Agent ve Gateway taraflarında; onay sunucu tarafında doğrulanır.
- **Gateway:** Tenant / actor / device / workspace kaynaklarını ayırır; uzun süren işleri duruma dayanıklı iş kayıtlarında izler. Agent yeniden bağlanma, timeout, duplicate/retry ve power loss sonrasında belirsiz operasyonu `unknown/reconcile_required` olarak işaretler; kör tekrar yapmaz.
- **Platform adaptörleri:** MVP: Windows 11 + WSL2 içinde Dev Container/Compose; sonraki aşama Linux (rootless container mümkünse), macOS için VM/container sağlayıcısı; bir platformda desteklenmeyen özellik `unavailable`, Core hatası değil.
- **Şablonlar:** `devcontainer.json`, Dockerfile, Compose gibi yaygın, açık standartlardan yararlan; şablon tarifi ile çalışma zamanı ayrılır. Her şablonda id/sürüm, kaynak digest, platform gereksinimleri, açık portlar, volume mount'lar, tahmini kaynak ve temizleme planı bulunur.
- **AI:** Tamamen isteğe bağlı harici MCP istemcisi veya kullanıcı AI sağlayıcısı; UDE'nin kendi LLM'ine ihtiyacı yoktur. WRH ajan harness'i gerekirse tüketici olabilir, temel çalıştırma altyapısına bağlanmaz.

## 3. Kullanıcı deneyimi

1. **Cihaz seç:** WECOMMANDER içinden izinli Windows/Linux/macOS hedefi belirle.
2. **UDE yetenek kontrolü:** OS/sürüm, CPU/RAM/disk, sanallaştırma, WSL/container runtime, mevcut servisler, izinler, kurulum alanı; *salt okunur* gözlem.
3. **Şablon seç:** Python + PostgreSQL (MVP); sonrasında Node.js, Rust, test laboratuvarı, AI ajan laboratuvarı.
4. **Plan ve onay:** İndirilecek bileşenler, kaynaklar, ağ erişimi, mount'lar, host etkisi, ayrıcalıklar ve temizleme sınırları gösterilir. Gerekli runtime kurulu değilse otomatik host kurulumu yapılmaz; kullanıcıya ayrı, yüksek-risk onaylı önkoşul işi sunulur.
5. **Provision + doğrula:** İzole ortam oluşturulur; container/service health, Python/test ve PostgreSQL bağlantısı doğrulanır.
6. **Kullan/yönet:** Aynı WECOMMANDER panelinde terminal, dosyalar, servisler, kullanım, durdur/başlat ve kontrollü silme.
7. **Silme:** Sadece workspace'e ait kaynaklar; proje/volume verisi silinmeden önce açık kapsam ve ayrı onay. Host genelinde temizleme yok.

**UI:** UDE etkin değilse ana kullanıcı akışlarına yeni zorunlu adım ekleme; tercih edilen sade Core arayüzünü koru. Menünün görünümü ürün tasarım kararıdır, etkinleştirme varsayılanı `off`.

## 4. MVP senaryosu ve teknik kontrat

**MVP hedef:** Yetkili Windows 11 cihazında UDE üzerinden tek bir Python + PostgreSQL geliştirme ortamını güvenli kur, test et, kapat, yeniden başlat ve sil. Mevcut projelere, mevcut WSL dağıtımlarına ve üretim verilerine dokunma.

**Durum makinesi:** `draft -> preflighted -> approval_required -> provisioning -> verifying -> ready -> stopped -> deleting -> deleted`; hata durumları `failed`, `unknown/reconcile_required`, `blocked`. Her geçiş actor/device/workspace kimliği, politika sürümü, şablon digest'i, giriş özeti, başlama-bitiş zamanları, sonuç kodu ve idempotency key ile kayıtlanır.

**İlk API / MCP operasyonları (öneri, henüz uygulanmış değil):**
- `ude_capabilities(device_id)` — yalnız gözlem, sınırlar.
- `ude_templates_list()` — doğrulanmış sürümlü kataloğu listele.
- `ude_workspace_plan(device_id, template_id, version, options)` — etkiler, ön koşullar, izinler; **dry-run garantisi vermez**.
- `ude_workspace_create(plan_id, approval)` — yüksek riskli host etkilerinde ayrı onay, kaynak kotaları.
- `ude_workspace_status(workspace_id)` — yapılandırılmış ilerleme, health, aşama, redakte edilmiş hata.
- `ude_workspace_start/stop(workspace_id)` — kontrollü yaşam döngüsü.
- `ude_workspace_delete(workspace_id, approval)` — planlanmış kaynakları sil; persistent volume için ayrı seçenek/onay.
- `ude_workspace_open(workspace_id)` — Core terminal/FS erişimini workspace kapsamına daralt.

**Başlangıç şablonları:** `python-postgres` (minimum), `python-basic` (PostgreSQL gerektirmeyen hafif deney). Her şablonda çalışır smoke test, dependency lock/digest ve port/volume listesi bulunur.

## 5. Koruma politikaları — vazgeçilmez kabul kriterleri

1. **Core'a sıfır zorunlu bağımlılık:** UDE kapalı, runtime kurulmamış veya UDE çökmüşken Core terminal/FS/process/bağlantı/Agent/User/MCP eskisi gibi çalışır.
2. **Production varsayılan yasak:** Host root/Administrator, yetkisiz path, Docker socket bind, host network, privileged container, hassas volume, production DB ve kullanıcı SSH/private key mount istekleri açıkça reddedilir veya özel üst düzey onaya bağlanır; MVP'de riskli seçenekler desteklenmez.
3. **Workspace sınırları:** Her workspace için kaynak (CPU/RAM/disk), işlem süresi, ağ çıkışı, dosya kökü, izinli portlar ve eşzamanlılık sınırı. Container izolasyonu güvenilmeyen kod için güçlü güvenlik sınırı olarak pazarlanmaz; bu kullanım için ayrı VM güvenlik katmanı tasarlanır.
4. **Kaynak kimliği / izin:** Tenant, actor, target device, workspace ID ve template digest bağlanır. Başka tenant/workspace'e erişim negatif E2E ile reddedilir. Gateway onay token'ları tekrar kullanılamaz.
5. **Sırların korunması:** Sırlar şablon dosyalarına, komut dizelerine, stdout/audit'e, Git deposuna veya görüntülere yazılmaz. Geçici credential, redaksiyon, scope, rotasyon/silme.
6. **İndirilen içerik:** Yalnız resmî paket kanalları/doğrulanmış şablonlar, pinned sürüm/digest; imzalar destekleniyorsa doğrula; imzasız kaynaklara göre risk sınıflandırması.
7. **Önkoşul izni:** WSL2/VM özelliği, host genelinde Docker kurulumu, reboot veya sistem politikası değişikliği workspace create kapsamında sessizce yapılmaz; ayrı kullanıcı onayı ve plan gerektirir.
8. **Silme ve geri dönüş:** Operasyon sırasında yaratılmış dosya, container, network ve volume açıkça kayıtlanır. Dış sistem etkilerinin veya genel shell komutlarının tam rollback garantisi verilmez. Kısmi temizlik görünür.
9. **Kaynak durumu:** Ağ kesintisi/retry/cancel/agent yeniden bağlanması/elektrik kesintisi altında çift kurulum yapılmaz; belirsiz durum otomatik uzlaşma gerektirir.
10. **Geçiş güvenliği:** Plan sonrası host durumu değişirse `create` işlemi yeniden doğrulama/onay ister (TOCTOU).
11. **Uygulama güvenliği:** Uzun süreçler Core gateway thread/PTY limitini tüketmez; UDE çökerken Core servisleri ayakta kalır.
12. **Ölçüm:** Kurulum başarı oranı, P50/P95 hazırlık süresi, kaynak israfı, temiz silme oranı, Core regresyon sayısı ve yetki ihlali sayısı raporlanır.

## 6. Aşamalı teslim planı (mevcut Core yol haritasını yeniden sıralamaz)

| Aşama | Kod | Kapsam | Çıkış kapısı |
|---|---|---|---|
| **P0: tasarım/kabiliyet** | UDE-01 | ADR, feature gate, Core sınırları; salt okunur OS, runtime, kaynak tespiti | UDE `off` Core paritesi; Windows 11 preflight kanıtı |
| **P0: güvenli plan** | UDE-02 | Şablon registry, digest, plan/impact/approval sözleşmesi | Yetkisiz/privileged/mount/production reddi |
| **P0: ilk çalıştırma** | UDE-03 | Tek Windows 11 + WSL2/Dev Containers Python/PostgreSQL ortamı | İlk kurulum ve test; yeniden başlatma; veri/port izolasyonu |
| **P0: yaşam döngüsü** | UDE-04 | Start/stop/status/delete; kaynak envanteri; duplicate/cancel/reconcile | Delete yalnız sahipli kaynaklar, Core sağlam |
| **P0: UI & MCP** | UDE-05 | İsteğe bağlı Workspaces yüzü; mevcut terminal/FS entegrasyonu | UDE kapalı/açık UX, bütün işlemlerde risk/audit |
| **P1: taşınabilirlik** | UDE-06 | Linux container/rootless; macOS adaptörü; farklı runtime yetenek matrisi | Gerçek cihaz E2E, desteklenmeyende doğru unavailable |
| **P1: Git & ekip** | UDE-07 | Git deposundan şablon/çalışma, proje snapshot export, ekip rolleri | Namespace/secret sınırı, import/export doğrulaması |
| **P1: Agent sandbox** | UDE-08 | Kullanıcı AI için ayrı workspace yetkileri, isteğe bağlı izole AI laboratuvarı | Modelden bağımsız sınır ve negatif güvenlik testleri |
| **P2: ileri özellikler** | UDE-09 | Opsiyonel uzak GPU/bilgisayar hesaplama adaptörü, ağır test çalıştırma | Kaynak planlama + izin + maliyet ve veri izolasyonu |
| **P2: ekosistem** | UDE-10 | Şablon kataloğu, imza/inceleme, paylaşım; istenirse ticari takım özellikleri | Supply-chain güvenliği ve işletme maliyeti kanıtı |

**Sürüm kararı:** UDE'ye henüz v1.2 / v1.3 / v2.x sürüm ataması yapılmaz. Önce mevcut v1.x / eşdeğerlik güvenlik kapıları ve UDE-01/02 fizibilite kapıları incelenir. Planı eklemek, geliştirmeyi otomatik başlatmaz veya mevcut kritik iş kuyruğunun önceliğini değiştirmez.

## 7. İlk pilot: WECOMMANDER ile Windows bilgisayarında araştırma laboratuvarı

- **Referans:** Kullanıcının seçtiği yönetilen Windows 11 cihazı; VENTURE/CONTENT gibi gerçek üretim/kullanıcı cihazlarında yalnız mevcut WECOMMANDER policy allowlist'i ve yeni UDE yetkileri içinde çalış.
- **Denetim:** Halihazırdaki WSL, container, Python ve PostgreSQL kurulumunu salt okunur incele; sistem genelini yeniden kurma.
- **Ortam:** `unth-lab` adlı yeni workspace; Python ve pytest smoke testi; PostgreSQL yalnız seçildiğinde, izole ve sentetik veriyle.
- **Başarı:** Kullanıcı panelden hazırlık planı görür; açık onayla yaratır, test çıktısını görür, stop/start yapar ve yalnız workspace'e ait kaynakları siler. Başka proje/WSL dağıtımı/data/credential değişmez.
- **Başarısızlık / stop kriteri:** Mevcut proje verisine dokunma, kontrolsüz host etkisi, Core işlevlerinde regresyon, izinsiz silme, kaynak limitlerinin aşılması veya belirsiz durumun başarılı gösterilmesi.

## 8. Test matrisi ve kabul paketleri

- **Fonksiyonel:** plan->onay->create->verify->stop->start->delete; temiz ve eksik-önkoşullu host; offline/yeniden bağlanma; template/digest versiyon farkı.
- **Negatif güvenlik:** farklı tenant/device/workspace, yanlış izinli root, token replay, port çakışması, kötü amaçlı mount, secrets stdout, privileged container, yanlış digest, host Docker socket.
- **Dayanıklılık:** yarım kurulum, disk dolu, düşük RAM, başarısız indirme, timeout, çift tıklama, yarış durumları, güç kesintisi, yarım kalan silme.
- **Uyumluluk:** UDE `off` ile mevcut Rust Agent/Gateway/PTY/FS/process/MCP/Agent/User akışları için regresyon; tüm desteklenen OS build ve CI paketlerinde bozulma yok.
- **Kanıt:** Test komutları, commit SHA, cihaz OS bilgisi, şablon digest, iş ID, gerçek loglar, redakte edilmiş audit, E2E sonuçları ve bilinen sınırlamalar. Önceki CI sonucunu yeni HEAD'e devretme.
- **Go/No-Go:** P0 maddeleri ancak bütün bu kapılar kanıtlanınca 'tamamlandı' sayılır. Gerçek cihaz E2E yoksa 'beklemede'; ürün/panel taslağı gerçek özellik diye sunulmaz.

## 9. Kararlar, bağımlılıklar ve uygulama öncesi sorular

**Kesinleşenler:** Ad `UDE = Universal Development Environment`; WECOMMANDER içi isteğe bağlı Workspaces modülü; Core değişmeden kullanılabilir; mevcut bağlantı, yetki, onay, denetim, Agent ve User modları korunur; model/provider bağımsızlık; önce Windows 11 pilotu; açık standartlardan yararlanma.

**İleride netleştirilecekler:** sürüm/milestone ve ticari paketler; UI navigasyonunun kesin tasarımı; runtime provider seçiminin gerçek makine testi; VM düzeyinde güvenilmeyen-kod sandbox kapsamı; workspace başına saklama süresi/retention; Git/AI ajan/GPU ileri faz kapsamı.

**Bağlantılı mevcut işler:** AD1-02 Docker, AD1-06 risk/onay, AD1-13 cihaz güvenliği, AD1-14 güvenli geri alma, AD1-15 sandbox/validation, AD1-16 orchestrator; UDE bu çalışmaların tamamlandığını varsayamaz. Mevcut Core plan ve sürüm kapıları önceliklidir.
