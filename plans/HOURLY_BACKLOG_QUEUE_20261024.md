## 24 Ekim 2026 — 1C: kullanıcı başına eşzamanlı arama kotası (çoklu cihaz)

- **A / DOĞRULANDI:** Önceki native Rust biçimlendirme hatası [6ae9f2c5](https://github.com/orhanbal/webrising-commender/commit/6ae9f2c5d136944f4b2ece86dc6d8e16f78e3329) ile düzeltilmiş; eski [CI #40106428725](https://github.com/orhanbal/webrising-commender/actions/runs/40106428725) FAILED sonucu daha yeni HEAD için kabul değildir.
- **B / 1C KODLANDI:** [a33ec3d6](https://github.com/orhanbal/webrising-commender/commit/a33ec3d6f7dd0e8ceea28fba6f97f5f86c7e183a) Gateway içi aktif native arama kotasını kullanıcı-cihaz yerine **organizasyon + kullanıcı** düzeyinde uygular. Aynı kullanıcının cihaz değiştirerek sekiz eşzamanlı arama kotasını aşması engellenir. Durdurulmuş fakat Agent yanıtı henüz tamamlanmamış aramalar slot işgal etmeye devam eder.
- **C / REGRESYON EKLENDİ:** [1b79899a](https://github.com/orhanbal/webrising-commender/commit/1b79899a784e3a3a8352ecba986d073884cb04c1) aynı kullanıcı + dokuzuncu cihaz için ret, farklı kullanıcı/organizasyon izolasyonu, durdurulan yerel taramanın slotunun erken boşalmaması ve settle sonrası yeni oturum testleri ekler. Önceki 1C timeout regresyonları [49372753](https://github.com/orhanbal/webrising-commender/commit/49372753ff744fb5647a1236f693dd1c113c0b2e) ve [52416147](https://github.com/orhanbal/webrising-commender/commit/52416147e141cb0b6cd24509d669596009bb23b3) kayıtlıdır.
- **D / CI PENDING:** Kod HEAD'i `1b79899a784e3a3a8352ecba986d073884cb04c1` için [CI #40107310735](https://github.com/orhanbal/webrising-commender/actions/runs/40107310735) başlatıldı; tüm işler tamamlanmadan PASSED denmeyecek. Bu plan commitinin kendi HEAD CI'sı ayrı doğrulanmalıdır.
- **Açık kabul:** Çoklu Gateway üzerinden **dağıtık kota** henüz uygulanmadı; 1C'nin OS/stres/race kabulü PENDING. **1A** native gerçek zamanlı streaming ve pause/resume, **1B** çalışmakta olan taramayı restart sonrası checkpoint'ten sürdürme PENDING. 1D–10D kuyruk görevleri açık; 7B/10C fiziksel OS, canlı ChatGPT/Claude ve imzalama/noter kanıtı BLOCKED_EXTERNAL. Desktop Commander işlevsel eşdeğerliği PENDING.
- **Sınır:** Sadece `orhanbal/webrising-commender/main`; diğer depolara, üretim sunucularına veya Remote Desktop Commander'a dokunulmadı; ücretli runtime bağımlılığı eklenmedi.

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

## 24 Ekim 2026 — A/B/C/D gerçek Agent arama regresyonları (15.17 TRT)

- **A — PASSED (giriş HEAD):** `b222da7a` [CI #40091796139](https://github.com/orhanbal/webrising-commender/actions/runs/40091796139) **17/17 PASSED**, [platform #40092082366](https://github.com/orhanbal/webrising-commender/actions/runs/40092082366) **PASSED**. `agent-e2e`, Rust ve Gateway job sonuçları/logları incelendi. Bu sonuçlar yeni commitlere taşınmaz.
- **B — 1A PENDING (test eklendi):** [`4ed6397b`](https://github.com/orhanbal/webrising-commender/commit/4ed6397bd11185f644a37d10ae2a6c450812f3f4) gerçek Rust Agent üzerinden **iki eşzamanlı `start_search` oturumu**, birini `stop_search` ile durdurma, diğerinin 500 sonuçla tamamlanması ve durdurulmuş oturumun sonuçlarının yeniden görünmemesi için MCP E2E regresyonu ekler. Bu test **gerçek streaming, pause/resume veya fiziksel native iptal gecikmesini kanıtlamaz**.
- **C — 1C PENDING (test eklendi):** [`31e3770a`](https://github.com/orhanbal/webrising-commender/commit/31e3770a00044337c7be530e53d36edb129fe4d8) doğrudan `text_search` ve sayfalı `start_search` üzerinde case-sensitive/insensitive içerik eşleşmesinin Rust Agent'da ayrışmasını test eder.
- **D — PENDING (güncel HEAD kabulü):** Kod commitleri için [CI #40093329014](https://github.com/orhanbal/webrising-commender/actions/runs/40093329014) ve [CI #40093339478](https://github.com/orhanbal/webrising-commender/actions/runs/40093339478) tetiklendi; dokümantasyon commitinin kendi CI'sı ayrıca doğrulanır. **17/17 PASSED** yalnız `b222da7a` için kanıtlıdır. Son HEAD testleri geçene kadar yeni kapsam **PENDING**.
- **Kuyruk:** 1A streaming/pause/resume ve uzun tarama gerçek native iptal; 1B çalışan taramanın restart sonrası devamı; 1C OS/stress/race; 1D–10D açık. 7B/10C canlı ChatGPT/Claude, fiziksel OS ve imzalama/noter **BLOCKED_EXTERNAL**. **Genel eşdeğerlik PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim, sunucu, başka depo, Desktop Commander ve Remote Desktop Commander kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

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
| 1A | PENDING | Cross-Gateway native cancel polling `1dd8091f` eklendi; gerçek streaming/pause/resume ve uzun tarama kabulü açık. Yerel relay üzerinden kooperatif native cancel kodlandı (`c602a7ad`, `0ad37183`); streaming, pause/resume, regional relay cancel ve yavaş tarama negatif E2E açık. |
| 1B | PENDING | PostgreSQL scoped completed snapshots (`fc51c76c`) restart sonrası okunuyor; Gateway liveness (`bf07c7c5`), cross-instance stop CAS (`781a5efc`) ve native cancel polling (`1dd8091f`) eklendi. Gerçek iki Gateway + native Agent uzun tarama, scanner'ın restart sonrası devamı ve CI kabulü açık. |
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
| 10A | PENDING | `e53f30ef` CI #40088408188 17/17 PASSED, platform #40088728355 PASSED; `1dd8091f` CI #40088922971 ve son belge HEAD'inin tüm işleri ayrıca doğrulanmalı. |
| 10B | PENDING | Kurulum/upgrade/uninstall belgeleri var; sürüm uyumu ve güvenli release acceptance açık. |
| 10C | BLOCKED_EXTERNAL | Gerçek Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imzası ve Apple notarization kanıtı yok. |
| 10D | PENDING | Plan/matris senkronizasyonu ve nihai CI/gerçek kabul kapıları açık; parity ilan edilmez. |

## Çalışma sırası ve değişiklik kuralı

1. Her çalışmada en güncel `main` HEAD, Actions job listesi ve **kırmızı job logu** okunur. Kırmızı CI varsa kodlamadan önce onarılır.
2. Önceden PASS edilmiş alt kapsam yeniden yazılmaz. `PENDING` olan ilk öncelikli işte önce eksik dikey parça tamamlanır; en az MCP şeması + Gateway + Agent + risk/izin + pozitif/negatif gerçek E2E gerekir.
3. **Sıradaki P0:** 1A gerçek native streaming/cancel ve 1B PostgreSQL tabanlı actor/tenant/device izole kalıcı search-session tasarımı. Bu iki iş, yalnızca snapshot+TTL olduğu için tamamlanmış sayılamaz.
4. P0 kabulü olmadan P1 belge işlerini bitmiş ilan etme; fakat bağımsız güvenli işler, kırmızı CI yoksa sırayla yapılabilir.
5. Her yeni commit için yeni HEAD'in CI'sı ve artifact'leri tekrar incelenir. Güncel HEAD'de CI bekleniyorsa `PENDING` yazılır. **Genel eşdeğerlik: PENDING**.
