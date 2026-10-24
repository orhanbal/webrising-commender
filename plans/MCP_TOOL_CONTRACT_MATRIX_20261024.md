## 24 Ekim 2026 — A–D arama izolasyonu ve içerik case-sensitivity kabul kaydı

- **Giriş kanıtı:** `b222da7a`, [CI #40091796139](https://github.com/orhanbal/webrising-commender/actions/runs/40091796139) **17/17 PASSED**, [platform #40092082366](https://github.com/orhanbal/webrising-commender/actions/runs/40092082366) PASSED.
- **1A PENDING:** [`4ed6397b`](https://github.com/orhanbal/webrising-commender/commit/4ed6397bd11185f644a37d10ae2a6c450812f3f4) gerçek Agent üzerinden iki paralel arama ve birinin iptalinin diğerini bozmaması için MCP E2E ekler; native streaming/pause/resume ve uzun tarama iptal kabulü hâlâ açık.
- **1C PENDING:** [`31e3770a`](https://github.com/orhanbal/webrising-commender/commit/31e3770a00044337c7be530e53d36edb129fe4d8) içerik aramasının doğrudan ve oturumlu case-sensitive/insensitive MCP E2E'sini ekler.
- **Son HEAD CI PENDING:** [#40093339478](https://github.com/orhanbal/webrising-commender/actions/runs/40093339478) kod CI'sı ve bu belge commitinin CI'sı tamamlanmadan yeni testler PASSED sayılamaz. 46 MCP araç adı değişmedi. Fiziksel cihaz, canlı ChatGPT/Claude, imza/noter **BLOCKED_EXTERNAL**; eşdeğerlik **PENDING**. Ayrıntı: [kanonik kuyruk](HOURLY_BACKLOG_QUEUE_20261024.md).

## 24 Ekim — 1C büyük dizin / güvenli arama kabulü

- **Giriş kabulü:** `e7256adc` [CI #40088982183](https://github.com/orhanbal/webrising-commender/actions/runs/40088982183) **17/17 PASSED**, [platform #40089288689](https://github.com/orhanbal/webrising-commender/actions/runs/40089288689) PASSED.
- **1C — kodlanan test paketi:** `7b101537` ile gerçek Rust Agent E2E'de **530 dosya**, maksimum **500 sonuç**, `truncated`, son 10 sonuçta offset 490/length 30, son sayfa `hasMore=false`, uygunsuz offset, 101 eleman uzunluğu ve 1025 karakter sorgu negatif kontrolleri eklendi. [CI #40091456300](https://github.com/orhanbal/webrising-commender/actions/runs/40091456300) içinde `agent-e2e`, `gateway`, `integration` işleri PASS; bütün CI ve artifact kontrolü sürüm HEAD'ine göre ayrıca teyit edilir.
- **1C — bu belgeyle birlikte yeni negatif test:** İzin verilen arama kökünden dışarıdaki dizine işaret eden symlink üzerinden dosya adı veya içerik sorgusunun dış veri döndürmemesi; fiziksel Linux Agent E2E koşusu yeni HEAD CI sonucuna tabidir. Üretim/sunucular test edilmedi.
- **Kalan:** 1A gerçek native streaming ve pause/resume; 1B yeniden başlatmadan sonra *çalışan taramayı* sürdürebilme; 1C kalan çoklu OS/stress/race kabulü; 1D–10D ana görev kuyruğu **PENDING**. Gerçek ChatGPT/Claude ve fiziksel cihaz onayı **BLOCKED_EXTERNAL**. **Genel eşdeğerlik PENDING**.

## 24 Ekim 14:11 TRT — A/B/C/D, cross-Gateway native search cancellation

- **A / PASSED (giriş):** `e53f30ef` [CI #40088408188](https://github.com/orhanbal/webrising-commender/actions/runs/40088408188) **17/17 PASSED**; [platform #40088728355](https://github.com/orhanbal/webrising-commender/actions/runs/40088728355) PASSED. `0fb9254c` gerçek Gateway SIGKILL/restart E2E testini CI'ya ekledi; bu yeni testin kendi CI'sı ayrı doğrulanır.
- **B / IMPLEMENTED, CI PENDING (1B kalan dilim):** `1dd8091f` `PgSearchPersistence.stoppedIds` ile yalnız **aynı origin_instance** ve aktif UUID kümesine ait, DB'de durdurulmuş aramaları döndürür. Başka Gateway üzerinden `stop_search` sonrası owning Gateway saniyelik tek toplu sorguyla `AbortController` iptalini gerçek native/relay zincirine iletir. DB kesintisinde native zaman sınırı devam eder; tamamlanmış sonuçları diriltmeye izin verilmez.
- **C / TESTS ADDED:** Unit: yanlış ID başka aramayı iptal etmez; doğru ID yalnız ilgili native sinyali iptal eder; boş küme DB sorgusu yapmaz; SQL origin guard doğrulanır. PostgreSQL integration: farklı store üzerinden stop → owning store stoppedIds doğrulanır. **Canlı iki Gateway + gerçek Rust Agent uzun tarama iptal benchmark'ı henüz yok.**
- **D / PENDING:** [Kod HEAD CI #40088922971](https://github.com/orhanbal/webrising-commender/actions/runs/40088922971) yeni commit için başlatıldı; tüm 17 iş ve artifact'ler tamamlanmadan PASSED yazılmaz. Bu doküman commitinin de ayrı HEAD CI sonucu kontrol edilir.
- **Kuyruk:** **1A PENDING** (gerçek streaming/pause/resume eksik); **1B PENDING** (completed snapshot restart sürekliliği mevcut; çalışan scanner restart sonrası kaldığı yerden başlamıyor); **1C–10D** diğer açık kabul kapıları değişmedi. **7B/10C BLOCKED_EXTERNAL** (canlı istemciler, fiziksel OS, imzalama/noter). **Eşdeğerlik PENDING.**
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer depo/Desktop Commander araçları kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim — P0 1B PostgreSQL arama oturumu kalıcılığı

- **A / baseline:** Önceki tam doğrulanan `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) **17/17 PASS** ve [platform #40086302889](https://github.com/orhanbal/webrising-commender/actions/runs/40086302889) PASS. Daha yeni HEAD'e bu sonucu taşımayın.
- **B / IMPLEMENTED, CI PENDING:** `fc51c76c` PostgreSQL `search_sessions` migration, actor/organization/device-scoped 5dk TTL, en fazla 500 eşleşme ve 1MiB kalıcı sonuç sınırı, error/stop kayıtları ve housekeeping. `start_search`, `get_more_search_results`, `list_searches`, `stop_search` persistent fallback kullanır. Çalışır durumdaki native scanner otomatik devam ettirilmez; yeniden başlatılmış Gateway'in sahip olmadığı `running` iş `search_interrupted` görünür.
- **C / TESTS ADDED, CI PENDING:** `f70a13ed` async search-page/stop/list kontratı ve TypeScript unit; `c9dbfe2e` izolasyon/rollback/sınır mock regresyonu; `1e0d6dc2` gerçek PostgreSQL integration: tamamlanmış aramayı yeni store örneğinden okumak, actor/tenant/device negatif izolasyon, stop sonrası temizleme, yarım taramayı `search_interrupted` gösterme.
- **D / PENDING:** Son doküman HEAD'inin 17/17 CI ve dağıtım artifact kabulü, gerçek Gateway sürecini kapatıp açan uçtan uca restart senaryosu, çoklu Gateway/failover eşzamanlı durdurma, uzun bölgesel native cancellation ve 1A streaming/pause kabulü açık. **Eşdeğerlik ilan edilmez.**
- **BLOCKED_EXTERNAL:** Fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, platform imzaları ve Apple notarization kanıtlanmadı.

## 24 Ekim — Bölgesel relay arama iptali (1A, A/B/C/D)

- **A:** Giriş `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) 17/17 başarılı; üretim, fiziksel cihaz ve dış MCP kabulü yapılmadı.
- **B:** `91506f9e` — `DeviceRouter` bölgesel relay isteklerine eşsiz UUID ekler; `AbortSignal` geldiğinde ayrı **imzalı** `/internal/relay/cancel` çağrısını kullanır. Uzak `AgentHub` cancel sinyalini native Agent'a iletir. Asıl HTTP isteği kooperatif bitişe kadar bekler; eşzamanlı tarama kotası erken boşaltılmaz.
- **C:** `relay-cancellation.ts` — farklı sırada ulaşan cancel/request çağrıları için TTL'li ve kapasiteli erken iptal kaydı; `requestId + deviceId` eşleşmesi, çakışma ve yanlış cihaz testleri. Bölgesel relay E2E'ye unsigned cancel=401, gerçek MCP start/stop/page yarış testi eklendi.
- **D:** Bu belge güncellemesinin **yeni HEAD CI sonucu PENDING**. Canlı uzun süren bölgesel arama üzerinde iptal süre/maliyet benchmark'ı, streaming ve pause/resume ile 1B kalıcı oturum **PENDING**; genel eşdeğerlik **PENDING**. 

## 13.11–13.25 A/B/C/D ilerleme kaydı — 24 Ekim 2026

- **A / PASSED (giriş):** `7d4ff46b` için [CI #40081678744](https://github.com/orhanbal/webrising-commender/actions/runs/40081678744) **17/17 PASS**; [platform #40082053980](https://github.com/orhanbal/webrising-commender/actions/runs/40082053980) PASS. Rust, Agent E2E ve integration job logları incelendi; giriş HEAD'inde kırmızı iş yoktu.
- **B / PENDING (1A native cancellation):** `c602a7ad` ile Rust Agent aramaları `spawn_blocking` üzerinde çalışıyor; istek bazlı `AtomicBool` iptal bayrağı tarama döngüsü/dizin/satır sınırlarında kontrol ediliyor. WebSocket `cancel` geldiğinde search task'ı körlemesine abort edilmek yerine kooperatif çıkış yapıyor; disconnect/shutdown bayrakları temizliyor. Pre-cancelled Rust negatif testi eklendi.
- **C / PENDING (1A Gateway cancel iletimi):** `0ad37183` ile `stop_search` → AbortSignal → local AgentHub → WebSocket `cancel` → native Agent zinciri kuruldu. Gateway in-flight kotası, Agent yanıtı veya timeout gelene kadar korunuyor; sonuçlar stop sonrası geri dönmüyor. Actor/device izolasyonu korunuyor. Gateway negatif yarış testi eklendi.
- **D / PASSED (ara kod kontrolü):** `4071130f` rustfmt, `6f3eca4f` clippy ExecutionContext ve `523e532e` biçim düzeltmeleri. [CI #40085512074](https://github.com/orhanbal/webrising-commender/actions/runs/40085512074) kod HEAD'i için başlatıldı; son durum ayrıca kontrol edilmeli. İlk CI kırmızıları (fmt/clippy) düzeltildi.
- **Açık 1A:** Gerçek streaming ve pause/resume yok. Yerel relay için fiziksel iptal uygulanmış olsa da uçtan uca yavaş tarama sırasında durdurma testi ve bölgesel relay üzerinden iptal iletimi henüz doğrulanmadı; bu nedenle 1A **PENDING**.
- **Açık 1B:** PostgreSQL kalıcı arama oturumu ve restart sonrası actor/tenant/device izolasyonu **PENDING**. `stop_search` ile durdurulmuş snapshot hiçbir koşulda tekrar görünür olmamalı.
- **BLOCKED_EXTERNAL:** Gerçek Windows/macOS/Ubuntu fiziksel kurulum, canlı ChatGPT/Claude ve Windows/Apple imzalama/noter kanıtları yok. Eşdeğerlik **PENDING**.
- **Sonraki öncelik:** CI yeşilse 1A native streaming/pause, regional relay cancel ve 1B kalıcı search-session; kırmızıysa önce CI.

## 12.14 P0 arama sözleşmesi güncellemesi — CI bekliyor

- `fs_search` ve `text_search` native Agent çıktısı artık `timedOut: boolean` taşır; `truncated` süre bütçesi aşıldığında `true` olur. 10s süre bütçesi dosya/dizin/satır döngüsünde denetlenir; tek filesystem syscall'ın zorla durdurulması değildir.
- `start_search` → `get_more_search_results` sayfalı snapshot'ında `timedOut` raporlanır. MCP araç adı/şema sayısı **46 olarak değişmedi**.
- In-flight concurrency slotu, `stop_search` sonrasında native istek sonuçlanıncaya kadar tutulur; tamamlanan oturumlar kota tüketmez. Hata mesajları allowlist dışındaysa `search_failed` döner.
- Kod/test commitleri: `3db2cb23`, `e1fe01c5`, `cf41f58f`, `5c67b09b`, `93809aaa`. Güncel HEAD'in CI ve gerçek Agent E2E sonucu **PENDING**.
- Bu değişiklik **native streaming/pause/physical cancel veya restart persistence** değildir; 1A/1B açık kalır. Bütün 46 aracın kabul durumu [40 alt görevlik kuyrukta](HOURLY_BACKLOG_QUEUE_20261024.md) izlenir.

# WECOMMANDER — MCP araç sözleşmesi ve kabul matrisi

Güncelleme: 24 Ekim 2026. Kaynak: `gateway/src/mcp.ts`, `gateway/src/protocol.ts`, `gateway/test/agent-e2e.mjs`. **Bu dosya koddan çıkarılan mevcut araç kaydını gösterir; rakip ürünle tam eşdeğerlik veya fiziksel cihaz kabulü kanıtı değildir.**

## Kanıt ve kabul ölçütleri

- **PASS (başlangıç):** `5c9d860a`, GitHub Actions CI `40060563045` 17/17 başarılı; dağıtım `40060992297` başarılı. Bu sürümdeki kayıtlı araçlar derleniyor ve genel CI geçiyor.
- **PENDING (yeni test):** `gateway/test/integration.mjs` içinde araç adı tekilliği, JSON şema/required alanları, cihaz kapsamı, HIGH onay alanı ve bilinmeyen araç davranışı için yeni sözleşme regresyon testi eklendi. Bu testin bulunduğu yeni HEAD CI geçmeden PASS denmez.
- **E2E çağrısı mevcut:** Kaynak dosyasında doğrudan `tool(id, name, args)` çağrısı tespit edildi. Bu işaret **yalnız test varlığını** gösterir; tüm parametre/OS/izin varyantlarının geçtiğini göstermez.
- **Risk:** `gateway/src/protocol.ts` `actionRisk` sınıflandırması. Gateway-only işlemler LOW ve kimlik/rol sınırlarına tabidir.
- **OS kabulü:** Windows/macOS derleme ve installer artifact CI'sı gerçek cihaz üzerinde kurulum, yükseltme, kaldırma ve canlı istemci testi yerine geçmez.

## Kayıtlı araçlar (46)

| MCP araç adı | Kategori | Risk | Yürütme | Linux Agent E2E testi |
|---|---|---|---|---|
| `devices_list` | Sistem | LOW | Gateway | Ayrı doğrudan E2E çağrısı bulunamadı |
| `system_info` | Sistem | LOW | Agent | E2E çağrısı mevcut |
| `policy_info` | Sistem | LOW | Agent | E2E çağrısı mevcut |
| `get_recent_tool_calls` | Audit | LOW | Gateway | Ayrı doğrudan E2E çağrısı bulunamadı |
| `get_usage_stats` | Audit | LOW | Gateway | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_list` | Dosya | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_stat` | Dosya | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_read` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `fs_read_lines` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `image_inspect` | Görsel | LOW | Agent | E2E çağrısı mevcut |
| `docx_inspect` | Word | LOW | Agent | E2E çağrısı mevcut |
| `docx_read_paragraphs` | Word | LOW | Agent | E2E çağrısı mevcut |
| `docx_read_table` | Word | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_inspect` | Excel | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_read_range` | Excel | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_find` | Excel | LOW | Agent | E2E çağrısı mevcut |
| `xlsx_write_cells` | Excel | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_read_multiple` | Dosya | LOW | Gateway | E2E çağrısı mevcut |
| `fs_write` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_append` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_mkdir` | Dosya | MEDIUM | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `fs_delete` | Dosya | HIGH | Agent | E2E çağrısı mevcut |
| `fs_move` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `fs_tree` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `fs_search` | Dosya | LOW | Agent | E2E çağrısı mevcut |
| `text_search` | Arama | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `code_search` | Arama | LOW | Agent (text_search alias) | E2E çağrısı mevcut |
| `start_search` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `get_more_search_results` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `list_searches` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `stop_search` | Arama | LOW | Gateway | E2E çağrısı mevcut |
| `fs_replace` | Dosya | MEDIUM | Agent | E2E çağrısı mevcut |
| `process_exec` | Süreç | HIGH | Agent | E2E çağrısı mevcut |
| `process_list` | Süreç | LOW | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `process_kill` | Süreç | HIGH | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `task_start` | Görev | HIGH | Agent | E2E çağrısı mevcut |
| `task_status` | Görev | LOW | Agent | E2E çağrısı mevcut |
| `task_cancel` | Görev | HIGH | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `task_list` | Görev | LOW | Agent | E2E çağrısı mevcut |
| `terminal_start` | Terminal | HIGH | Agent | E2E çağrısı mevcut |
| `terminal_input` | Terminal | MEDIUM | Agent | E2E çağrısı mevcut |
| `terminal_read` | Terminal | LOW | Agent | E2E çağrısı mevcut |
| `terminal_read_page` | Terminal | LOW | Agent | E2E çağrısı mevcut |
| `terminal_resize` | Terminal | MEDIUM | Agent | Ayrı doğrudan E2E çağrısı bulunamadı |
| `terminal_stop` | Terminal | HIGH | Agent | E2E çağrısı mevcut |
| `terminal_list` | Terminal | LOW | Agent | E2E çağrısı mevcut |

## Açık kabul boşlukları

1. **P0:** Native arama akışını gerçekten iptal/askıya alma; Gateway yeniden başlatma sonrası arama durumu; PTY kalıcı tam çıktı spool'u, REPL algılama, süreç ağacı temizleme, sürüm/rollback.
2. **P1:** PDF okuma/birleştirme/düzenleme araçları henüz kayıtlı değil; DOCX düzenleme ve biçim koruma, gerçek görsel önizleme ve XLSM güvenli yazma yok. XLSX karmaşık OOXML roundtrip kabulü açık.
3. **P2:** Gerçek ChatGPT/Claude MCP bağlantısı, fiziksel Windows/macOS/Ubuntu kurulum/upgrade/uninstall, platform imzalama ve kullanıcı paneli bütün işlev kabulü açık.
4. **Güvenlik:** Her araca ait izin, sınır, hatalı argüman, dosya sistemi yarış koşulu, quota, audit ve platform test matrisi ayrıca kapatılmalı. Bu statik kayıt tablosu yeterli değildir.

**Kapanış kuralı:** `main` CI PASS + gerçek Agent↔Gateway E2E + platform ve canlı MCP istemci kabulü kanıtları olmadan “Desktop Commander parity achieved” yazılamaz.
