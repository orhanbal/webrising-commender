import assert from "node:assert/strict";
import test from "node:test";
import { commandTokens, normalizePattern, patternMatches } from "./command-allowlist-rules.js";

test("shell metacharacters, quotes, globs and expansions are never allowlisted", () => {
  for (const cmd of [
    "df -h; rm -rf /", "df -h && reboot", "df -h || true", "df -h | sh", "df -h > /etc/passwd",
    "df -h < x", "df -h `id`", "df -h $(id)", "df -h $HOME", "docker ps 'a'", 'docker ps "a"',
    "ls *", "ls ?", "ls ~", "df -h\nrm -rf /", "df -h\r", "df\t-h", "df -h #x", "df -h &", "ls {a,b}",
    "ls [a]", "df -h \\", "!!", "FOO=1 df", "-h df", "", " ".repeat(3), "x".repeat(600),
  ]) {
    assert.equal(commandTokens(cmd), null, JSON.stringify(cmd));
  }
  assert.deepEqual(commandTokens("  systemctl   status  nginx "), ["systemctl", "status", "nginx"]);
});

test("prefix match is by whole tokens", () => {
  assert.ok(patternMatches("systemctl status", "systemctl status nginx"));
  assert.ok(patternMatches("df -h", "df -h"));
  assert.ok(!patternMatches("systemctl status", "systemctl stop nginx"));
  assert.ok(!patternMatches("df -h", "df -hT"), "no partial-token match");
  assert.ok(!patternMatches("docker ps", "docker"), "pattern longer than command");
  assert.ok(!patternMatches("df -h", "df -h; reboot"));
  assert.ok(!patternMatches("df -h", "df -h $(reboot)"));
});

test("interpreters, privilege tools and destructive programs cannot be patterns", () => {
  for (const p of ["bash", "sh -c", "sudo systemctl status", "env", "xargs", "python3 -V", "python3.12",
    "/usr/bin/sudo ls", "find /", "awk", "rm -rf", "curl", "kill", "psql -c", "crontab -l", "nohup df"]) {
    assert.equal(normalizePattern(p), null, p);
  }
});

test("multi-purpose tools need a subcommand", () => {
  for (const p of ["docker", "systemctl", "git", "apt", "kubectl", "journalctl"]) assert.equal(normalizePattern(p), null, p);
  assert.equal(normalizePattern("docker ps"), "docker ps");
  assert.equal(normalizePattern("systemctl  status"), "systemctl status");
  assert.equal(normalizePattern("journalctl -u"), "journalctl -u");
  assert.equal(normalizePattern("df -h"), "df -h");
  assert.equal(normalizePattern("uptime"), "uptime");
});

test("stored patterns are re-validated at match time", () => {
  assert.ok(!patternMatches("bash", "bash -c id"), "a forbidden pattern stored earlier matches nothing");
  assert.ok(!patternMatches("docker", "docker rm -f db"));
});
