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

# WECOMMANDER — Master Plan

## 24 Ekim 2026 16:22 TRT — A/B/C/D: native multi-file read, güvenlik ve CI düzeltmesi

- **A — PASSED (giriş):** `02ee2ab3` üzerinde [CI #40093405056](https://github.com/orhanbal/webrising-commender/actions/runs/40093405056) **17/17 PASSED**, [platform #40093754504](https://github.com/orhanbal/webrising-commender/actions/runs/40093754504) **PASSED**. `rust`, `agent-e2e` ve `integration` logları incelendi; eski CI sonucu yeni HEAD'e aktarılmadı.
- **B — 1D IMPLEMENTED, kabul PENDING:** [`b4587f9e`](https://github.com/orhanbal/webrising-commender/commit/b4587f9e3dd1f3e7c7ad806328456a570af78706) `fs_read_multiple` için 1–10 dosyayı **tek native Rust Agent çağrısıyla** okuyan bounded yol ekler. MCP şeması, TypeScript action validation/risk, Agent enum/risk/allowlist, native read ve E2E uyumludur; her dosyanın hatası ayrı döner. Gateway'in önceki 10 ayrı Agent isteği kaldırıldı. Dosya başına 64 KiB sınır ve redakte `read_failed` kodu uygulanır. Araç sayısı değişmez (**46**).
- **C — TESTS ADDED, CI PENDING:** Gerçek Agent MCP E2E'de 10 dosya, kısmi hata, allowlist dışı yolun sızdırılmaması, sıfır/11 dosya, limit aşımı ve okuma sınırı; TypeScript Zod negatif kontrat testleri eklendi. Bunlar ilgili HEAD CI tamamlanmadan PASSED değildir.
- **D — CI FIX / PENDING:** İlk kod HEAD'i [CI #40097800013](https://github.com/orhanbal/webrising-commender/actions/runs/40097800013) `cargo fmt --check` adımında **FAILED**; gerçek diff incelenip [`36964592`](https://github.com/orhanbal/webrising-commender/commit/36964592a4c034f07ab9cc22a758bcf7c697dc07) ile Rust biçimi düzeltildi. [CI #40097863619](https://github.com/orhanbal/webrising-commender/actions/runs/40097863619) yeni kod HEAD'inin sonucudur; tam 17 iş, platform artifact ve bu dokümantasyon commitinin son HEAD CI'sı ayrıca kontrol edilmelidir.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve uzun tarama iptal kabulü); **1B PENDING** (çalışan taramanın restart sonrası sürdürülmesi); **1C PENDING** (OS/stress/race); **1D PENDING** (yeni native batch CI/OS kabulü ve satır/büyük çıktı uçları). **7B/10C BLOCKED_EXTERNAL**; diğer 1D–10D eksikler kuyrukta. **Genel eşdeğerlik PENDING.**
- **Kapsam:** Sadece `orhanbal/webrising-commender/main`; üretim, sunucu, başka repo, Desktop Commander veya Remote Desktop Commander kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.


Canonical product and implementation plan.

## 1. Product definition

WECOMMANDER is a secure, persistent remote-computer control platform designed for AI clients. It combines a native local agent with a self-hostable control plane and an MCP endpoint.

The product must work in two modes without architectural forks:

1. **Self-hosted / Community** — the user runs the gateway and PostgreSQL.
2. **Cloud / SaaS** — WebRising operates the control plane, relay and tenancy layer.

The local agent always initiates outbound connections. No inbound port is required on the controlled device.

## 2. Non-negotiable principles

- Local machine access is explicit and policy-bound.
- The agent survives AI-client disconnects and reconnects automatically.
- Long-lived terminal sessions remain alive while the agent process remains alive.
- Every mutating or command-execution operation is auditable.
- Secrets are never stored in plaintext server-side when a one-way verifier is sufficient.
- File access is limited to configured roots.
- Dangerous actions require an approval token unless the local policy explicitly allows them.
- No paid infrastructure dependency is required for the self-hosted edition.
- Self-hosted users are not intentionally feature-locked out of core remote-control capabilities.
- Cloud multi-tenancy is designed in from the schema boundary, even if the first release is single-tenant.

## 3. MVP acceptance criteria

### Native agent
- Rust single binary.
- Windows, Linux and macOS compatible architecture.
- Outbound WebSocket connection to the gateway.
- Automatic reconnect with capped exponential backoff.
- Device enrollment and durable device credentials.
- Heartbeat.
- System information.
- Allowed-root filesystem: list, stat, read, write, mkdir, delete.
- Process: execute with timeout, list, kill.
- Persistent PTY: start, input, read buffered output, resize, stop.
- Persistent background tasks that survive AI/gateway reconnects while the agent process remains alive.
- Local risk classification.
- Native verification of per-device, one-time approval claims bound to the exact HIGH-risk operation payload.
- Output size caps.

### Gateway/control plane
- Node.js/TypeScript service.
- PostgreSQL persistence.
- One-time device pairing codes.
- Hashed device credentials.
- WebSocket agent relay.
- Online/offline device registry.
- Request routing with timeout.
- REST management API.
- MCP Streamable-HTTP-compatible JSON-RPC endpoint for core tools.
- Audit logging.
- Secret redaction.
- Health/readiness endpoints.
- Minimal web console for pairing and device visibility.

### Operations
- Dockerfile.
- docker-compose.yml with PostgreSQL.
- .env.example.
- Database migrations/bootstrap.
- CI: Rust fmt/check/test + Node typecheck/test/build.
- Windows install/remove service scripts.
- Linux systemd install/remove scripts.
- No silent persistence installation.
- Verified backup/restore tooling for the supported Compose deployment.
- A repeatable restart/network soak runner for real-device acceptance.
- Optional native HTTPS/WSS termination using operator-supplied certificate/key files.

## 4. Security model

Risk levels:

- **LOW**: list devices, system info, file read/list/stat, process list, task status, terminal read.
- **MEDIUM**: file write/mkdir, terminal input/resize.
- **HIGH**: delete, process execution, process kill, task start/cancel, terminal start/stop.

Default policy:
- LOW allowed after authenticated device routing.
- MEDIUM allowed only within configured roots.
- HIGH requires an approval token issued by the gateway control plane.
- Shell execution is never hidden or obfuscated.
- Agent refuses paths outside allowlisted roots even if the gateway requests them.

Approval tokens are short-lived, one-time HMAC-signed claims containing device id, action family, the exact operation payload, nonce and expiry. The gateway derives a separate approval key per device; the agent verifies the claim independently before HIGH-risk execution.

## 5. SaaS-ready domain model

- organizations
- users
- organization_members
- invitations
- devices
- relay_nodes
- device_credentials
- pairing_codes
- sessions
- tasks
- approvals
- policies
- billing_plans
- organization_subscriptions
- billing_events
- audit_logs

The first implementation uses a default organization to remain simple for self-hosting. Tables and APIs carry organization_id where it materially affects future tenancy.

## 6. Delivery phases

### Phase 0 — Foundation
Repository, canonical plan, protocol, CI, security rules.

### Phase 1 — Core relay
Gateway + PostgreSQL + enrollment + agent WSS + device presence.

### Phase 2 — Remote operations
Filesystem, processes, system info, PTY, request timeout/cancellation boundaries.

### Phase 3 — MCP
MCP initialize/tools/list/tools/call with device routing and structured errors.

### Phase 4 — Console
Device list, pairing, online/offline, audit visibility.

### Phase 5 — Hardening
Approval tokens, allowlists, redaction, payload caps, rate limits, reconnect tests.

### Phase 6 — Distribution
Windows service, systemd, Docker images, release artifacts.

### Phase 7 — SaaS
Real user auth, organizations, RBAC, plans/billing, regional relays. This phase must not weaken self-hosted mode.

Current milestone: organization-scoped browser users, hardened sessions, email-verified public signup/password reset through the built-in SMTP/outbox layer, workspace onboarding/access, provider-neutral billing plans/subscriptions, transactional resource entitlements, idempotent normalized billing events, provider identity binding/stale-event protection, first-party regional relay orchestration with agent route refresh/failover, and native HTTPS/WSS termination are implemented. Third-party checkout/webhook adapters are not a required runtime component and are intentionally excluded while the no-third-party rule is active.

## Current delivery priority — functional tool parity

Before any new differentiation or SaaS expansion, follow the actionable
[Desktop Commander parity plan](DESKTOP_COMMANDER_PARITY_PLAN.md).
Current remote terminal, file, device and security features remain supported,
but rich document support, paginated file/process operations and physical OS/MCP
acceptance must be completed before declaring comparable product maturity.

### Saatlik parity kuyruğu (24 Ekim 2026)

Tek tetiklemede A (CI/P0), B (sıradaki eksik dikey), C (bağımsız veya kalan dikey), D (test/CI/plan/kanıt) sırası ve 1A–10D kodlu 40 alt görevin güncel durumu için [kanonik backlog kuyruğunu](HOURLY_BACKLOG_QUEUE_20261024.md) kullanın. Giriş HEAD `cf8387fa` 17/17 CI PASS; sonraki P0 search quota/redaction/native scan timeout commitlerinin son HEAD CI kabulü ayrıca beklenir. **Gerçek streaming/cancel, kalıcı arama/PTY, rollback, belge araçları ve dış platform kabulü tamamlanmadan eşdeğerlik ilan edilmez.** İleri Geliştirme Planı 1 bu kuyruğa dahil değildir.

## Future roadmap — approved feature candidates, not yet scheduled

The [Advanced Development Plan 1 v0.3](ADVANCED_DEVELOPMENT_PLAN_1.md) records 21 user-approved post-parity feature candidates, including Time Machine, Safe Execution, privacy-preserving AI access, optional kernel observability, lightweight digital twin, controlled optimization, and resilience testing. **Status: accepted into discussion/design backlog, not approved for immediate implementation or production release.** WECOMMANDER remains an execution and security platform for the user's chosen AI client, not a required built-in LLM. Complete the Desktop Commander parity queue first; refine advanced work scope, implementation gates, and sequencing with the user separately.

## 7. Definition of done

A release is accepted only when:
- CI is green on main.
- A clean gateway + PostgreSQL deployment starts from documented commands.
- A fresh agent can enroll with a one-time pairing code.
- The agent reconnects after gateway restart without manual intervention.
- MCP can list the device and perform allowed file/process/terminal operations.
- A HIGH operation without approval is rejected.
- The same HIGH operation with a valid approval succeeds.
- Audit records show actor/tool/device/outcome without leaking secrets.
- An uninstall path exists for every persistence mechanism we install.
