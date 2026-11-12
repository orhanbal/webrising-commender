//! A Telnet host opens a terminal through the core: negotiation, typed
//! input and server output all go through a real TCP connection.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use wc_app_core::{AuthInput, ConnectOutcome, EventSink};

#[derive(Default)]
struct Events(Mutex<Vec<(String, serde_json::Value)>>);
impl EventSink for Events {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((name.to_owned(), payload));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn telnet_host_opens_a_terminal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        sock.write_all(&[255, 253, 31]).await.unwrap(); // IAC DO NAWS
        sock.write_all(b"login: ").await.unwrap();
        let mut got = Vec::new();
        let mut buf = [0u8; 256];
        while !got.windows(6).any(|w| w == b"admin\r") {
            let n = sock.read(&mut buf).await.unwrap();
            assert!(n > 0, "client closed early");
            got.extend_from_slice(&buf[..n]);
        }
        sock.write_all(b"\r\nwelcome\r\n").await.unwrap();
        got
    });

    let dir = std::env::temp_dir().join(format!("wc-telnet-{}", std::process::id()));
    let events = Arc::new(Events::default());
    let state = wc_app_core::open(&dir, "app.wecommander.test.telnet", events.clone());
    let hosts = wc_app_core::add_host(
        &state,
        "Router".into(),
        "127.0.0.1".into(),
        port,
        "telnet".into(),
        "password".into(),
        None,
    )
    .unwrap();
    let id = hosts[0].id.clone();
    let hosts =
        wc_app_core::library::host_set_connection(&state, id.clone(), "telnet".into(), None)
            .unwrap();
    assert_eq!(hosts[0].protocol, "telnet");

    let auth = AuthInput {
        kind: "password".into(),
        secret: String::new(),
        passphrase: None,
        remember: false,
        key_path: None,
        install_key: false,
    };
    let outcome = wc_app_core::connect_host(
        &state,
        id,
        auth,
        None,
        "terminal".into(),
        Some(100),
        Some(30),
    )
    .await
    .unwrap();
    let ConnectOutcome::TerminalOpened { session_id, .. } = outcome else {
        panic!("no terminal")
    };
    wc_app_core::terminal_write(&state, session_id.clone(), "admin\r".into())
        .await
        .unwrap();

    let got = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    // Window size after DO NAWS (100 x 30), then the typed line.
    assert!(
        got.windows(9)
            .any(|w| w == [255, 250, 31, 0, 100, 0, 30, 255, 240]),
        "{got:?}"
    );
    assert!(got.ends_with(b"admin\r\0"), "{got:?}");

    let mut output = Vec::new();
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        output = events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "terminal-output")
            .flat_map(|(_, v)| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(v["data"].as_str().unwrap())
                    .unwrap()
            })
            .collect();
        if output.ends_with(b"welcome\r\n") {
            break;
        }
    }
    assert_eq!(output, b"login: \r\nwelcome\r\n");
    let _ = std::fs::remove_dir_all(&dir);
}
