//! Hybrid Access H2 end to end: the real `wecommander-core` serves the local
//! MCP endpoint in a temp folder, an AI client talks to it through a second
//! process (`wecommander-core --mcp-stdio`, the bridge), and the tools run
//! against a real sshd on 127.0.0.1 (Linux with sshd; skipped elsewhere).
#![cfg(unix)]
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

/// A child process speaking JSON lines.
struct Proc {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Value>,
    next: u64,
    seen: Vec<Value>,
}

impl Proc {
    fn start(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_wecommander-core"))
            .args(args)
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
        Self {
            child,
            stdin,
            lines,
            next: 0,
            seen: vec![],
        }
    }

    fn send(&mut self, message: Value) -> u64 {
        self.next += 1;
        let mut m = message;
        m["id"] = json!(self.next);
        writeln!(self.stdin, "{m}").unwrap();
        self.next
    }

    fn wait(&mut self, pred: impl Fn(&Value) -> bool, what: &str) -> Value {
        if let Some(i) = self.seen.iter().position(&pred) {
            return self.seen.remove(i);
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("no {what}"));
            if pred(&line) {
                return line;
            }
            self.seen.push(line);
        }
    }

    fn reply(&mut self, id: u64) -> Value {
        self.wait(|l| l.get("id") == Some(&json!(id)), &format!("reply {id}"))
    }

    /// Core RPC.
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send(json!({"method": method, "params": params}));
        let r = self.reply(id);
        match r.get("error") {
            Some(e) => Err(e.as_str().unwrap_or_default().to_owned()),
            None => Ok(r["result"].clone()),
        }
    }

    fn event(&mut self, name: &str) -> Value {
        self.wait(|l| l["event"] == name, name)["data"].clone()
    }

    /// MCP over the bridge.
    fn mcp(&mut self, method: &str, params: Value) -> u64 {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    fn tool(&mut self, name: &str, args: Value) -> u64 {
        self.mcp("tools/call", json!({"name": name, "arguments": args}))
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn structured(r: &Value) -> &Value {
    &r["result"]["structuredContent"]
}

/// H3/H4: the calls the app hands over from the gateway (`mcp.remoteCall`)
/// for a host shared remotely through this computer.
fn remote_through_this_computer(core: &mut Proc, host: &str, dir: &Path) {
    let center = "center-e2e";
    core.call(
        "hosts.setAiAccess",
        json!({"id": host, "aiAccess": {"local": true, "remote": true, "connector": center, "preset": "approval"}}),
    )
    .unwrap();
    let published = core
        .call("mcp.remoteTargets", json!({"centerId": center}))
        .unwrap();
    assert_eq!(published.as_array().unwrap().len(), 1);
    assert_eq!(published[0]["hostId"], json!(host));
    assert!(!published.to_string().contains("127.0.0.1"));
    assert_eq!(
        core.call("mcp.remoteTargets", json!({"centerId": "someone-else"}))
            .unwrap(),
        json!([])
    );
    let mut n = 0;
    let mut remote = |core: &mut Proc, tool: &str, args: Value, approved: bool| {
        n += 1;
        let mut args = args;
        args["target"] = json!(host);
        core.call(
            "mcp.remoteCall",
            json!({"callId": format!("call-{n}"), "centerId": center, "client": "ChatGPT", "tool": tool, "args": args, "approved": approved}),
        )
        .unwrap()
    };
    let p = |name: &str| dir.join(name).to_string_lossy().into_owned();
    let r = remote(core, "fs_read", json!({"path": p("note.txt")}), false);
    assert_eq!(r["result"]["content"], "hybrid access works\n", "{r}");
    // A command without the gateway's approval is refused; with it, it runs.
    let r = remote(
        core,
        "process_exec",
        json!({"command": "echo remote-$((1+1))"}),
        false,
    );
    assert_eq!(r["error"], "approval_required", "{r}");
    let r = remote(
        core,
        "process_exec",
        json!({"command": "echo remote-$((1+1))"}),
        true,
    );
    assert!(
        r["result"]["output"].as_str().unwrap().contains("remote-2"),
        "{r}"
    );
    // Writes: create, refuse a link (never followed), move, delete.
    let outside = dir.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), "keep").unwrap();
    let r = remote(
        core,
        "fs_write",
        json!({"path": p("w/a.txt"), "content_base64": "YQ==", "create_parents": true}),
        true,
    );
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(std::fs::read_to_string(dir.join("w/a.txt")).unwrap(), "a");
    std::os::unix::fs::symlink(outside.join("keep.txt"), dir.join("w/link.txt")).unwrap();
    let r = remote(
        core,
        "fs_write",
        json!({"path": p("w/link.txt"), "content_base64": "eA=="}),
        true,
    );
    assert_eq!(r["error"], "symlink_refused", "{r}");
    assert_eq!(
        std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "keep"
    );
    // A stale write is refused.
    let r = remote(
        core,
        "fs_write",
        json!({"path": p("w/a.txt"), "content_base64": "Yg==", "expected_sha256": "0".repeat(64)}),
        true,
    );
    assert_eq!(r["error"], "stale_content", "{r}");
    let r = remote(core, "fs_mkdir", json!({"path": p("w/sub")}), true);
    assert_eq!(r["result"]["created"], true, "{r}");
    let r = remote(
        core,
        "fs_move",
        json!({"source": p("w/a.txt"), "destination": p("note.txt")}),
        true,
    );
    assert_eq!(r["error"], "destination_exists", "{r}");
    let r = remote(
        core,
        "fs_move",
        json!({"source": p("w/a.txt"), "destination": p("w/sub/b.txt")}),
        true,
    );
    assert_eq!(r["ok"], true, "{r}");
    std::os::unix::fs::symlink(&outside, dir.join("w/sub/outside-link")).unwrap();
    let r = remote(core, "fs_delete", json!({"path": p("w")}), true);
    assert_eq!(r["error"], "folder_not_empty", "{r}");
    let r = remote(
        core,
        "fs_delete",
        json!({"path": p("w"), "recursive": true}),
        true,
    );
    assert_eq!(r["ok"], true, "{r}");
    assert!(!dir.join("w").exists());
    // The linked folder outside was not followed.
    assert_eq!(
        std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "keep"
    );
    let r = remote(
        core,
        "fs_delete",
        json!({"path": "~", "recursive": true}),
        true,
    );
    assert_eq!(r["error"], "protected_path", "{r}");
    // A call id runs once.
    let again = core
        .call(
            "mcp.remoteCall",
            json!({"callId": "call-1", "centerId": center, "tool": "targets_list"}),
        )
        .unwrap();
    assert_eq!(again["error"], "duplicate_call");
    let audit = std::fs::read_to_string(dir.join("data").join("mcp-audit.jsonl")).unwrap();
    assert!(audit.contains("remote-mcp") && audit.contains("symlink_refused"));
}

