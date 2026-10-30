# Isolated availability soak — 9B

This opt-in, read-only Gateway → Rust Agent → MCP system_info harness does not restart or kill processes. CI runs only local mock HTTP tests, not a 24-hour soak.

Run on an isolated self-hosted test stack with a paired test device and credentials injected without shell history:

SOAK_CONFIRM_ISOLATED=YES COMMANDER_CONTROL_URL=http://127.0.0.1:8787 CONTROL_API_KEY=<test-key> DEVICE_ID=<test-device> SOAK_DURATION_MS=86400000 SOAK_MIN_SAMPLES=100 SOAK_OUTPUT=soak-availability-result.json node scripts/soak-availability.mjs

Defaults: 24 hours, 1-second interval, 5-second per-request timeout, at least 100 samples, zero failed calls and successful-call p95 below 2000ms. HTTP 401/403 stops early. Network errors, timeouts, HTTP errors and invalid responses are failures. A JSON report is written atomically with mode 0600; it excludes credentials, device ID and response bodies.

Non-loopback targets require HTTPS and SOAK_ALLOW_REMOTE=YES, in addition to SOAK_CONFIRM_ISOLATED=YES. The operator must independently verify that the target is a disposable test stack. Never run against production.

Even a real 24-hour PASS covers only one read-only tool and one paired device. Physical multi-host relay failover, backup/restore, write-tool safety, and all OS/client acceptances remain separate gates.