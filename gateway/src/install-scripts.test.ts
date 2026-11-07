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

test("the macOS installer finds the PKG where macos-distribution publishes it", () => {
  // The PKG is released under macos-preview-N (macos-distribution.yml), not
  // under ubuntu-preview-N; the online installer must accept that tag.
  const body = fs.readFileSync(path.join(repo, "scripts/install-macos-online.sh"), "utf8");
  const literal = body.match(/!\/(\^[^/]+\$)\/\.test\(release\.tag_name\)/);
  assert.ok(literal, "tag filter regex not found");
  const tagFilter = new RegExp(literal[1] ?? "^$");
  assert.ok(tagFilter.test("macos-preview-53"));
  assert.ok(!tagFilter.test("windows-preview-1"));
  const workflow = fs.readFileSync(path.join(repo, ".github/workflows/macos-distribution.yml"), "utf8");
  assert.match(workflow, /TAG="macos-preview-/, "macos-distribution publishes macos-preview-N");
});

test("the macOS installer prefers the newest macos-preview over API order and old ubuntu-preview builds", () => {
  const body = fs.readFileSync(path.join(repo, "scripts/install-macos-online.sh"), "utf8");
  const rank = body.match(/ function rank\(r\)\{.*\}\n/)?.[0];
  const sort = body.match(/ releases\.sort\(.*\);\n/)?.[0];
  assert.ok(rank && sort, "rank/sort not found in the installer");
  const order = new Function("releases", `${rank}${sort}return releases.map(function(r){return r.tag_name;});`);
  assert.deepEqual(
    order([{ tag_name: "macos-preview-58" }, { tag_name: "ubuntu-preview-1636" }, { tag_name: "macos-preview-59" }]),
    ["macos-preview-59", "macos-preview-58", "ubuntu-preview-1636"],
  );
});

test("the Windows installer sorts releases by build number before picking one", () => {
  const body = fs.readFileSync(path.join(repo, "scripts/install-windows-online.ps1"), "utf8");
  const sortAt = body.indexOf("Sort-Object -Descending");
  const loopAt = body.indexOf("foreach($r in $results)");
  assert.ok(sortAt > 0 && loopAt > sortAt, "releases are sorted before the selection loop");
});
