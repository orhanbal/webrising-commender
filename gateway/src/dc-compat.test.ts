import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl, fetchUrl, isPublicAddress, planEdit, translateAlias } from "./dc-compat.js";

test("edit_block: exact match replaces exactly expected_replacements", () => {
  const plan = planEdit("a = 1\nb = 2\n", "b = 2", "b = 3");
  assert.deepEqual(plan, { ok: true, content: "a = 1\nb = 3\n", replacements: 1, mode: "exact" });
  const twice = planEdit("x\nx\n", "x", "y");
  assert.equal(twice.ok, false);
  assert.equal((twice as any).error, "match_count_mismatch");
  assert.equal((twice as any).matches, 2);
  assert.equal(planEdit("x\nx\n", "x", "y", 2).ok, true);
});

test("edit_block: whitespace-tolerant match only when unique", () => {
  const src = "function f() {\n    if (a)   {\r\n        return 1;\n    }\n}\n";
  const plan = planEdit(src, "if (a) {\n  return 1;\n}", "if (a) {\n  return 2;\n}");
  assert.equal(plan.ok, true);
  assert.equal((plan as any).mode, "whitespace");
  assert.match((plan as any).content, /return 2;/);
  assert.doesNotMatch((plan as any).content, /return 1;/);
  const dup = planEdit("a  b\na b\n", "a\tb", "c");
  assert.equal(dup.ok, false);
  assert.equal((dup as any).matches, 2);
});

test("edit_block: no match reports the closest line and changes nothing", () => {
  const plan = planEdit("const timeout = 30;\nconst retries = 5;\n", "const timeOut = 30;", "x");
  assert.equal(plan.ok, false);
  assert.equal((plan as any).error, "no_match");
  assert.equal((plan as any).closest_line, 1);
  assert.equal(planEdit("abc", "", "x").ok, false);
  assert.equal(planEdit("abc", "abc", "x", 0).ok, false);
});

test("aliases map to native tools", () => {
  assert.deepEqual(translateAlias("read_file", { path: "/a" }), { name: "fs_read", args: { path: "/a" } });
  assert.deepEqual(translateAlias("read_file", { path: "/a", offset: -10, length: 5, device_id: "d" }),
    { name: "fs_read_lines", args: { device_id: "d", path: "/a", offset_lines: -10, limit_lines: 5 } });
  assert.deepEqual(translateAlias("write_file", { path: "/a", content: "hé" }),
    { name: "fs_write", args: { path: "/a", content_base64: Buffer.from("hé").toString("base64"), create_parents: true } });
  assert.equal(translateAlias("write_file", { path: "/a", content: "x", mode: "append" })!.name, "fs_append");
  assert.deepEqual(translateAlias("create_directory", { path: "/d" }), { name: "fs_mkdir", args: { path: "/d", recursive: true } });
  assert.deepEqual(translateAlias("read_file", { path: "/r/A.PDF", offset: 0, length: 3 }),
    { name: "pdf_read", args: { path: "/r/A.PDF", start_page: 1, page_count: 3 } });
  assert.deepEqual(translateAlias("read_file", { path: "/r/a.pdf", offset: -2 }),
    { name: "pdf_read", args: { path: "/r/a.pdf", start_page: -2 } });
  assert.equal(translateAlias("edit_block", {}), null);
});

test("url_fetch refuses private, loopback, link-local and odd schemes", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "148.135.181.148", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  const lookup = (async (host: string) => host === "evil.test" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]) as any;
  await assert.rejects(assertPublicUrl("http://evil.test/latest/meta-data", lookup), /private_address_refused/);
  await assert.rejects(assertPublicUrl("http://127.0.0.1:8787/", lookup), /private_address_refused/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd", lookup), /url_not_allowed/);
  await assert.rejects(assertPublicUrl("https://u:p@example.com", lookup), /url_not_allowed/);
  assert.equal((await assertPublicUrl("https://example.com/x", lookup)).hostname, "example.com");
});

test("url_fetch re-checks redirects and bounds the body", async () => {
  const lookup = (async (host: string) => host === "internal.test" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]) as any;
  const redirecting = (async () => new Response("", { status: 302, headers: { location: "http://internal.test/admin" } })) as unknown as typeof fetch;
  await assert.rejects(fetchUrl("https://example.com/", redirecting, lookup), /private_address_refused/);
  const big = (async () => new Response("a".repeat(1024 * 1024 + 10), { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
  const result = await fetchUrl("https://example.com/", big, lookup);
  assert.equal(result.truncated, true);
  assert.equal((result as any).text.length, 1024 * 1024);
  const binary = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  assert.equal((await fetchUrl("https://example.com/", binary, lookup) as any).error, "binary_content_not_returned");
});
