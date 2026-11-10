//! Drives the real `wecommander-core` binary over its JSON-lines protocol
//! against a real sshd on 127.0.0.1 (Linux; skipped elsewhere or without
//! sshd), the way the native apps will.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

fn sshd() -> Option<PathBuf> {
    cfg!(target_os = "linux")
        .then(|| PathBuf::from("/usr/sbin/sshd"))
        .filter(|p| p.exists())
}

fn keygen(path: &Path) {
    assert!(Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(path)
        .status()
        .unwrap()
        .success());
}

fn user() -> String {
    String::from_utf8(Command::new("id").arg("-un").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned()
}

struct Core {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Value>,
    next: u64,
    events: Vec<Value>,
}

impl Core {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        writeln!(
            self.stdin,
            "{}",
            json!({"id": id, "method": method, "params": params})
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("no reply to {method}"));
            if line.get("id") == Some(&json!(id)) {
                return match line.get("error") {
                    Some(e) => Err(e.as_str().unwrap_or_default().to_owned()),
                    None => Ok(line["result"].clone()),
                };
            }
            self.events.push(line);
        }
    }

    fn wait_event(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self.events.iter().position(&pred) {
            return self.events.remove(i);
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("event did not arrive");
            if pred(&line) {
                return line;
            }
            self.events.push(line);
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn native_app_flow_over_json_lines() {
    let Some(sshd) = sshd() else {
        eprintln!("sshd not available; skipping");
        return;
    };
    let dir = std::env::temp_dir().join(format!("wc-sidecar-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    keygen(&dir.join("host"));
    keygen(&dir.join("id"));
    std::fs::copy(dir.join("id.pub"), dir.join("authorized_keys")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        dir.join("sshd_config"),
        format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host\nAuthorizedKeysFile {d}/authorized_keys\n\
             PidFile {d}/sshd.pid\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nPermitRootLogin yes\n\
             AllowUsers {u}\nSubsystem sftp internal-sftp\n",
            d = dir.display(),
            u = user()
        ),
    )
    .unwrap();
    let mut server = Command::new(sshd)
        .args(["-D", "-e", "-f"])
        .arg(dir.join("sshd_config"))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut child = Command::new(env!("CARGO_BIN_EXE_wecommander-core"))
        .args(["--data-dir"])
        .arg(dir.join("data"))
        .args(["--keyring-service", "app.wecommander.test"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send(v);
            }
        }
    });
    let mut core = Core {
        child,
        stdin,
        lines,
        next: 0,
        events: vec![],
    };
    let ready = core.wait_event(|e| e["event"] == "ready");
    assert!(ready["data"]["vaultBackend"].is_string());

    // Host, first contact -> host key prompt, then approve with a typed key.
    let hosts = core
        .call("hosts.add", json!({"label": "Local", "host": "127.0.0.1", "port": port, "user": user(), "authKind": "key"}))
        .unwrap();
    let id = hosts[0]["id"].as_str().unwrap().to_owned();
    let key = std::fs::read_to_string(dir.join("id")).unwrap();
    let auth = json!({"kind": "key", "secret": key, "passphrase": null, "remember": true, "keyPath": null});
    let first = core
        .call(
            "connect",
            json!({"id": id, "auth": auth, "mode": "terminal"}),
        )
        .unwrap();
    assert_eq!(first["status"], "hostKeyUnknown");
    let fp = first["fingerprint"].as_str().unwrap().to_owned();
    let opened = core
        .call("connect", json!({"id": id, "auth": auth, "acceptFingerprint": fp, "mode": "terminal", "cols": 100, "rows": 30}))
        .unwrap();
    assert_eq!(opened["status"], "terminalOpened");
    let sid = opened["sessionId"].as_str().unwrap().to_owned();

    // Terminal round trip through events (output is base64).
    core.call(
        "terminal.write",
        json!({"sessionId": sid, "data": "echo sidecar-$((40+2))\n"}),
    )
    .unwrap();
    let mut seen = String::new();
    while !seen.contains("sidecar-42") {
        let ev = core.wait_event(|e| e["event"] == "terminal-output");
        let b64 = ev["data"]["data"].as_str().unwrap();
        seen.push_str(&String::from_utf8_lossy(&decode(b64)));
    }

    // SFTP listing of the login folder.
    let listing = core.call("files.list", json!({"sessionId": sid})).unwrap();
    assert!(listing["path"].as_str().unwrap().starts_with('/'));

    // Forward to a local echo server through the SSH connection.
    let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in echo.incoming().flatten() {
            let mut r = s.try_clone().unwrap();
            let mut w = s;
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut r, &mut w);
            });
        }
    });
    let fw = core
        .call("forward.start", json!({"sessionId": sid, "localPort": 0, "remoteHost": "127.0.0.1", "remotePort": echo_port}))
        .unwrap();
    let local = fw[0]["local"].as_str().unwrap().to_owned();
    let mut c = std::net::TcpStream::connect(&local).unwrap();
    c.write_all(b"ping").unwrap();
    let mut buf = [0u8; 4];
    std::io::Read::read_exact(&mut c, &mut buf).unwrap();
    assert_eq!(&buf, b"ping");

    // Saved state survives: host key trusted, credential saved (memory or keyring).
    let hosts = core.call("hosts.list", json!({})).unwrap();
    assert_eq!(hosts[0]["trustedKey"], json!(fp));

    // Exit status reaches the app.
    core.call(
        "terminal.write",
        json!({"sessionId": sid, "data": "exit 5\n"}),
    )
    .unwrap();
    let exit = core.wait_event(|e| e["event"] == "terminal-exit");
    assert_eq!(exit["data"]["code"], 5);

    assert!(core
        .call("no.such", json!({}))
        .unwrap_err()
        .contains("unknown method"));
    drop(core);
    let _ = server.kill();
    let _ = server.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

fn decode(b64: &str) -> Vec<u8> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in b64.bytes().filter(|c| *c != b'=') {
        acc = (acc << 6) | T.iter().position(|x| *x == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
