## 24 Ekim — Bölgesel relay arama iptali (1A, A/B/C/D)

- **A:** Giriş `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) 17/17 başarılı; üretim, fiziksel cihaz ve dış MCP kabulü yapılmadı.
- **B:** `91506f9e` — `DeviceRouter` bölgesel relay isteklerine eşsiz UUID ekler; `AbortSignal` geldiğinde ayrı **imzalı** `/internal/relay/cancel` çağrısını kullanır. Uzak `AgentHub` cancel sinyalini native Agent'a iletir. Asıl HTTP isteği kooperatif bitişe kadar bekler; eşzamanlı tarama kotası erken boşaltılmaz.
- **C:** `relay-cancellation.ts` — farklı sırada ulaşan cancel/request çağrıları için TTL'li ve kapasiteli erken iptal kaydı; `requestId + deviceId` eşleşmesi, çakışma ve yanlış cihaz testleri. Bölgesel relay E2E'ye unsigned cancel=401, gerçek MCP start/stop/page yarış testi eklendi.
- **D:** Bu belge güncellemesinin **yeni HEAD CI sonucu PENDING**. Canlı uzun süren bölgesel arama üzerinde iptal süre/maliyet benchmark'ı, streaming ve pause/resume ile 1B kalıcı oturum **PENDING**; genel eşdeğerlik **PENDING**. 

# WECOMMANDER — Saatlik eşdeğerlik iş kuyruğu

## 13.11–13.25 A/B/C/D ilerleme kaydı — 24 Ekim 2026

- **A / PASSED (giriş):** `7d4ff46b` için [CI #40081678744](https://github.com/orhanbal/webrising-commender/actions/runs/40081678744) **17/17 PASS**; [platform #40082053980](https://github.com/orhanbal/webrising-commender/actions/runs/40082053980) PASS. Rust, Agent E2E ve integration job logları incelendi; giriş HEAD'inde kırmızı iş yoktu.
- **B / PENDING (1A native cancellation):** `c602a7ad` ile Rust Agent aramaları `spawn_blocking` üzerinde çalışıyor; istek bazlı `AtomicBool` iptal bayrağı tarama döngüsü/dizin/satır sınırlarında kontrol ediliyor. WebSocket `cancel` geldiğinde search task'ı körlemesine abort edilmek yerine kooperatif çıkış yapıyor; disconnect/shutdown bayrakları temizliyor. Pre-cancelled Rust negatif testi eklendi.
- **C / PENDING (1A Gateway cancel iletimi):** `0ad37183` ile `stop_search` → AbortSignal → local AgentHub → WebSocket `cancel` → native Agent zinciri kuruldu. Gateway in-flight kotası, Agent yanıtı veya timeout gelene kadar korunuyor; sonuçlar stop sonrası geri dönmüyor. Actor/device izolasyonu korunuyor. Gateway negatif yarış testi eklendi.
- **D / PASSED (ara kod kontrolü):** `4071130f` rustfmt, `6f3eca4f` clippy ExecutionContext ve `523e532e` biçim düzeltmeleri. [CI #40085512074](https://github.com/orhanbal/webrising-commender/actions/runs/40085512074) kod HEAD'i için başlatıldı; son durum ayrıca kontrol edilmeli. İlk CI kırmızıları (fmt/clippy) düzeltildi.
- **Açık 1A:** Gerçek streaming ve pause/resume yok. Yerel relay için fiziksel iptal uygulanmış olsa da uçtan uca yavaş tarama sırasında durdurma testi ve bölgesel relay üzerinden iptal iletimi henüz doğrulanmadı; bu nedenle 1A **PENDING**.
- **Açık 1B:** PostgreSQL kalıcı arama oturumu ve restart sonrası actor/tenant/device izolasyonu **PENDING**. `stop_search` ile durdurulmuş snapshot hiçbir koşulda tekrar görünür olmamalı.
- **BLOCKED_EXTERNAL:** Gerçek Windows/macOS/Ubuntu fiziksel kurulum, canlı ChatGPT/Claude ve Windows/Apple imzalama/noter kanıtları yok. Eşdeğerlik **PENDING**.
- **Sonraki öncelik:** CI yeşilse 1A native streaming/pause, regional relay cancel ve 1B kalıcı search-session; kırmızıysa önce CI.



**Tarih:** 2026-10-24, Europe/Istanbul. **Kapsam:** Yalnız `orhanbal/webrising-commender/main`.
**Yönetim:** Her tetiklemede A = CI/P0/güvenlik, B = en öncelikli eksik dikey dilim, C = sonraki bağımsız/aynı dikey dilim, D = test/commit/CI/plan/kanıt. A–D *iş paketleri*dir; her birini bitirmiş saymak için ilgili gerçek testler gerekir. Kalanlar sonraki çalışmada sürdürülür.
**Sınır:** Bu kuyruk, [İleri Geliştirme Planı 1](ADVANCED_DEVELOPMENT_PLAN_1.md) ile karıştırılmaz. Üretim, sunucular, başka repolar ve Desktop Commander araçları kapsam dışıdır. Ücretli servis veya zorunlu üçüncü taraf runtime bağımlılığı eklenmez.
**Durum sözlüğü:** `PASSED` = belirtilen kabulün somut kanıtı var; `PENDING` = geliştirme/test/CI eksik veya kısmi; `FAILED` = doğrulanmış hata; `BLOCKED_EXTERNAL` = gerçek cihaz/hesap/harici imza erişimi gerekiyor. `PASSED` bir alt kapsam için kullanılmışsa tam satırın kabulü anlamına gelmez.

## Bu tetiklemenin A–D ilerleme kaydı

| Paket | Sonuç | Kanıt / sınırlama |
|---|---|---|
| A — CI/P0 inceleme | PASSED (giriş baseline) | Giriş HEAD `cf8387fad2a1d10951866517ec5abcee72b22dc1`; [CI #40080662828](https://github.com/orhanbal/webrising-commender/actions/runs/40080662828) tüm 17 job başarılı; [platform #40080948491](https://github.com/orhanbal/webrising-commender/actions/runs/40080948491) başarılı. Rust job logunda 13/13 unit test PASS. Yeni commitlerin CI'sı ayrıca doğrulanacak. |
| B — P0 arama kota/izolasyon sertleştirme | PENDING (kod + unit test commitlendi) | `3db2cb23`: yalnız native in-flight aramalar eşzamanlılık kotası tüketir; `stop_search` native işi iptal etmediğinden slot gerçek istek bitene dek tutulur; tamamlanan aramalar kotayı tüketmez. Native hata mesajları allowlist dışındaysa redakte edilir. `e1fe01c5`: yarış, kota, sonuç sızmaması ve redaksiyon testleri. Güncel HEAD CI beklenir. |
| C — P0 arama zaman bütçesi / MCP sinyali | PENDING (kod + Rust unit + gerçek Agent E2E commitlendi) | `cf41f58f`: dosya ve içerik aramasına monotonic 10s bütçe, `timedOut`/ `truncated` sinyali; `5c67b09b`: MCP sayfa özetine `timedOut` taşıma; `93809aaa`: gerçek Agent E2E'de sınır sözleşmesi. Synchronous filesystem syscall bloklanırsa kesin 10s iptal garantisi yok; gerçek streaming/pause/native cancellation hâlâ açık. |
| D — Test, belge ve son HEAD kontrolü | PENDING | Bu dosya, parity planı, gece planı, ana plan ve MCP matrisi güncellenir. Son HEAD için [CI #40081348219](https://github.com/orhanbal/webrising-commender/actions/runs/40081348219) ilk kontrolde `pending`; sonraki commitler yeni CI tetikleyecektir. Fiziksel OS/ChatGPT/Claude testleri kanıtsız PASS yazılmaz. |

## Kanonik 40 alt görev — açık kuyruk

| Kod | Durum | Doğrulanmış mevcut kapsam / kalan kabul |
|---|---|---|
| 1A | PENDING | Yerel relay üzerinden kooperatif native cancel kodlandı (`c602a7ad`, `0ad37183`); streaming, pause/resume, regional relay cancel ve yavaş tarama negatif E2E açık. |
| 1B | PENDING | Search session bellekte; Gateway restart sonrası devamlılık yok. Actor/tenant/device izolasyon testi mevcut; kalıcı depo/izolasyon kabulü açık. |
| 1C | PENDING | Case sensitivity ve sayfalama E2E mevcut; bu tur 10s native scan bütçesi ve zaman aşımı sinyali eklendi. Büyük dizin, yarış, quota ve güncel CI kabulü açık. |
| 1D | PENDING | 1–10 çoklu okuma ve per-file hata, line/tail sayfalama Agent E2E mevcut; büyük çıktı ve negatif OS kapsamı tamamlanmadı. |
| 2A | PENDING | PTY history paging var; prompt/REPL ve tam çıktı kalıcılığı açık. |
| 2B | PENDING | PTY geçmişi RAM'de son 1 MiB; disk spool ve restart/retention yok. |
| 2C | PENDING | Süreç/task iptali mevcut; process-tree temizleme ve OS varyantları kabulü açık. |
| 2D | PENDING | Kota, izin, terminal yarışları ve tüm OS negatif test matrisi açık. |
| 3A | PENDING | Atomik yazma ve SHA önkoşulu E2E var; eşzamanlı dış değişiklik yarışının güvenli kapanışı açık. |
| 3B | PENDING | Kalıcı sürümleme, geri alma ve veri kaybı negatif E2E yok. |
| 3C | PENDING | Allowed-root, risk/onay ve policy_info var; konfigürasyon/shell/engelli komut matrisi açık. |
| 3D | PENDING | Tool history/usage Gateway araçları var; audit/redaction/large paging kabulü açık. |
| 4A | PENDING | XLSX/XLSM inspect/read/search ve fixture var; tüm workbook sınırları kabulü açık. |
| 4B | PENDING | XLSX yeni dosyaya bounded write var; XLSM güvenli yazma ve OOXML formül/stil roundtrip açık. |
| 4C | PENDING | Genel dosya araçları var; CSV/JSON/Markdown/kod formatına özgü çift yönlü sözleşme açık. |
| 4D | PENDING | Büyük belge, eşzamanlılık, kaynak tüketimi ve veri kaybı performans kabulü açık. |
| 5A | PENDING | DOCX read/inspect/table var; biçim koruyan yapılandırılmış yazma yok. |
| 5B | PENDING | DOCX atomik write/roundtrip/bozuk belge negatif testi yok. |
| 5C | PENDING | PDF metin/sayfa okuma MCP/Agent araçları yok. |
| 5D | PENDING | PDF sayfa ekleme/çıkarma/birleştirme MCP/Agent araçları yok. |
| 6A | PENDING | PNG/JPEG/GIF ve VP8X WebP header metaverisi var; kapsamlı format/header doğrulama açık. |
| 6B | PENDING | Güvenli gerçek görüntü önizleme/decoder limit testleri yok. |
| 6C | PENDING | 46 araç matrisi var; belge araçlarının MCP/Gateway/Agent/izin/format uçtan uca tamamı açık. |
| 6D | PENDING | Belge performans ve regression kabulü açık. |
| 7A | PENDING | MCP initialize/list/call ve şema regresyonu var; session/transport varyantlarının tamamı açık. |
| 7B | BLOCKED_EXTERNAL | Gerçek ChatGPT/Claude canlı istemci erişimi ve yetkili kurulum kanıtı yok. |
| 7C | PENDING | Web paneli mevcut; tüm cihaz/terminal/dosya/arama/belge/işlem/geçmiş ekranlarının işlevsel kabulü açık. |
| 7D | PENDING | Browser screenshot/temel UI CI var; tam etkileşim/erişilebilirlik E2E açık. |
| 8A | PENDING | Windows installer ve CI paket var; fiziksel upgrade/uninstall ve imza kabulü açık. |
| 8B | PENDING | Linux shell/systemd installer ve CI paket var; fiziksel upgrade/uninstall kabulü açık. |
| 8C | PENDING | macOS installer ve CI paket var; fiziksel upgrade/uninstall ve noter kabulü açık. |
| 8D | PENDING | Üç OS acceptance artifact'leri CI'da üretilmiş; fiziksel makine kanıtı ve güncel HEAD CI açık. |
| 9A | PENDING | Auth/RBAC/approval/audit altyapısı var; 46 araç tam izin/limit/redaction negatif matrisi açık. |
| 9B | PENDING | Relay E2E/backup-restore CI var; uzun süreli reboot/soak/failover fiziksel kabulü açık. |
| 9C | PENDING | 46 araç, 35 doğrudan Agent E2E çağrısı kayıtlı; tüm araç/negatif/OS varyantları açık. |
| 9D | PENDING | Compose clean stack/restore CI var; tam yeni Agent eşleme/kurulum kabulü açık. |
| 10A | PENDING | Giriş HEAD 17/17 CI ve platform PASS; **son kod+belge HEAD** üzerinde yeniden doğrulama gerekiyor. |
| 10B | PENDING | Kurulum/upgrade/uninstall belgeleri var; sürüm uyumu ve güvenli release acceptance açık. |
| 10C | BLOCKED_EXTERNAL | Gerçek Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imzası ve Apple notarization kanıtı yok. |
| 10D | PENDING | Plan/matris senkronizasyonu ve nihai CI/gerçek kabul kapıları açık; parity ilan edilmez. |

## Çalışma sırası ve değişiklik kuralı

1. Her çalışmada en güncel `main` HEAD, Actions job listesi ve **kırmızı job logu** okunur. Kırmızı CI varsa kodlamadan önce onarılır.
2. Önceden PASS edilmiş alt kapsam yeniden yazılmaz. `PENDING` olan ilk öncelikli işte önce eksik dikey parça tamamlanır; en az MCP şeması + Gateway + Agent + risk/izin + pozitif/negatif gerçek E2E gerekir.
3. **Sıradaki P0:** 1A gerçek native streaming/cancel ve 1B PostgreSQL tabanlı actor/tenant/device izole kalıcı search-session tasarımı. Bu iki iş, yalnızca snapshot+TTL olduğu için tamamlanmış sayılamaz.
4. P0 kabulü olmadan P1 belge işlerini bitmiş ilan etme; fakat bağımsız güvenli işler, kırmızı CI yoksa sırayla yapılabilir.
5. Her yeni commit için yeni HEAD'in CI'sı ve artifact'leri tekrar incelenir. Güncel HEAD'de CI bekleniyorsa `PENDING` yazılır. **Genel eşdeğerlik: PENDING**.
