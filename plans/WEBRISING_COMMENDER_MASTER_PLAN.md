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
