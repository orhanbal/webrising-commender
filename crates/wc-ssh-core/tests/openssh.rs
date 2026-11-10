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
         KbdInteractiveAuthentication no\nPermitRootLogin yes\nAllowUsers {user}\n",
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

    let _ = std::fs::remove_dir_all(&keys);
}
