//! The stages of today's terminal path, each measured on its own.
//!
//! Today (wecommander-core → app → page): SSH bytes are base64-encoded into a
//! JSON event line, the app parses it and wraps the base64 in a second JSON
//! message for the WebView2 page, which parses it, decodes base64 and hands
//! the bytes to xterm.js. Stage `transport` repeats exactly those steps;
//! `parse` is a reference VT parser (vte, the parser of Alacritty) and
//! `scan` is one plain pass over the bytes that finds control characters:
//! the floor a hand-written SIMD fast path must beat by a wide margin.

use base64::Engine;
use serde::Serialize;

/// Chunk size of one SSH read (the channel window delivers about this much).
pub const CHUNK: usize = 32 * 1024;

#[derive(Serialize)]
struct Event<'a> {
    event: &'a str,
    payload: Payload<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    session_id: &'a str,
    data: String,
}

#[derive(Serialize)]
struct PageMessage<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    data: &'a str,
}

/// Runs the whole current transport for `input`; returns (bytes delivered to the page, bytes on the wire).
pub fn transport(input: &[u8]) -> (usize, usize) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut delivered = 0;
    let mut wire = 0;
    for chunk in input.chunks(CHUNK) {
        // wecommander-core: emit the event line on stdout.
        let line = serde_json::to_string(&Event {
            event: "terminal-output",
            payload: Payload {
                session_id: "ssh-0123456789abcdef01234567",
                data: b64.encode(chunk),
            },
        })
        .expect("serialize");
        wire += line.len() + 1;
        // App: parse the line, re-wrap the base64 for the page.
        let value: serde_json::Value = serde_json::from_str(&line).expect("parse");
        let data = value["payload"]["data"].as_str().expect("data");
        let message = serde_json::to_string(&PageMessage {
            kind: "output",
            data,
        })
        .expect("serialize");
        // Page: parse the message, decode base64.
        let page: serde_json::Value = serde_json::from_str(&message).expect("parse");
        let bytes = b64
            .decode(page["data"].as_str().expect("data"))
            .expect("base64");
        delivered += bytes.len();
    }
    (delivered, wire)
}

/// Only the base64 round trip (no JSON), to split the transport cost.
pub fn base64_only(input: &[u8]) -> usize {
    let b64 = base64::engine::general_purpose::STANDARD;
    input
        .chunks(CHUNK)
        .map(|c| b64.decode(b64.encode(c)).expect("base64").len())
        .sum()
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct Counts {
    pub printed: u64,
    pub executed: u64,
    pub csi: u64,
    pub esc: u64,
    pub osc: u64,
}

impl vte::Perform for Counts {
    fn print(&mut self, _c: char) {
        self.printed += 1;
    }
    fn execute(&mut self, _byte: u8) {
        self.executed += 1;
    }
    fn csi_dispatch(
        &mut self,
        _params: &vte::Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
        self.csi += 1;
    }
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {
        self.esc += 1;
    }
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {
        self.osc += 1;
    }
}

/// Reference VT parse of `input`, fed in SSH-sized chunks.
pub fn parse(input: &[u8]) -> Counts {
    let mut parser = vte::Parser::new();
    let mut counts = Counts::default();
    for chunk in input.chunks(CHUNK) {
        parser.advance(&mut counts, chunk);
    }
    counts
}

/// The WTE2 core: parse and update a 120x40 grid with 1000 lines of
/// scrollback (what xterm.js does in the app). Returns the history length.
pub fn wte_core(input: &[u8]) -> usize {
    let mut term = wte_core::Terminal::new(120, 40, 1000);
    for chunk in input.chunks(CHUNK) {
        term.advance(chunk);
    }
    term.history_len() + term.cursor().0 + 1
}

/// One plain pass that finds control bytes (what a SIMD fast path does before
/// handing plain text runs to the grid), without hand-written SIMD.
pub fn scan(input: &[u8]) -> usize {
    // Branch-free so the compiler vectorizes it.
    input
        .iter()
        .map(|&b| ((b < 0x20) | (b == 0x7f)) as usize)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workloads::Workload;

    #[test]
    fn transport_delivers_every_byte_and_inflates_the_wire() {
        let input = Workload::Sgr.generate(200 * 1024);
        let (delivered, wire) = transport(&input);
        assert_eq!(delivered, input.len());
        assert!(wire > input.len() * 4 / 3, "base64 alone is 4/3");
        assert_eq!(base64_only(&input), input.len());
    }

    #[test]
    fn parse_counts_what_the_workload_contains() {
        let counts = parse(b"ab\x1b[1;31mc\x1b[0m\r\n\x1b]0;title\x07");
        assert_eq!(
            counts,
            Counts {
                printed: 3,
                executed: 2,
                csi: 2,
                esc: 0,
                osc: 1
            }
        );
        assert_eq!(scan(b"ab\x1b[0m\r\n"), 3);
    }
}
