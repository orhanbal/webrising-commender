//! Mosh terminals. SSH logs in and starts `mosh-server`, which answers with
//! a UDP port and a key; from then on the terminal talks to it over UDP with
//! the State Synchronization Protocol, so it survives roaming, sleep and bad
//! links.
//!
//! Wire format (mosh 1.x, protocol version 2):
//! - datagram: 8-byte sequence (top bit: direction, 1 = to client) then the
//!   AES-128-OCB ciphertext of `timestamp u16 | timestamp reply u16 |
//!   fragment`, nonce = 4 zero bytes + the sequence, 16-byte tag;
//! - fragment: `id u64 | number u16 (top bit: last)` then a slice of a
//!   zlib-compressed `TransportInstruction` protobuf;
//! - each side sends the difference between the state the other side has
//!   acknowledged and its newest one. The client's states are its keystrokes
//!   and resizes; the server's are screens, sent as escape sequences that
//!   turn one screen into the next. The screens are kept here (vt100) and the
//!   terminal view gets the difference from what it already shows.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::num::NonZeroU16;
use std::time::{Duration, Instant};

use aes::Aes128;
use ocb3::aead::{Aead, KeyInit};
use ocb3::Ocb3;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::stream::{StreamCmd, StreamEvents};

type Cipher = Ocb3<Aes128, ocb3::consts::U12>;

/// What `mosh-server new` answered.
#[derive(Debug, PartialEq, Eq)]
pub struct Bootstrap {
    pub port: u16,
    pub key: [u8; 16],
}

/// Finds `MOSH CONNECT <port> <key>` in mosh-server's output.
pub fn parse_connect(output: &str) -> Option<Bootstrap> {
    use base64::Engine;
    let line = output
        .lines()
        .find(|l| l.trim_start().starts_with("MOSH CONNECT "))?;
    let mut words = line.split_whitespace().skip(2);
    let port: u16 = words.next()?.parse().ok()?;
    let key_text = words.next()?;
    let padded = format!("{key_text}{}", "=".repeat((4 - key_text.len() % 4) % 4));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(padded)
        .ok()?;
    Some(Bootstrap {
        port,
        key: bytes.try_into().ok()?,
    })
}

/// The command that starts the server; `LANG` must name a UTF-8 locale.
pub fn server_command(lang: &str) -> String {
    format!("mosh-server new -s -c 256 -l LANG={lang} 2>&1")
}

// ---- packets -------------------------------------------------------------

const TO_CLIENT: u64 = 1 << 63;

struct Crypto {
    cipher: Cipher,
}

impl Crypto {
    fn new(key: &[u8; 16]) -> Self {
        Self {
            cipher: Cipher::new(key.into()),
        }
    }

    fn nonce(seq: u64) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&seq.to_be_bytes());
        n
    }

    fn seal(&self, seq: u64, plain: &[u8]) -> Vec<u8> {
        let ct = self
            .cipher
            .encrypt(&Self::nonce(seq).into(), plain)
            .expect("OCB encryption does not fail");
        let mut out = seq.to_be_bytes().to_vec();
        out.extend_from_slice(&ct);
        out
    }

    fn open(&self, packet: &[u8]) -> Option<(u64, Vec<u8>)> {
        if packet.len() < 8 + 16 {
            return None;
        }
        let seq = u64::from_be_bytes(packet[..8].try_into().ok()?);
        let plain = self
            .cipher
            .decrypt(&Self::nonce(seq).into(), &packet[8..])
            .ok()?;
        Some((seq, plain))
    }
}

// ---- protobuf (just the fields mosh uses) ---------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_uint(out: &mut Vec<u8>, field: u32, v: u64) {
    put_varint(out, u64::from(field) << 3);
    put_varint(out, v);
}

