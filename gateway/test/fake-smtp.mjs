import fs from "node:fs";
import net from "node:net";

const port = Number(process.env.FAKE_SMTP_PORT || 2525);
const output = process.env.FAKE_SMTP_OUTPUT || "/tmp/commender-smtp.jsonl";

function write(socket, line) {
  socket.write(line + "\r\n");
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  write(socket, "220 fake-smtp ESMTP ready");

  let buffer = "";
  let dataMode = false;
  let message = "";

  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);

      if (dataMode) {
        if (line === ".") {
          fs.appendFileSync(output, JSON.stringify({
            receivedAt: new Date().toISOString(),
            message,
          }) + "\n");
          message = "";
          dataMode = false;
          write(socket, "250 2.0.0 queued");
          continue;
        }
        message += (message ? "\n" : "") + (line.startsWith("..") ? line.slice(1) : line);
        continue;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO ")) {
        write(socket, "250-fake-smtp");
        write(socket, "250 SIZE 10485760");
      } else if (upper.startsWith("HELO ")) {
        write(socket, "250 fake-smtp");
      } else if (upper.startsWith("MAIL FROM:")) {
        write(socket, "250 2.1.0 sender ok");
      } else if (upper.startsWith("RCPT TO:")) {
        write(socket, "250 2.1.5 recipient ok");
      } else if (upper === "DATA") {
        dataMode = true;
        write(socket, "354 end data with <CR><LF>.<CR><LF>");
      } else if (upper === "RSET") {
        message = "";
        dataMode = false;
        write(socket, "250 reset");
      } else if (upper === "NOOP") {
        write(socket, "250 ok");
      } else if (upper === "QUIT") {
        write(socket, "221 2.0.0 bye");
        socket.end();
      } else {
        write(socket, "502 command not implemented");
      }
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("fake-smtp listening on " + port + "\n");
});
