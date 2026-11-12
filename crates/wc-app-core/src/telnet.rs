//! Telnet (RFC 854) terminals: option negotiation for window size (NAWS),
//! terminal type, echo and suppress-go-ahead; everything else is refused.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::stream::{StreamCmd, StreamEvents};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;
const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    Iac,
    Command(u8),
    Sub,
    SubIac,
}

/// Telnet protocol state: splits the server's bytes into terminal output
/// and the replies the server expects.
pub struct Telnet {
    state: State,
    sub: Vec<u8>,
    cols: u16,
    rows: u16,
    naws: bool,
}

impl Telnet {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sub: Vec::new(),
            cols,
            rows,
            naws: false,
        }
    }

    /// What this side offers when the connection opens.
    pub fn greeting(&self) -> Vec<u8> {
        vec![
            IAC, WILL, NAWS, IAC, WILL, TTYPE, IAC, DO, SGA, IAC, DO, ECHO,
        ]
    }

    /// Feeds server bytes; returns (terminal output, replies to send).
    pub fn feed(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::with_capacity(input.len());
        let mut reply = Vec::new();
        for &b in input {
            self.state = match self.state {
                State::Data if b == IAC => State::Iac,
                State::Data => {
                    out.push(b);
                    State::Data
                }
                State::Iac => match b {
                    IAC => {
                        out.push(IAC);
                        State::Data
                    }
                    DO | DONT | WILL | WONT => State::Command(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    _ => State::Data, // NOP, GA and the like
                },
                State::Command(cmd) => {
                    self.answer(cmd, b, &mut reply);
                    State::Data
                }
                State::Sub if b == IAC => State::SubIac,
                State::Sub => {
                    if self.sub.len() < 256 {
                        self.sub.push(b);
                    }
                    State::Sub
                }
                State::SubIac if b == SE => {
                    self.subnegotiation(&mut reply);
                    State::Data
                }
                State::SubIac => {
                    if b == IAC && self.sub.len() < 256 {
                        self.sub.push(IAC);
                    }
                    State::Sub
                }
            };
        }
        (out, reply)
    }

    fn answer(&mut self, cmd: u8, option: u8, reply: &mut Vec<u8>) {
        match (cmd, option) {
            (DO, NAWS) => {
                self.naws = true;
                reply.extend_from_slice(&[IAC, WILL, NAWS]);
                reply.extend_from_slice(&self.window());
            }
            (DO, TTYPE) => reply.extend_from_slice(&[IAC, WILL, TTYPE]),
            (DO, SGA) => reply.extend_from_slice(&[IAC, WILL, SGA]),
            (DO, other) => reply.extend_from_slice(&[IAC, WONT, other]),
            (WILL, ECHO | SGA) => reply.extend_from_slice(&[IAC, DO, option]),
            (WILL, other) => reply.extend_from_slice(&[IAC, DONT, other]),
            (DONT, NAWS) => self.naws = false,
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub.first() == Some(&TTYPE) && self.sub.get(1) == Some(&TTYPE_SEND) {
            reply.extend_from_slice(&[IAC, SB, TTYPE, TTYPE_IS]);
            reply.extend_from_slice(b"XTERM-256COLOR");
            reply.extend_from_slice(&[IAC, SE]);
        }
    }

    /// The window size message (empty until the server asked for it).
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        if self.naws {
            self.window()
        } else {
            Vec::new()
        }
    }

    fn window(&self) -> Vec<u8> {
        let mut msg = vec![IAC, SB, NAWS];
        for byte in self
            .cols
            .to_be_bytes()
            .into_iter()
            .chain(self.rows.to_be_bytes())
        {
            msg.push(byte);
            if byte == IAC {
                msg.push(IAC);
            }
        }
        msg.extend_from_slice(&[IAC, SE]);
        msg
    }
}

/// Typed bytes as Telnet wants them: IAC doubled, a lone CR as CR NUL.
pub fn encode_input(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + 4);
    for (i, &b) in input.iter().enumerate() {
        match b {
            IAC => out.extend_from_slice(&[IAC, IAC]),
            b'\r' if input.get(i + 1) != Some(&b'\n') => out.extend_from_slice(b"\r\0"),
            _ => out.push(b),
        }
    }
    out
}

