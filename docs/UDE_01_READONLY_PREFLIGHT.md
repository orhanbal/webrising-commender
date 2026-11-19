# UDE-01 — Read-only capabilities MVP

Status: **implementation draft on feature branch; no production rollout or provisioning**. Refer to [canonical UDE development plan](../plans/UDE_UNIVERSAL_DEVELOPMENT_ENVIRONMENT_PLAN.md).

## Activation
- Opt-in only: `WECOMMANDER_UDE_ENABLED=true` on a **development/test gateway**.
- Any other value (including unset, `1`, `TRUE`) disables the tool.
- When disabled, `ude_capabilities` is absent from `tools/list` and direct calls are refused as `unknown_tool`.
- This is a **gateway-only** operation. It does not change the Rust Agent, Agent local MCP mode, Core terminal/file/process operations or require Docker/WSL/LLM.
- `WECOMMANDER_UDE_ENABLED` is not a general privilege grant. Existing tenant/device lookup and viewer permission still apply.

## Usage
After opt-in, the MCP tool `ude_capabilities` accepts `{ "device_id": "<enrolled agent UUID>" }`.
It is not available for SSH-only targets. It reads existing Agent actions `system_info`, `health_snapshot` (top=1), `policy_info`, then returns a **projection** of:
- OS/platform, CPU, total/available memory and bounded disk statistics;
- whether the Agent's command/file-writing capabilities are enabled (information **only**, not UDE provisioning permission);
- explicit `assessment.canProvision: false`, with reasons and missing checks.

No command execution, file read, download, Windows feature install, Docker install, WSL install, snapshot, workspace creation or deletion is performed. Sensitive allowlisted roots and raw process lists are intentionally not included in the UDE result. All calls are low-risk audited operations.

## Trust and limits
- `requires_additional_verification` is **not** "ready"; follow-up runtime discovery, workspace path scope, authorization and template validation are mandatory in UDE-02/03.
- `blocked_by_device_policy` means the existing Agent explicitly disables commands or writes; **do not** try to work around the denial.
- A false flag does not disable or remove existing Core operations.
- Partial/malformed health measurements never result in "ready"; invalid disks are omitted.
- The tool is not a secure sandbox. No untrusted workload is started in this phase.
- The feature flag is process-level; enabling it in a live gateway would publish an extra read-only MCP tool. Do not enable for production until acceptance testing and release governance are complete.

## Acceptance to be proven before merge
1. Existing gateway typecheck, Node test suite and Rust/Agent Core CI remain green on the **exact PR SHA**.
2. Default (unset flag): same tool inventory, no UDE request path, unchanged Core behavior.
3. Enabled in test gateway: viewer+tenant-scoped device inventory; disabled tool, revoked/other-tenant device and SSH-only denial.
4. Missing data, out-of-range stats, hidden allowedRoots, and disabled Agent capabilities have negative tests.
5. Audit records only bounded status metadata; no secrets, process-list payload or filesystem contents.
6. Feature has no mandatory runtime packages or database schema changes.

**Not yet implemented:** runtime/WLS2/virtualization probes; workspace planner, templates, UDE-granular privilege grants, install/provision/start/stop/delete UI. These remain future UDE-01/02/03 packages.
