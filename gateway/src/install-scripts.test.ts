import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dispatcher, installCommands, installRoute } from "./install-scripts.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("dispatcher is bound to the gateway origin and is valid POSIX sh", () => {
  const body = dispatcher("https://wecommander.app");
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.match(body, /BASE='https:\/\/wecommander\.app'/);
  assert.match(body, /--control-url "\$BASE"/);
  assert.match(body, /--proto '=https'/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wc-install-")), "install.sh");
  fs.writeFileSync(file, body);
  execFileSync("sh", ["-n", file]);
  assert.throws(() => dispatcher("https://x.test/path"), /invalid_origin/);
  assert.throws(() => dispatcher("https://x.test';rm -rf /;'"), /invalid_origin/);
  assert.equal(installCommands("https://wecommander.app").unix, "curl -fsSL https://wecommander.app/install.sh | sh");
});

test("served platform installers are identical to scripts/", async () => {
  for (const [route, source] of [
    ["/install/ubuntu.sh", "scripts/install-ubuntu-online.sh"],
    ["/install/macos.sh", "scripts/install-macos-online.sh"],
    ["/install.ps1", "scripts/install-windows-online.ps1"],
  ] as const) {
    const served = await installRoute(route, "https://wecommander.app");
    assert.ok(Buffer.isBuffer(served), route);
    assert.equal((served as Buffer).toString("utf8"), fs.readFileSync(path.join(repo, source), "utf8"),
      `${route} drifted from ${source}; copy it to gateway/public/install/`);
  }
  assert.equal(await installRoute("/install/other.sh", "https://wecommander.app"), null);
  assert.equal(await installRoute("/install", "https://wecommander.app"), null);
});
