//! A minimal SOCKS5 server (RFC 1928) for dynamic forwarding (`ssh -D`):
//! no authentication, CONNECT only, IPv4 / IPv6 / domain names. Each
//! accepted request is handed to `open`, which connects from the server.
use std::future::Future;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const VERSION: u8 = 5;
const NO_AUTH: u8 = 0;
const NO_ACCEPTABLE: u8 = 0xFF;
const CONNECT: u8 = 1;
const REPLY_OK: u8 = 0;
const REPLY_REFUSED: u8 = 5;
const REPLY_COMMAND: u8 = 7;
const REPLY_ADDRESS: u8 = 8;

/// The destination a client asked for.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

/// Reads the greeting and request from `client` and returns the target, or
/// answers with an error and returns `None`.
pub async fn handshake<C: AsyncRead + AsyncWrite + Unpin>(
    client: &mut C,
) -> std::io::Result<Option<Target>> {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    if head[0] != VERSION {
        return Ok(None);
    }
    let mut methods = vec![0u8; head[1] as usize];
    client.read_exact(&mut methods).await?;
    if !methods.contains(&NO_AUTH) {
        client.write_all(&[VERSION, NO_ACCEPTABLE]).await?;
        return Ok(None);
    }
    client.write_all(&[VERSION, NO_AUTH]).await?;

    let mut req = [0u8; 4];
    client.read_exact(&mut req).await?;
    if req[0] != VERSION {
        return Ok(None);
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            client.read_exact(&mut a).await?;
            Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            client.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            client.read_exact(&mut name).await?;
            match String::from_utf8(name) {
                Ok(name) if !name.is_empty() => name,
                _ => {
                    reply(client, REPLY_ADDRESS).await?;
                    return Ok(None);
                }
            }
        }
        4 => {
            let mut a = [0u8; 16];
            client.read_exact(&mut a).await?;
            Ipv6Addr::from(a).to_string()
        }
        _ => {
            reply(client, REPLY_ADDRESS).await?;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    client.read_exact(&mut port).await?;
    if req[1] != CONNECT {
        reply(client, REPLY_COMMAND).await?;
        return Ok(None);
    }
    Ok(Some(Target {
        host,
        port: u16::from_be_bytes(port),
    }))
}

async fn reply<C: AsyncWrite + Unpin>(client: &mut C, code: u8) -> std::io::Result<()> {
    // Bound address 0.0.0.0:0: clients do not need it for CONNECT.
    client
        .write_all(&[VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
}

/// Serves one SOCKS client: handshake, `open(host, port)`, then copies
/// bytes both ways until either side closes.
pub async fn serve<C, F, Fut, S>(mut client: C, _peer: SocketAddr, open: F) -> std::io::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin,
    F: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = Result<S, String>>,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Some(target) = handshake(&mut client).await? else {
        return Ok(());
    };
    match open(target.host, target.port).await {
        Ok(mut upstream) => {
            reply(&mut client, REPLY_OK).await?;
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        }
        Err(_) => reply(&mut client, REPLY_REFUSED).await?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(input: &[u8]) -> (Option<Target>, Vec<u8>) {
        let (mut a, mut b) = tokio::io::duplex(1024);
        b.write_all(input).await.unwrap();
        let target = handshake(&mut a).await.unwrap();
        drop(a);
        let mut out = Vec::new();
        b.read_to_end(&mut out).await.unwrap();
        (target, out)
    }

    #[tokio::test]
    async fn domain_connect() {
        let mut req = vec![5, 1, 0, 5, 1, 0, 3, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&443u16.to_be_bytes());
        let (t, out) = run(&req).await;
        assert_eq!(
            t,
            Some(Target {
                host: "example.com".into(),
                port: 443
            })
        );
        assert_eq!(out, [5, 0]);
    }

    #[tokio::test]
    async fn ipv4_and_ipv6() {
        let (t, _) = run(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 22]).await;
        assert_eq!(
            t,
            Some(Target {
                host: "10.0.0.7".into(),
                port: 22
            })
        );
        let mut req = vec![5, 1, 0, 5, 1, 0, 4];
        req.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        req.extend_from_slice(&80u16.to_be_bytes());
        let (t, _) = run(&req).await;
        assert_eq!(
            t,
            Some(Target {
                host: "::1".into(),
                port: 80
            })
        );
    }

    #[tokio::test]
    async fn refuses_auth_only_clients_and_bind() {
        let (t, out) = run(&[5, 1, 2]).await;
        assert_eq!((t, out), (None, vec![5, 0xFF]));
        let (t, out) = run(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert_eq!(t, None);
        assert_eq!(&out[..4], &[5, 0, 5, REPLY_COMMAND]);
    }

    #[tokio::test]
    async fn serve_relays_bytes() {
        let (mut client, server) = tokio::io::duplex(1024);
        let task = tokio::spawn(serve(
            server,
            "127.0.0.1:1".parse().unwrap(),
            |host, port| async move {
                assert_eq!((host.as_str(), port), ("db", 5432));
                let (up, mut far) = tokio::io::duplex(1024);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4];
                    far.read_exact(&mut buf).await.unwrap();
                    far.write_all(b"pong").await.unwrap();
                });
                Ok::<_, String>(up)
            },
        ));
        let mut req = vec![5, 1, 0, 5, 1, 0, 3, 2];
        req.extend_from_slice(b"db");
        req.extend_from_slice(&5432u16.to_be_bytes());
        client.write_all(&req).await.unwrap();
        let mut head = [0u8; 12];
        client.read_exact(&mut head).await.unwrap();
        assert_eq!(&head[..4], &[5, 0, 5, 0]);
        client.write_all(b"ping").await.unwrap();
        let mut got = [0u8; 4];
        client.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"pong");
        drop(client);
        let _ = task.await;
    }
}
