import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import WebSocket from "ws";

const base = process.env.TEST_TLS_BASE_URL || "https://localhost:9443";
const caFile = process.env.TEST_TLS_CA_FILE;
if (!caFile) throw new Error("TEST_TLS_CA_FILE is required");

const ca = fs.readFileSync(caFile);

const health = await new Promise((resolve, reject) => {
  const request = https.get(
    base + "/health",
    { ca },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: JSON.parse(body),
        });
      });
    },
  );
  request.on("error", reject);
});

assert.equal(health.status, 200);
assert.equal(health.body.status, "ok");
assert.equal(health.body.database, "ok");
assert.equal(health.body.transport, "https");
assert.match(
  String(health.headers["strict-transport-security"] || ""),
  /max-age=31536000/,
);

await new Promise((resolve, reject) => {
  let settled = false;
  const wsUrl = base.replace(/^https:/, "wss:") + "/agent";
  const socket = new WebSocket(wsUrl, { ca });

  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    socket.removeAllListeners();
    fn(value);
  };

  socket.once("open", () => {
    finish(reject, new Error("unauthenticated WSS connection unexpectedly opened"));
  });
  socket.once("unexpected-response", (_request, response) => {
    try {
      assert.equal(response.statusCode, 401);
      finish(resolve);
    } catch (error) {
      finish(reject, error);
    }
  });
  socket.once("error", (error) => {
    finish(reject, error);
  });
  setTimeout(() => {
    finish(reject, new Error("WSS TLS acceptance timed out"));
  }, 5000).unref();
});

console.log("tls-smoke: ok");
