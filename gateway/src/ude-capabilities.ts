/**
 * UDE-01: conservative, read-only workspace capability assessment.
 *
 * Reuses already-supported Agent observations. It NEVER executes a command,
 * installs a runtime or declares a device ready for provisioning. Docker/WSL
 * capability probes and UDE-scoped authorisation are later work packages.
 */
type Obj = Record<string, unknown>;
const record = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown, max = 128): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
const bytes = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const positive = (v: unknown): number | null => {
  const value = bytes(v);
  return value !== null && value > 0 ? value : null;
};
const policyState = (v: unknown): "enabled" | "disabled" | "unknown" =>
  v === "enabled" ? "enabled" : v === "disabled" ? "disabled" : "unknown";

export function udeEnabled(value: string | undefined): boolean {
  // Literal opt-in: absent, 1, TRUE and all other values fail closed.
  return value === "true";
}

export function buildUdeCapabilities(systemInfo: unknown, healthSnapshot: unknown, policyInfo: unknown) {
  const system = record(systemInfo);
  const health = record(healthSnapshot);
  const memory = record(health.memory);
  const policy = record(policyInfo);

  const os = text(system.os, 64);
  const osLower = os?.toLowerCase() ?? "";
  const platform = osLower.includes("windows") ? "windows"
    : osLower.includes("linux") ? "linux"
    : osLower.includes("mac") || osLower.includes("darwin") ? "macos"
    : "unknown";

  const commandExecution = policyState(policy.commandExecution);
  const fileWrites = policyState(policy.fileWrites);
  const explicitlyBlocked = commandExecution === "disabled" || fileWrites === "disabled";

  const totalMemoryBytes = positive(memory.totalBytes) ?? positive(system.totalMemory);
  const availableMemoryBytes = bytes(memory.availableBytes);
  const diskRows = Array.isArray(health.disks) ? health.disks : [];
  const disks = diskRows.slice(0, 32).flatMap((raw) => {
    const disk = record(raw);
    const totalBytes = positive(disk.totalBytes);
    const availableBytes = bytes(disk.availableBytes);
    if (totalBytes === null || availableBytes === null || availableBytes > totalBytes) return [];
    return [{
      mount: text(disk.mount, 256) ?? "unspecified",
      totalBytes,
      availableBytes,
    }];
  });

  const sourceLimitations = Array.isArray(health.limitations)
    ? health.limitations.filter((v): v is string => typeof v === "string").slice(0, 8).map(v => v.slice(0, 220))
    : [];

  return {
    schemaVersion: 1,
    feature: "UDE",
    operation: "capabilities",
    readOnly: true,
    observedAt: text(health.observedAt, 64),
    source: "existing_agent_observations",
    host: {
      platform,
      os,
      osVersion: text(system.osVersion, 64),
      cpuCount: positive(system.cpuCount),
      totalMemoryBytes,
      availableMemoryBytes,
      disks,
    },
    devicePolicy: { commandExecution, fileWrites },
    assessment: {
      status: explicitlyBlocked ? "blocked_by_device_policy" : "requires_additional_verification",
      canProvision: false,
      checksNotPerformed: [
        "virtualization_and_wsl2",
        "container_runtime_and_permissions",
        "workspace_path_and_disk_quota",
        "ude_scoped_authorization",
        "template_and_network_policy",
      ],
    },
    limitations: [
      ...sourceLimitations,
      "No WSL2, virtualization, container runtime, port or workspace-directory probes were run.",
      "Existing device command/file permissions do not authorize UDE provisioning.",
    ],
  };
}