/// Opens the TCP connection (the caller reports a failure to the user).
pub async fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    match tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port))).await {
        Ok(Ok(stream)) => {
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
        Ok(Err(e)) => Err(format!("telnet: could not connect to {host}:{port}: {e}")),
        Err(_) => Err("connection timed out".into()),
    }
}

/// Runs a Telnet terminal until either side closes it.
pub async fn run(
    stream: TcpStream,
    cols: u16,
    rows: u16,
    mut commands: mpsc::UnboundedReceiver<StreamCmd>,
    events: StreamEvents,
) {
    let (mut reader, mut writer) = stream.into_split();
    let mut telnet = Telnet::new(cols, rows);
    if writer.write_all(&telnet.greeting()).await.is_err() {
        events.exit(None);
        return;
    }
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => {
                let n = match read { Ok(0) | Err(_) => break, Ok(n) => n };
                let (out, reply) = telnet.feed(&buf[..n]);
                events.output(&out);
                if !reply.is_empty() && writer.write_all(&reply).await.is_err() { break; }
            }
            cmd = commands.recv() => match cmd {
                Some(StreamCmd::Data(bytes)) => {
                    if writer.write_all(&encode_input(&bytes)).await.is_err() { break; }
                }
                Some(StreamCmd::Resize(c, r)) => {
                    let msg = telnet.resize(c.min(u16::MAX as u32) as u16, r.min(u16::MAX as u32) as u16);
                    if !msg.is_empty() && writer.write_all(&msg).await.is_err() { break; }
                }
                Some(StreamCmd::Close) | None => break,
            },
        }
    }
    let _ = writer.shutdown().await;
    events.exit(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_window_size_and_terminal_type() {
        let mut t = Telnet::new(120, 40);
        let (out, reply) = t.feed(&[b'h', IAC, DO, NAWS, b'i', IAC, DO, TTYPE]);
        assert_eq!(out, b"hi");
        assert_eq!(
            reply,
            [
                vec![IAC, WILL, NAWS, IAC, SB, NAWS, 0, 120, 0, 40, IAC, SE],
                vec![IAC, WILL, TTYPE],
            ]
            .concat()
        );
        let (_, reply) = t.feed(&[IAC, SB, TTYPE, TTYPE_SEND, IAC, SE]);
        assert_eq!(&reply[..4], &[IAC, SB, TTYPE, TTYPE_IS]);
        assert!(reply.windows(14).any(|w| w == b"XTERM-256COLOR"));
        assert_eq!(t.resize(80, 24), vec![IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE]);
    }

    #[test]
    fn refuses_unknown_options_and_keeps_data_bytes() {
        let mut t = Telnet::new(80, 24);
        let (out, reply) = t.feed(&[IAC, DO, 39, IAC, WILL, 34, IAC, IAC, b'x', IAC, WILL, ECHO]);
        assert_eq!(out, vec![IAC, b'x']);
        assert_eq!(reply, vec![IAC, WONT, 39, IAC, DONT, 34, IAC, DO, ECHO]);
    }

    #[test]
    fn negotiation_split_across_reads() {
        let mut t = Telnet::new(80, 24);
        let (out1, reply1) = t.feed(&[b'a', IAC]);
        let (out2, reply2) = t.feed(&[DO]);
        let (out3, reply3) = t.feed(&[SGA, b'b']);
        assert_eq!([out1, out2, out3].concat(), b"ab");
        assert!(reply1.is_empty() && reply2.is_empty());
        assert_eq!(reply3, vec![IAC, WILL, SGA]);
    }

    #[test]
    fn window_size_of_255_is_escaped() {
        let mut t = Telnet::new(80, 24);
        t.feed(&[IAC, DO, NAWS]);
        assert_eq!(
            t.resize(255, 24),
            vec![IAC, SB, NAWS, 0, IAC, IAC, 0, 24, IAC, SE]
        );
    }

    #[test]
    fn input_escapes_iac_and_bare_cr() {
        assert_eq!(encode_input(b"ls\r"), b"ls\r\0".to_vec());
        assert_eq!(encode_input(b"a\r\nb"), b"a\r\nb".to_vec());
        assert_eq!(encode_input(&[IAC]), vec![IAC, IAC]);
    }
}
