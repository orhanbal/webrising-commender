//! Talks to a real OpenSSH server started for the test on 127.0.0.1.
//! Runs on Linux; skipped (passes with a note) elsewhere or when `sshd` is
//! not installed. The G2 matrix (older OpenSSH, Windows OpenSSH, macOS sshd)
//! runs against real hosts, not here.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use wc_ssh_core::client::{connect, ConnectOptions, Credential, SshError};
use wc_ssh_core::HostProfile;

struct Sshd {
    child: Child,
    port: u16,
    dir: PathBuf,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn sshd_path() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    [
        "/usr/sbin/sshd",
        "/usr/local/sbin/sshd",
        "/opt/homebrew/sbin/sshd",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

fn keygen(path: &Path, kind: &str, passphrase: &str) {
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", kind, "-N", passphrase, "-C", "wc-test", "-f"])
        .arg(path)
        .status()
        .expect("ssh-keygen");
    assert!(status.success());
}

fn fingerprint(pub_path: &Path) -> String {
    let out = Command::new("ssh-keygen")
        .args(["-l", "-E", "sha256", "-f"])
        .arg(pub_path)
        .output()
        .expect("ssh-keygen -l");
    String::from_utf8(out.stdout)
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned()
}

fn whoami() -> String {
    let out = Command::new("id").arg("-un").output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn start(sshd: &Path, authorized: &[&Path]) -> Sshd {
    let dir =
        std::env::temp_dir().join(format!("wc-sshd-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    keygen(&dir.join("host_ed25519"), "ed25519", "");
    let mut keys = String::new();
    for k in authorized {
        keys.push_str(&std::fs::read_to_string(k.with_extension("pub")).unwrap());
    }
    std::fs::write(dir.join("authorized_keys"), keys).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let config = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host_ed25519\nAuthorizedKeysFile {d}/authorized_keys\n\
         PidFile {d}/sshd.pid\nStrictModes no\nUsePAM no\nPasswordAuthentication no\n\
         KbdInteractiveAuthentication no\nPermitRootLogin yes\nAllowUsers {user}\n\
         Subsystem sftp internal-sftp\n",
        d = dir.display(),
        user = whoami()
    );
    std::fs::write(dir.join("sshd_config"), config).unwrap();
    let child = Command::new(sshd)
        .args(["-D", "-e", "-f"])
        .arg(dir.join("sshd_config"))
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start sshd");
    let mut server = Sshd { child, port, dir };
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return server;
        }
        if let Ok(Some(status)) = server.child.try_wait() {
            panic!("sshd exited early ({status}); see its log above");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("sshd did not listen on port {}", server.port)
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

fn key(path: &Path, passphrase: Option<&str>) -> Credential {
    Credential::PrivateKey {
        key: std::fs::read_to_string(path).unwrap(),
        passphrase: passphrase.map(str::to_owned),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn openssh_host_key_auth_and_exec() {
    let Some(sshd) = sshd_path() else {
        eprintln!("sshd not installed; skipping OpenSSH interop test");
        return;
    };
    let keys = std::env::temp_dir().join(format!("wc-keys-{}", rand_suffix()));
    std::fs::create_dir_all(&keys).unwrap();
    let ed = keys.join("id_ed25519");
    let rsa = keys.join("id_rsa");
    let locked = keys.join("id_locked");
    let stranger = keys.join("id_stranger");
    keygen(&ed, "ed25519", "");
    keygen(&rsa, "rsa", "");
    keygen(&locked, "ed25519", "correct horse");
    keygen(&stranger, "ed25519", "");

    let server = start(&sshd, &[&ed, &rsa, &locked]);
    let host_fp = fingerprint(&server.dir.join("host_ed25519.pub"));
    let profile = HostProfile::new("local", "127.0.0.1", server.port, &whoami()).unwrap();
    let untrusted = ConnectOptions::default();
    let trusted = ConnectOptions {
        trusted_fingerprint: Some(host_fp.clone()),
        ..Default::default()
    };

    // 1. First contact: the key is reported, not accepted.
    match connect(&profile, &key(&ed, None), &untrusted).await {
        Err(SshError::HostKeyUnknown(k)) => {
            assert_eq!(k.algorithm, "ssh-ed25519");
            assert_eq!(
                k.fingerprint, host_fp,
                "fingerprint must match ssh-keygen -l"
            );
        }
        other => panic!("expected HostKeyUnknown, got {:?}", other.err()),
    }

    // 2. A different trusted key means the host key changed.
    let wrong = ConnectOptions {
        trusted_fingerprint: Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
        ..Default::default()
    };
    assert!(matches!(
        connect(&profile, &key(&ed, None), &wrong).await,
        Err(SshError::HostKeyChanged { .. })
    ));

    // 3. Trusted key + ed25519: exec returns stdout, stderr and exit status.
    let conn = connect(&profile, &key(&ed, None), &trusted)
        .await
        .expect("ed25519 login");
    assert_eq!(conn.host_key().fingerprint, host_fp);
    let out = conn
        .exec("echo hi; echo err >&2; exit 3", 1 << 20)
        .await
        .unwrap();
    assert_eq!(out.stdout, b"hi\n");
    assert_eq!(out.stderr, b"err\n");
    assert_eq!(out.exit_status, Some(3));
    conn.close().await.unwrap();

    // 4. RSA keys sign with rsa-sha2 (OpenSSH rejects ssh-rsa/SHA-1).
    let conn = connect(&profile, &key(&rsa, None), &trusted)
        .await
        .expect("rsa login");
    assert_eq!(conn.exec("true", 64).await.unwrap().exit_status, Some(0));
    conn.close().await.unwrap();

    // 5. Encrypted key: right passphrase works, wrong one fails locally.
    let conn = connect(&profile, &key(&locked, Some("correct horse")), &trusted)
        .await
        .expect("encrypted key login");
    conn.close().await.unwrap();
    assert!(matches!(
        connect(&profile, &key(&locked, Some("nope")), &trusted).await,
        Err(SshError::BadKey(_))
    ));

    // 6. A key the server does not know, and a password it does not allow.
    match connect(&profile, &key(&stranger, None), &trusted).await {
        Err(SshError::AuthFailed { remaining }) => {
            assert!(remaining.iter().any(|m| m == "publickey"))
        }
        other => panic!("expected AuthFailed, got {:?}", other.err()),
    }
    assert!(matches!(
        connect(&profile, &Credential::Password("x".into()), &trusted).await,
        Err(SshError::AuthFailed { .. })
    ));

    // 7. Interactive shell on a pty: output, resize, exit status.
    let conn = connect(&profile, &key(&ed, None), &trusted).await.unwrap();
    let mut shell = conn
        .open_shell("xterm-256color", 80, 24, &[])
        .await
        .expect("shell");
    shell.writer.resize(120, 40).await.unwrap();
    shell
        .writer
        .write(b"stty size; echo TERM=$TERM; exit 7\n")
        .await
        .unwrap();
    let mut text = String::new();
    let mut exit = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, shell.reader.next()).await {
        match event {
            wc_ssh_core::client::ShellEvent::Output(bytes) => {
                text.push_str(&String::from_utf8_lossy(&bytes))
            }
            wc_ssh_core::client::ShellEvent::Exit(code) => exit = Some(code),
        }
    }
    assert!(text.contains("40 120"), "pty size follows resize: {text:?}");
    assert!(text.contains("TERM=xterm-256color"), "{text:?}");
    assert_eq!(exit, Some(Some(7)));
    assert!(shell.reader.next().await.is_none());
    conn.close().await.unwrap();

    // 8. SFTP: upload, list, download, mkdir, rename, delete.
    let conn = connect(&profile, &key(&ed, None), &trusted).await.unwrap();
    let sftp = conn.sftp().await.expect("sftp subsystem");
    let home = sftp.home().await.unwrap();
    assert!(home.starts_with('/'), "{home}");
    let work = format!("{}/wc-sftp-{}", server.dir.display(), rand_suffix());
    sftp.mkdir(&work).await.unwrap();
    let local = keys.join("big.bin");
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i * 31 % 251) as u8).collect();
    std::fs::write(&local, &data).unwrap();
    let mut last = (0, 0);
    let sent = sftp
        .upload(&local, &format!("{work}/big.bin"), |d, t| last = (d, t))
        .await
        .unwrap();
    assert_eq!(sent, 3_000_000);
    assert_eq!(last, (3_000_000, 3_000_000));
    sftp.mkdir(&format!("{work}/sub")).await.unwrap();
    let names: Vec<_> = sftp
        .list(&work)
        .await
        .unwrap()
        .into_iter()
        .map(|e| (e.name, e.kind, e.size))
        .collect();
    assert_eq!(names[0].0, "sub", "folders first: {names:?}");
    assert!(names.contains(&("big.bin".into(), "file", 3_000_000)));
    sftp.rename(&format!("{work}/big.bin"), &format!("{work}/sub/moved.bin"))
        .await
        .unwrap();
    let back = keys.join("back.bin");
    let got = sftp
        .download(&format!("{work}/sub/moved.bin"), &back, |_, _| {})
        .await
        .unwrap();
    assert_eq!(got, 3_000_000);
    assert_eq!(
        std::fs::read(&back).unwrap(),
        data,
        "round trip is byte-exact"
    );
    assert!(!back.with_extension("wc-partial").exists());
    sftp.remove(&format!("{work}/sub/moved.bin")).await.unwrap();
    sftp.remove(&format!("{work}/sub")).await.unwrap();
    sftp.remove(&work).await.unwrap();
    assert!(sftp.list(&work).await.is_err(), "folder is gone");
    sftp.close().await.unwrap();
    conn.close().await.unwrap();

    // 9. A10: jump host and local port forwarding.
    let jump = std::sync::Arc::new(connect(&profile, &key(&ed, None), &trusted).await.unwrap());
    let via = wc_ssh_core::client::connect_via(&jump, &profile, &key(&rsa, None), &trusted)
        .await
        .expect("connect through the jump host");
    assert_eq!(
        via.host_key().fingerprint,
        host_fp,
        "target host key still checked"
    );
    assert_eq!(
        via.exec("echo via-jump", 64).await.unwrap().stdout,
        b"via-jump\n"
    );
    via.close().await.unwrap();
    // An echo server only the 'remote' side would know about.
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    let forward = jump
        .forward_local("127.0.0.1:0", "127.0.0.1", echo_port)
        .await
        .unwrap();
    for round in 0..2 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut c = tokio::net::TcpStream::connect(forward.local).await.unwrap();
        let msg = format!("ping-{round}");
        c.write_all(msg.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; msg.len()];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(buf, msg.as_bytes(), "tunnelled echo");
    }
    let local = forward.local;
    drop(forward);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        tokio::net::TcpStream::connect(local).await.is_err(),
        "forward stopped"
    );

    // 10. Dynamic forwarding (ssh -D): a SOCKS5 CONNECT to the echo server.
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let socks = jump.forward_dynamic("127.0.0.1:0").await.unwrap();
        let mut c = tokio::net::TcpStream::connect(socks.local).await.unwrap();
        c.write_all(&[5, 1, 0]).await.unwrap();
        let mut greet = [0u8; 2];
        c.read_exact(&mut greet).await.unwrap();
        assert_eq!(greet, [5, 0]);
        let mut req = vec![5, 1, 0, 3, 9];
        req.extend_from_slice(b"127.0.0.1");
        req.extend_from_slice(&echo_port.to_be_bytes());
        c.write_all(&req).await.unwrap();
        let mut reply = [0u8; 10];
        c.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0, "SOCKS CONNECT succeeded");
        c.write_all(b"socks").await.unwrap();
        let mut buf = [0u8; 5];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"socks");
    }

    // 11. Remote forwarding (ssh -R): the server listens and tunnels back
    // to the echo server on this side.
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let remote = jump
            .forward_remote("127.0.0.1", 0, "127.0.0.1", echo_port)
            .await
            .expect("remote forward");
        assert!(remote.port > 0);
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", remote.port as u16))
            .await
            .unwrap();
        c.write_all(b"remote").await.unwrap();
        let mut buf = [0u8; 6];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"remote", "reverse-tunnelled echo");
        let port = remote.port as u16;
        drop(c);
        drop(remote);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "remote forward cancelled"
        );
    }

    let _ = std::fs::remove_dir_all(&keys);
}
