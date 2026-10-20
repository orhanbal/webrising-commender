import fs from "node:fs/promises";
import net from "node:net";

const host = process.env.SMTP_TEST_HOST || "127.0.0.1";
const port = Number(process.env.SMTP_TEST_PORT || 2525);
const output = process.env.SMTP_TEST_OUTPUT || "/tmp/commender-smtp.jsonl";

await fs.writeFile(output, "");

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let inData = false;
  let dataLines = [];

  const reply = (line) => socket.write(line + "\r\n");
  reply("220 commender-ci ESMTP ready");

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/, "");
      buffer = buffer.slice(index + 1);

      if (inData) {
        if (line === ".") {
          const data = dataLines.join("\r\n");
          dataLines = [];
          inData = false;
          void fs.appendFile(
            output,
            JSON.stringify({ receivedAt: new Date().toISOString(), data }) + "\n",
          );
          reply("250 2.0.0 queued");
        } else {
          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        }
        continue;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO ")) {
        socket.write("250-commender-ci\r\n250 SIZE 10485760\r\n");
      } else if (upper.startsWith("HELO ")) {
        reply("250 commender-ci");
      } else if (upper.startsWith("MAIL FROM:")) {
        reply("250 2.1.0 ok");
      } else if (upper.startsWith("RCPT TO:")) {
        reply("250 2.1.5 ok");
      } else if (upper === "DATA") {
        inData = true;
        reply("354 end with <CRLF>.<CRLF>");
      } else if (upper === "RSET" || upper === "NOOP") {
        reply("250 ok");
      } else if (upper === "QUIT") {
        reply("221 2.0.0 bye");
        socket.end();
      } else {
        reply("502 5.5.2 command not implemented");
      }
    }
  });
});

server.listen(port, host, () => {
  process.stdout.write(`fake smtp listening on ${host}:${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