fn put_bytes(out: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    put_varint(out, (u64::from(field) << 3) | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

enum Value<'a> {
    Int(u64),
    Bytes(&'a [u8]),
}

fn get_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *buf.get(*pos)?;
        *pos += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// The fields of a message; unknown wire types end the message.
fn fields(buf: &[u8]) -> Vec<(u32, Value<'_>)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        let Some(tag) = get_varint(buf, &mut pos) else {
            break;
        };
        let field = (tag >> 3) as u32;
        match tag & 7 {
            0 => match get_varint(buf, &mut pos) {
                Some(v) => out.push((field, Value::Int(v))),
                None => break,
            },
            2 => {
                let Some(len) = get_varint(buf, &mut pos) else {
                    break;
                };
                let end = pos.saturating_add(len as usize);
                if end > buf.len() {
                    break;
                }
                out.push((field, Value::Bytes(&buf[pos..end])));
                pos = end;
            }
            1 => pos += 8,
            5 => pos += 4,
            _ => break,
        }
    }
    out
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Instruction {
    old_num: u64,
    new_num: u64,
    ack_num: u64,
    throwaway_num: u64,
    diff: Vec<u8>,
}

impl Instruction {
    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_uint(&mut out, 1, 2); // protocol version
        put_uint(&mut out, 2, self.old_num);
        put_uint(&mut out, 3, self.new_num);
        put_uint(&mut out, 4, self.ack_num);
        put_uint(&mut out, 5, self.throwaway_num);
        if !self.diff.is_empty() {
            put_bytes(&mut out, 6, &self.diff);
        }
        out
    }

    fn decode(buf: &[u8]) -> Option<Self> {
        let mut i = Self::default();
        let mut version = 0;
        for (field, value) in fields(buf) {
            match (field, value) {
                (1, Value::Int(v)) => version = v,
                (2, Value::Int(v)) => i.old_num = v,
                (3, Value::Int(v)) => i.new_num = v,
                (4, Value::Int(v)) => i.ack_num = v,
                (5, Value::Int(v)) => i.throwaway_num = v,
                (6, Value::Bytes(b)) => i.diff = b.to_vec(),
                _ => {}
            }
        }
        (version == 2).then_some(i)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum UserEvent {
    Keys(Vec<u8>),
    Resize(u16, u16),
}

/// UserMessage: repeated Instruction (1), each a keystroke (2: keys 4) or a
/// resize (3: width 5, height 6).
fn user_message(events: &[UserEvent]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in events {
        let mut inner = Vec::new();
        let mut ext = Vec::new();
        match e {
            UserEvent::Keys(keys) => {
                put_bytes(&mut ext, 4, keys);
                put_bytes(&mut inner, 2, &ext);
            }
            UserEvent::Resize(cols, rows) => {
                put_uint(&mut ext, 5, u64::from(*cols));
                put_uint(&mut ext, 6, u64::from(*rows));
                put_bytes(&mut inner, 3, &ext);
            }
        }
        put_bytes(&mut out, 1, &inner);
    }
    out
}

/// One step of a HostMessage: screen bytes or the server's terminal size.
#[derive(Debug, PartialEq, Eq)]
enum HostStep {
    Bytes(Vec<u8>),
    Resize(u16, u16),
}

/// HostMessage: repeated Instruction (1) with host bytes (2: hoststring 4),
/// resize (3: width 5, height 6) or echo ack (7, not needed here).
fn host_message(buf: &[u8]) -> Vec<HostStep> {
    let mut out = Vec::new();
    for (field, value) in fields(buf) {
        let (1, Value::Bytes(inst)) = (field, value) else {
            continue;
        };
        for (f, v) in fields(inst) {
            match (f, v) {
                (2, Value::Bytes(hb)) => {
                    for (g, w) in fields(hb) {
                        if let (4, Value::Bytes(s)) = (g, w) {
                            out.push(HostStep::Bytes(s.to_vec()));
                        }
                    }
                }
                (3, Value::Bytes(rs)) => {
                    let (mut w, mut h) = (80u64, 24u64);
                    for (g, val) in fields(rs) {
                        match (g, val) {
                            (5, Value::Int(v)) => w = v,
                            (6, Value::Int(v)) => h = v,
                            _ => {}
                        }
                    }
                    out.push(HostStep::Resize(
                        w.clamp(1, 1000) as u16,
                        h.clamp(1, 500) as u16,
                    ));
                }
                _ => {}
            }
        }
    }
    out
}

// ---- fragments -------------------------------------------------------------

const FRAGMENT_BYTES: usize = 1000;

fn compress(bytes: &[u8]) -> Vec<u8> {
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = z.write_all(bytes);
    z.finish().unwrap_or_default()
}

fn decompress(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(bytes)
        .take(16 * 1024 * 1024)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

fn fragments(id: u64, payload: &[u8]) -> Vec<Vec<u8>> {
    let chunks: Vec<&[u8]> = if payload.is_empty() {
        vec![&[]]
    } else {
        payload.chunks(FRAGMENT_BYTES).collect()
    };
    let last = chunks.len() - 1;
    chunks
        .into_iter()
        .enumerate()
        .map(|(n, chunk)| {
            let mut f = id.to_be_bytes().to_vec();
            let num = (n as u16) | if n == last { 0x8000 } else { 0 };
            f.extend_from_slice(&num.to_be_bytes());
            f.extend_from_slice(chunk);
            f
        })
        .collect()
}

#[derive(Default)]
struct Reassembly {
    id: u64,
    parts: HashMap<u16, Vec<u8>>,
    last: Option<u16>,
}

impl Reassembly {
    /// The whole payload once its last missing fragment arrives.
    fn add(&mut self, fragment: &[u8]) -> Option<Vec<u8>> {
        if fragment.len() < 10 {
            return None;
        }
        let id = u64::from_be_bytes(fragment[..8].try_into().ok()?);
        let raw = u16::from_be_bytes(fragment[8..10].try_into().ok()?);
        let (num, is_last) = (raw & 0x7fff, raw & 0x8000 != 0);
        if id != self.id {
            if id < self.id && !self.parts.is_empty() {
                return None; // an older instruction, already superseded
            }
            self.id = id;
            self.parts.clear();
            self.last = None;
        }
        self.parts.insert(num, fragment[10..].to_vec());
        if is_last {
            self.last = Some(num);
        }
        let last = self.last?;
        if (0..=last).all(|n| self.parts.contains_key(&n)) {
            let whole = (0..=last)
                .flat_map(|n| self.parts.remove(&n).unwrap_or_default())
                .collect();
            self.last = None;
            return Some(whole);
        }
        None
    }
}

// ---- screens ---------------------------------------------------------------

fn size(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(1)).unwrap_or(NonZeroU16::MIN)
}

/// Applies a HostMessage to a copy of `base`.
fn apply(base: &vt100::Screen, steps: &[HostStep]) -> vt100::Screen {
    let (rows, cols) = base.size();
    let mut parser = vt100::Parser::new(rows, cols, 0);
    *parser.screen_mut() = base.clone();
    for step in steps {
        match step {
            HostStep::Bytes(b) => parser.process(b),
            HostStep::Resize(cols, rows) => parser.screen_mut().set_size(size(*rows), size(*cols)),
        }
    }
    parser.screen().clone()
}

fn blank(cols: u16, rows: u16) -> vt100::Screen {
    vt100::Parser::new(size(rows), size(cols), 0)
        .screen()
        .clone()
}

// ---- session ---------------------------------------------------------------

/// Opens the UDP side towards `host` (the address SSH used) and `port`.
pub async fn connect(host: &str, port: u16) -> Result<UdpSocket, String> {
    let addr = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("mosh: could not resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("mosh: could not resolve {host}"))?;
    let local = if addr.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let sock = UdpSocket::bind(local)
        .await
        .map_err(|e| format!("mosh: no UDP socket: {e}"))?;
    sock.connect(addr)
        .await
        .map_err(|e| format!("mosh: could not reach {addr}: {e}"))?;
    Ok(sock)
}

struct Session {
    sock: UdpSocket,
    crypto: Crypto,
    started: Instant,
    seq: u64,
    fragment_id: u64,
    events: Vec<UserEvent>,
    /// The client state the server has acknowledged (= events it has).
    acked: u64,
    screens: BTreeMap<u64, vt100::Screen>,
    latest: u64,
    shown: vt100::Screen,
    reassembly: Reassembly,
    reply: Option<(u16, Instant)>,
    last_send: Instant,
    ack_due: bool,
}

impl Session {
    fn now16(&self) -> u16 {
        (self.started.elapsed().as_millis() % 65_536) as u16
    }

    async fn send(&mut self, new_num: u64) {
        let from = (self.acked as usize).min(self.events.len());
        let inst = Instruction {
            old_num: self.acked,
            new_num,
            ack_num: self.latest,
            throwaway_num: self.acked,
            diff: if new_num == u64::MAX {
                Vec::new()
            } else {
                user_message(&self.events[from..])
            },
        };
        let payload = compress(&inst.encode());
        self.fragment_id += 1;
        let reply = match self.reply {
            Some((ts, at)) => ts.wrapping_add(at.elapsed().as_millis().min(65_000) as u16),
            None => u16::MAX,
        };
        for fragment in fragments(self.fragment_id, &payload) {
            let mut plain = self.now16().to_be_bytes().to_vec();
            plain.extend_from_slice(&reply.to_be_bytes());
            plain.extend_from_slice(&fragment);
            let packet = self.crypto.seal(self.seq & !TO_CLIENT, &plain);
            self.seq += 1;
            let _ = self.sock.send(&packet).await;
        }
        self.last_send = Instant::now();
        self.ack_due = false;
    }

    /// A datagram from the server. Returns false when the server ended.
    fn receive(&mut self, packet: &[u8], events: &StreamEvents) -> bool {
        let Some((seq, plain)) = self.crypto.open(packet) else {
            return true;
        };
        if seq & TO_CLIENT == 0 || plain.len() < 4 {
            return true;
        }
        let ts = u16::from_be_bytes([plain[0], plain[1]]);
        if ts != u16::MAX {
            self.reply = Some((ts, Instant::now()));
        }
        let Some(whole) = self.reassembly.add(&plain[4..]) else {
            return true;
        };
        let Some(inst) = decompress(&whole).and_then(|b| Instruction::decode(&b)) else {
            return true;
        };
        self.acked = self.acked.max(inst.ack_num.min(self.events.len() as u64));
        if inst.new_num == u64::MAX {
            return false; // the shell ended
        }
        if inst.new_num <= self.latest {
            return true;
        }
        let Some(base) = self.screens.get(&inst.old_num) else {
            return true;
        };
        let screen = apply(base, &host_message(&inst.diff));
        events.output(screen.state_diff(&self.shown).as_bytes());
        self.shown = screen.clone();
        self.screens.insert(inst.new_num, screen);
        self.latest = inst.new_num;
        let keep_from = inst.throwaway_num.min(self.latest);
        self.screens.retain(|n, _| *n >= keep_from);
        self.ack_due = true;
        true
    }
}

/// Runs a Mosh terminal until the app closes it or the shell ends.
pub async fn run(
    sock: UdpSocket,
    key: [u8; 16],
    cols: u16,
    rows: u16,
    mut commands: mpsc::UnboundedReceiver<StreamCmd>,
    events: StreamEvents,
) {
    let mut s = Session {
        sock,
        crypto: Crypto::new(&key),
        started: Instant::now(),
        seq: 0,
        fragment_id: rand::random::<u32>() as u64,
        events: vec![UserEvent::Resize(cols, rows)],
        acked: 0,
        screens: BTreeMap::from([(0, blank(80, 24))]),
        latest: 0,
        shown: blank(cols, rows),
        reassembly: Reassembly::default(),
        reply: None,
        last_send: Instant::now(),
        ack_due: false,
    };
    s.send(1).await;
    let mut buf = vec![0u8; 2048];
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    let mut ended = false;
    let mut heard = false;
    let mut warned = false;
    loop {
        // No answer at all: most often a firewall dropping the UDP port.
        if !heard && !warned && s.started.elapsed() >= Duration::from_secs(8) {
            warned = true;
            events.output(
                "\r\n[WECOMMANDER] Mosh sunucusundan yanıt gelmiyor. Sunucunun güvenlik duvarında \
                 UDP 60000-61000 portları açık olmalı.\r\n"
                    .as_bytes(),
            );
        }
        tokio::select! {
            got = s.sock.recv(&mut buf) => {
                if let Ok(n) = got {
                    heard = true;
                    if !s.receive(&buf[..n], &events) { ended = true; break; }
                }
            }
            cmd = commands.recv() => match cmd {
                Some(StreamCmd::Data(bytes)) => {
                    s.events.push(UserEvent::Keys(bytes));
                    let n = s.events.len() as u64;
                    s.send(n).await;
                }
                Some(StreamCmd::Resize(c, r)) => {
                    s.events.push(UserEvent::Resize(c.clamp(1, 1000) as u16, r.clamp(1, 500) as u16));
                    let n = s.events.len() as u64;
                    s.send(n).await;
                }
                Some(StreamCmd::Close) | None => break,
            },
            _ = tick.tick() => {
                let since = s.last_send.elapsed();
                let unacked = s.acked < s.events.len() as u64;
                if (unacked && since >= Duration::from_millis(250))
                    || (s.ack_due && since >= Duration::from_millis(50))
                    || since >= Duration::from_secs(3)
                {
                    let n = s.events.len() as u64;
                    s.send(n).await;
                }
            }
        }
    }
    // Tell the server to end (mosh's shutdown state), or acknowledge its end.
    for _ in 0..3 {
        if ended {
            s.latest = u64::MAX;
            let n = s.events.len() as u64;
            s.send(n).await;
        } else {
            s.send(u64::MAX).await;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    events.exit(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_bootstrap_line() {
        let b = parse_connect(
            "\r\nMOSH CONNECT 60004 4NeCCgvZFe2RnPgrcU1PQw\r\n\nmosh-server (mosh 1.4.0)",
        )
        .unwrap();
        assert_eq!(b.port, 60004);
        assert_eq!(b.key.len(), 16);
        assert!(parse_connect("mosh-server: invalid locale").is_none());
    }

    #[test]
    fn packets_round_trip_and_reject_tampering() {
        let c = Crypto::new(&[7u8; 16]);
        let p = c.seal(5, b"hello");
        assert_eq!(c.open(&p), Some((5, b"hello".to_vec())));
        let mut bad = p.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(c.open(&bad), None);
    }

    #[test]
    fn instructions_round_trip() {
        let i = Instruction {
            old_num: 3,
            new_num: 9,
            ack_num: 4,
            throwaway_num: 3,
            diff: user_message(&[UserEvent::Keys(b"ls\r".to_vec())]),
        };
        assert_eq!(Instruction::decode(&i.encode()), Some(i));
    }

    #[test]
    fn fragments_reassemble_in_any_order() {
        let payload: Vec<u8> = (0..2500u32).map(|i| i as u8).collect();
        let mut parts = fragments(42, &payload);
        assert_eq!(parts.len(), 3);
        parts.swap(0, 2);
        let mut r = Reassembly::default();
        assert_eq!(r.add(&parts[0]), None);
        assert_eq!(r.add(&parts[1]), None);
        assert_eq!(r.add(&parts[2]), Some(payload));
    }

    #[test]
    fn host_messages_build_screens() {
        let mut hb = Vec::new();
        put_bytes(&mut hb, 4, b"\x1b[1;1Hhi there");
        let mut inst = Vec::new();
        put_bytes(&mut inst, 2, &hb);
        let mut msg = Vec::new();
        put_bytes(&mut msg, 1, &inst);
        let steps = host_message(&msg);
        let screen = apply(&blank(80, 24), &steps);
        assert!(screen.contents().starts_with("hi there"));
        assert!(!screen.state_diff(&blank(80, 24)).is_empty());
    }
}
