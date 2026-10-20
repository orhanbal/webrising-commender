import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://commender:commender@127.0.0.1:5432/commender";
const mailModule = await import("./mail.js");

const baseConfig = {
  host: "127.0.0.1",
  port: 25,
  security: "plain",
  username: null,
  password: null,
  from: "commender@example.test",
  fromName: "WebRising Commender",
  helo: "commender.test",
  rejectUnauthorized: true,
  allowInsecureAuth: false,
};

test("SMTP message formatting rejects header injection and dot-stuffs body lines", () => {
  const formatted = mailModule.formatSmtpMessage(baseConfig, {
    kind: "email_verification",
    to: "user@example.test",
    subject: "Verify account",
    text: "first\n.secret\nlast",
  });

  assert.match(formatted, /Subject: Verify account/);
  assert.match(formatted, /\r\n\.\.secret\r\n/);
  assert.throws(
    () =>
      mailModule.formatSmtpMessage(baseConfig, {
        kind: "password_reset",
        to: "user@example.test",
        subject: "Reset\r\nBcc: attacker@example.test",
        text: "body",
      }),
    /invalid subject/,
  );
});

test("first-party SMTP client completes a local relay conversation", async (t) => {
  const commands = [];
  let messageData = "";

  const server = net.createServer((socket) => {
    socket.write("220 local.test ESMTP ready\r\n");
    let buffer = "";
    let inData = false;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      while (true) {
        if (inData) {
          const terminator = buffer.indexOf("\r\n.\r\n");
          if (terminator < 0) return;
          messageData += buffer.slice(0, terminator + 2);
          buffer = buffer.slice(terminator + 5);
          inData = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }

        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push(line);

        if (line.startsWith("EHLO ")) {
          socket.write("250-local.test\r\n250 PIPELINING\r\n");
        } else if (line.startsWith("MAIL FROM:")) {
          socket.write("250 2.1.0 ok\r\n");
        } else if (line.startsWith("RCPT TO:")) {
          socket.write("250 2.1.5 ok\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (line === "QUIT") {
          socket.write("221 2.0.0 bye\r\n");
          socket.end();
        } else {
          socket.write("500 unexpected command\r\n");
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");

  await mailModule.sendSmtpMail(
    { ...baseConfig, port: address.port },
    {
      kind: "password_reset",
      to: "user@example.test",
      subject: "Password reset",
      text: "reset body",
    },
  );

  assert.ok(commands.some((line) => line.startsWith("EHLO ")));
  assert.ok(commands.includes("MAIL FROM:<commender@example.test>"));
  assert.ok(commands.includes("RCPT TO:<user@example.test>"));
  assert.ok(commands.includes("DATA"));
  assert.ok(commands.includes("QUIT"));
  assert.match(messageData, /Subject: Password reset/);
  assert.match(messageData, /reset body/);
});
