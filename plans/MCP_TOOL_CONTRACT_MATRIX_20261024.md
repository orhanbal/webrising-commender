## 24 Ekim 2026 18.20 TRT — A/B/C/D: dayanıklı arama sayfalama ve native silinme yarışı

- **A / PASSED (giriş HEAD):** `58829a87d0926b6fa9387053856e5c6c57ad3ed3` üzerinde [CI #40101907731](https://github.com/orhanbal/webrising-commender/actions/runs/40101907731) **17/17 PASSED**, [platform #40102369794](https://github.com/orhanbal/webrising-commender/actions/runs/40102369794) **PASSED**. Gerçek `rust`, `agent-e2e`, `gateway` job sonuçları/logları okundu. Bu kanıt yeni HEAD'e taşınmaz.
- **B / 1D PENDING (gerçek düzeltme):** [`771327d4`](https://github.com/orhanbal/webrising-commender/commit/771327d4ad8156526faf08466caa802bd43913d7) PostgreSQL kalıcı arama sonuçları 1 MiB sınırını aştığında tüm sayfaları sıfırlamak yerine UTF-8 byte hesabıyla en uzun **sıralı öneki** tutar; `truncated=true`, 500 sonuç sınırı, actor/tenant/device ve CAS stop koruması değişmez. [`b7e89f6c`](https://github.com/orhanbal/webrising-commender/commit/b7e89f6c152200c5bd7ce9e62e12719d805d3b34) TypeScript UTF-8/500-item/korunan-sıra negatif testleri; [`2dadd539`](https://github.com/orhanbal/webrising-commender/commit/2dadd539533867baeea303096c41e05598772b7d) gerçek PostgreSQL restart-benzeri sayfalama, son sayfa ve stop sonrası veri silinmesi E2E testi ekler.
- **C / 1C PENDING (native yarış düzeltmesi):** [`40c0c1fc`](https://github.com/orhanbal/webrising-commender/commit/40c0c1fc0fa315bf5c132c42d35e6a0b5d459d15) Rust `fs_search` ve `text_search` sırasında `read_dir`/metadata arasında silinen girdileri atlar; diğer IO/izin hatalarını saklamaz, symlink izlemez. Deterministik silinmiş dosya unit regresyonu eklendi. Çoklu OS/stres kabulü açık.
- **D / PENDING (yeni HEAD):** [CI #40106428725](https://github.com/orhanbal/webrising-commender/actions/runs/40106428725) yeni kod için başlatıldı; tüm 17 job ve artifact'ler tamamlanmadan **PASSED** yazılmaz. Bu belge commitinin HEAD CI'sı ayrıca kontrol edilecek.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve gerçek uzun tarama kabulü), **1B PENDING** (çalışan taramanın Gateway restart sonrası kaldığı yerden devamı), **1C PENDING**, **1D PENDING** (geniş OS/stress/çıktı kabulü). **2A–10D PENDING** kanonik kuyrukta, **7B/10C BLOCKED_EXTERNAL** fiziksel OS, canlı ChatGPT/Claude, Windows imza/SmartScreen, Apple notarization. **Eşdeğerlik PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer depo/Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 17.18 TRT — A/B/C/D, 1A native içerik iptali ve 1D bounded dosya okuma

- **A — PASSED (giriş):** Başlangıç HEAD `93c926cc` için [CI #40098399194](https://github.com/orhanbal/webrising-commender/actions/runs/40098399194) **17/17 PASSED**, [platform #40098783921](https://github.com/orhanbal/webrising-commender/actions/runs/40098783921) **PASSED**; `rust`, `agent-e2e`, `gateway` job logları okundu. İlk yeni kodun `rust` job'ı `cargo fmt --check` nedeniyle FAILED; gerçek rustfmt diff'i `f74f7655` ile düzeltildi, **son HEAD CI PENDING**.
- **B — 1A PENDING (gerçek Rust iyileştirmesi):** [`b4bb67e7`](https://github.com/orhanbal/webrising-commender/commit/b4bb67e728ea7531b28fad8ed794ba62aeaa1068) içerik taramasındaki tek seferlik `read_to_string` yerine 16 KiB parçalarda, aralarda `AtomicBool` iptali ve monotonic deadline kontrolü yapan en çok 1 MiB okuma getirdi. İptalin dosya okunurken gerçekleşmesini taklit eden deterministik Rust unit eklendi. **Native progress streaming, pause/resume ve uzun gerçek tarama benchmark'ı hâlâ PENDING; 1A tamamlandı sayılmaz.**
- **C — 1D PENDING (bounded okuma + negatif E2E):** `fs_read_lines` için metadata ile gerçek okuma arasındaki büyüme yarışında 32 MiB + 1 bayt fiziksel sınır eklendi. [`f1c5b4ec`](https://github.com/orhanbal/webrising-commender/commit/f1c5b4ec1d25dee2331b1351061856b6a2235f07) ve [`6c541773`](https://github.com/orhanbal/webrising-commender/commit/6c541773f70d52103f881f1b575ba1dd5d98665f) gerçek MCP → Gateway → Agent E2E'de içerik araması 1 MiB sınırı, 32 MiB paged-read reddi ve bozuk UTF-8 reddi ekledi. Mevcut 46 MCP araç şeması, allowlist ve actor/tenant/device denetimi korunur; yeni araç veya ücretli bağımlılık yok.
- **D — PENDING:** [`f74f7655`](https://github.com/orhanbal/webrising-commender/commit/f74f7655b8d90235da3925add2a907b3cd789e5b) rustfmt düzeltmesi. [CI #40101863534](https://github.com/orhanbal/webrising-commender/actions/runs/40101863534) kod HEAD'i için başlatıldı; tüm job/artefact sonucu görülmeden PASSED yazılmaz. Bu plan commitinin kendi HEAD CI'sı ayrıca denetlenecek.
- **Kuyruk:** **1A PENDING**, **1B PENDING** (çalışan tarama restart sonrası kaldığı yerden devam etmiyor), **1C PENDING**, **1D PENDING** (OS/stress/büyük çıktı kabulü açık); **1D–10D** diğer açık işler mevcut kanonik kuyrukta. **7B/10C BLOCKED_EXTERNAL** (fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imza ve Apple notarization). **Eşdeğerlik PENDING.**
- **Sınır:** Sadece `orhanbal/webrising-commender/main`; üretim/sunucu/başka repo/Desktop Commander/Remote Desktop Commander kullanılmadı.

## 24 Ekim 2026 16:22 TRT — A/B/C/D: native multi-file read, güvenlik ve CI düzeltmesi

- **A — PASSED (giriş):** `02ee2ab3` üzerinde [CI #40093405056](https://github.com/orhanbal/webrising-commender/actions/runs/40093405056) **17/17 PASSED**, [platform #40093754504](https://github.com/orhanbal/webrising-commender/actions/runs/40093754504) **PASSED**. `rust`, `agent-e2e` ve `integration` logları incelendi; eski CI sonucu yeni HEAD'e aktarılmadı.
- **B — 1D IMPLEMENTED, kabul PENDING:** [`b4587f9e`](https://github.com/orhanbal/webrising-commender/commit/b4587f9e3dd1f3e7c7ad806328456a570af78706) `fs_read_multiple` için 1–10 dosyayı **tek native Rust Agent çağrısıyla** okuyan bounded yol ekler. MCP şeması, TypeScript action validation/risk, Agent enum/risk/allowlist, native read ve E2E uyumludur; her dosyanın hatası ayrı döner. Gateway'in önceki 10 ayrı Agent isteği kaldırıldı. Dosya başına 64 KiB sınır ve redakte `read_failed` kodu uygulanır. Araç sayısı değişmez (**46**).
- **C — TESTS ADDED, CI PENDING:** Gerçek Agent MCP E2E'de 10 dosya, kısmi hata, allowlist dışı yolun sızdırılmaması, sıfır/11 dosya, limit aşımı ve okuma sınırı; TypeScript Zod negatif kontrat testleri eklendi. Bunlar ilgili HEAD CI tamamlanmadan PASSED değildir.
- **D — CI FIX / PENDING:** İlk kod HEAD'i [CI #40097800013](https://github.com/orhanbal/webrising-commender/actions/runs/40097800013) `cargo fmt --check` adımında **FAILED**; gerçek diff incelenip [`36964592`](https://github.com/orhanbal/webrising-commender/commit/36964592a4c034f07ab9cc22a758bcf7c697dc07) ile Rust biçimi düzeltildi. [CI #40097863619](https://github.com/orhanbal/webrising-commender/actions/runs/40097863619) yeni kod HEAD'inin sonucudur; tam 17 iş, platform artifact ve bu dokümantasyon commitinin son HEAD CI'sı ayrıca kontrol edilmelidir.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve uzun tarama iptal kabulü); **1B PENDING** (çalışan taramanın restart sonrası sürdürülmesi); **1C PENDING** (OS/stress/race); **1D PENDING** (yeni native batch CI/OS kabulü ve satır/büyük çıktı uçları). **7B/10C BLOCKED_EXTERNAL**; diğer 1D–10D eksikler kuyrukta. **Genel eşdeğerlik PENDING.**
- **Kapsam:** Sadece `orhanbal/webrising-commender/main`; üretim, sunucu, başka repo, Desktop Commander veya Remote Desktop Commander kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

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