#[test]
fn local_mcp_through_the_bridge_against_sshd() {
    let Some(sshd) = sshd() else {
        eprintln!("sshd not available; skipping");
        return;
    };
    let dir = std::env::temp_dir().join(format!("wc-mcp-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    keygen(&dir.join("host"));
    keygen(&dir.join("id"));
    std::fs::copy(dir.join("id.pub"), dir.join("authorized_keys")).unwrap();
    std::fs::write(dir.join("note.txt"), "hybrid access works\n").unwrap();
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

    // The bridge with no app running: initialize works, calls are refused.
    let endpoint = dir.join("run").join("mcp.sock");
    let ep = endpoint.to_string_lossy().into_owned();
    let mut bridge = Proc::start(&["--mcp-stdio", "--mcp-endpoint", &ep]);
    let id = bridge.mcp(
        "initialize",
        json!({"protocolVersion": "2025-06-18", "clientInfo": {"name": "e2e-client", "version": "9"}}),
    );
    assert_eq!(
        bridge.reply(id)["result"]["serverInfo"]["name"],
        "WECOMMANDER"
    );
    let id = bridge.tool("targets_list", json!({}));
    let r = bridge.reply(id);
    assert_eq!(structured(&r)["error"], "wecommander_not_running");

    // The app core with its endpoint in the temp folder.
    let data = dir.join("data");
    let mut core = Proc::start(&[
        "--data-dir",
        &data.to_string_lossy(),
        "--keyring-service",
        "app.wecommander.test.mcp",
        "--mcp-endpoint",
        &ep,
    ]);
    core.event("ready");
    let mut status = json!(null);
    for _ in 0..100 {
        status = core.call("mcp.status", json!({})).unwrap();
        if status["enabled"] == true {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(status["enabled"], true, "{status}");
    assert_eq!(status["remoteSupported"], true);
    assert_eq!(status["bridgeCommand"][1], "--mcp-stdio");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(endpoint.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    // A second core does not take the endpoint over.
    let mut other = Proc::start(&[
        "--data-dir",
        &dir.join("data2").to_string_lossy(),
        "--keyring-service",
        "app.wecommander.test.mcp2",
        "--mcp-endpoint",
        &ep,
    ]);
    other.event("ready");
    std::thread::sleep(Duration::from_millis(300));
    let s2 = other.call("mcp.status", json!({})).unwrap();
    assert_eq!(s2["enabled"], false, "{s2}");
    assert!(s2["error"]
        .as_str()
        .unwrap()
        .contains("another WECOMMANDER core"));
    drop(other);

    // A saved host, logged in once (host key approved, key remembered).
    let hosts = core
        .call("hosts.add", json!({"label": "Local", "host": "127.0.0.1", "port": port, "user": user(), "authKind": "key"}))
        .unwrap();
    let host = hosts[0]["id"].as_str().unwrap().to_owned();
    // Not trusted yet: AI access is refused (never TOFU).
    let err = core
        .call(
            "hosts.setAiAccess",
            json!({"id": host, "aiAccess": {"local": true}}),
        )
        .unwrap_err();
    assert!(err.starts_with("host_key_untrusted:"), "{err}");
    let key = std::fs::read_to_string(dir.join("id")).unwrap();
    let auth = json!({"kind": "key", "secret": key, "passphrase": null, "remember": true, "keyPath": null});
    let first = core
        .call("connect", json!({"id": host, "auth": auth, "mode": "test"}))
        .unwrap();
    let fp = first["fingerprint"].as_str().unwrap().to_owned();
    core.call(
        "connect",
        json!({"id": host, "auth": auth, "acceptFingerprint": fp, "mode": "test"}),
    )
    .unwrap();
    let hosts = core
        .call(
            "hosts.setAiAccess",
            json!({"id": host, "aiAccess": {"local": true, "preset": "approval"}}),
        )
        .unwrap();
    assert_eq!(hosts[0]["aiAccess"]["local"], true);
    // The same server under another name has no trusted key: refused.
    let hosts = core
        .call("hosts.add", json!({"label": "Alias", "host": "localhost", "port": port, "user": user(), "authKind": "key"}))
        .unwrap();
    let alias = hosts[1]["id"].as_str().unwrap().to_owned();
    assert!(core
        .call(
            "hosts.setAiAccess",
            json!({"id": alias, "aiAccess": {"local": true}})
        )
        .unwrap_err()
        .starts_with("host_key_untrusted:"));

    // The bridge reaches the app now (initialize replayed), and the unknown
    // client waits for the person.
    let call = bridge.tool("targets_list", json!({}));
    let ask = core.event("mcp-client-request");
    assert_eq!(ask["name"], "e2e-client");
    let clients = core
        .call("mcp.allowClient", json!({"id": ask["id"], "allow": true}))
        .unwrap();
    assert_eq!(clients[0]["allowed"], true);
    let r = bridge.reply(call);
    let targets = &structured(&r)["targets"];
    assert_eq!(targets.as_array().unwrap().len(), 1, "{r}");
    assert_eq!(targets[0]["target_id"], json!(host));
    assert_eq!(targets[0]["capabilities"]["path_policy"], "none");
    assert!(!r.to_string().contains("127.0.0.1"));

    // Read tools over SFTP.
    let note = dir.join("note.txt").to_string_lossy().into_owned();
    let id = bridge.tool("fs_read", json!({"target": host, "path": note}));
    let r = bridge.reply(id);
    assert_eq!(structured(&r)["content"], "hybrid access works\n", "{r}");
    let id = bridge.tool(
        "fs_read",
        json!({"target": host, "path": note, "max_bytes": 4}),
    );
    assert_eq!(structured(&bridge.reply(id))["error"], "file_too_large");
    let id = bridge.tool("fs_stat", json!({"target": host, "path": note}));
    let r = bridge.reply(id);
    assert_eq!(structured(&r)["isFile"], true);
    assert_eq!(structured(&r)["size"], 20);
    let id = bridge.tool(
        "list_directory",
        json!({"target": host, "path": dir.to_string_lossy()}),
    );
    let r = bridge.reply(id);
    assert!(
        structured(&r)["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "note.txt"),
        "{r}"
    );
    let id = bridge.tool("server_overview", json!({}));
    let r = bridge.reply(id);
    assert_eq!(r["result"]["isError"], false, "{r}");
    assert!(structured(&r)["hostname"].is_string());

    // A command: one-time approval in the app, exact command shown.
    let cmd = "echo hi-$((40+2)); echo DB_PASSWORD=hunter2xyz";
    let call = bridge.tool(
        "process_exec",
        json!({"target": host, "command": cmd, "cwd": dir.to_string_lossy()}),
    );
    let approval = core.event("mcp-approval");
    assert_eq!(approval["command"], cmd);
    assert_eq!(approval["targetLabel"], "Local");
    assert!(approval["expiresAt"].as_str().unwrap().ends_with('Z'));
    core.call(
        "mcp.decide",
        json!({"approvalId": approval["approvalId"], "approve": true}),
    )
    .unwrap();
    let r = bridge.reply(call);
    let out = structured(&r);
    assert_eq!(out["exitCode"], 0, "{r}");
    assert!(out["output"].as_str().unwrap().contains("hi-42"));
    assert!(out["output"]
        .as_str()
        .unwrap()
        .contains("DB_PASSWORD=[REDACTED]"));
    assert!(!r.to_string().contains("hunter2xyz"));
    // The approval was used: deciding it again fails.
    assert!(core
        .call(
            "mcp.decide",
            json!({"approvalId": approval["approvalId"], "approve": true})
        )
        .unwrap_err()
        .starts_with("approval_used"));
    assert!(core
        .call("mcp.decide", json!({"approvalId": "nope", "approve": true}))
        .unwrap_err()
        .starts_with("unknown_approval"));

    // H4: a file write through local MCP, approved in the app with the
    // exact path, size and SHA-256.
    let new_file = dir.join("made").join("by-ai.txt");
    let call = bridge.tool(
        "fs_write",
        json!({"target": host, "path": new_file.to_string_lossy(), "content_base64": "aGVsbG8gZnJvbSBBSQo=", "create_parents": true}),
    );
    let approval = core.event("mcp-approval");
    assert_eq!(approval["tool"], "fs_write");
    let shown = approval["command"].as_str().unwrap();
    assert!(
        shown.contains("by-ai.txt") && shown.contains("14 B"),
        "{shown}"
    );
    core.call(
        "mcp.decide",
        json!({"approvalId": approval["approvalId"], "approve": true}),
    )
    .unwrap();
    let r = bridge.reply(call);
    assert_eq!(r["result"]["isError"], false, "{r}");
    assert_eq!(
        std::fs::read_to_string(&new_file).unwrap(),
        "hello from AI\n"
    );

    remote_through_this_computer(&mut core, &host, &dir);

    // Guards: sudo, readonly, target not exposed.
    let id = bridge.tool(
        "process_exec",
        json!({"target": host, "command": "sudo -n true"}),
    );
    assert_eq!(structured(&bridge.reply(id))["error"], "sudo_not_allowed");
    core.call(
        "hosts.setAiAccess",
        json!({"id": host, "aiAccess": {"local": true, "preset": "readonly"}}),
    )
    .unwrap();
    let id = bridge.tool("process_exec", json!({"target": host, "command": "uptime"}));
    assert_eq!(structured(&bridge.reply(id))["error"], "readonly_preset");
    let id = bridge.tool("fs_list", json!({"target": alias, "path": "/"}));
    assert_eq!(structured(&bridge.reply(id))["error"], "target_not_exposed");
    let activity = core.event("mcp-activity");
    assert!(activity["at"].as_str().unwrap().ends_with('Z'));

    // Audit: tools and outcomes, never the command or file contents.
    let audit = std::fs::read_to_string(data.join("mcp-audit.jsonl")).unwrap();
    assert!(audit.contains("\"process_exec\"") && audit.contains("readonly_preset"));
    assert!(
        !audit.contains("hunter2")
            && !audit.contains("hybrid access works")
            && !audit.contains("echo")
    );

    // The app closes: the bridge answers that it is not running.
    drop(core);
    std::thread::sleep(Duration::from_millis(200));
    let id = bridge.tool("targets_list", json!({}));
    assert_eq!(
        structured(&bridge.reply(id))["error"],
        "wecommander_not_running"
    );

    drop(bridge);
    let _ = server.kill();
    let _ = server.wait();
    let _ = std::fs::remove_dir_all(&dir);
}
