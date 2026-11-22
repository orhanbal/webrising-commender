//! VT parser (the DEC ANSI state machine, after Paul Williams' diagram) with
//! a fast path: in the ground state, runs of printable ASCII go to the
//! handler as one slice, and UTF-8 text is decoded run by run, so the
//! state machine only runs at control bytes.

/// At most this many parameters (and sub-parameters) per sequence; more are ignored.
pub const MAX_PARAMS: usize = 32;
const MAX_INTERMEDIATES: usize = 2;
const MAX_OSC: usize = 4096;

/// CSI parameters. `sub[i]` is true when value `i` follows a colon, i.e. it
/// belongs to the parameter before it (`38:2::1:2:3`).
#[derive(Clone, Debug, Default)]
pub struct Params {
    vals: [u16; MAX_PARAMS],
    sub: [bool; MAX_PARAMS],
    len: usize,
}

impl Params {
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Parameters with their sub-parameters: `38:5:1;4` gives `[38,5,1]`, `[4]`.
    pub fn groups(&self) -> impl Iterator<Item = &[u16]> {
        let mut i = 0;
        std::iter::from_fn(move || {
            if i >= self.len {
                return None;
            }
            let start = i;
            i += 1;
            while i < self.len && self.sub[i] {
                i += 1;
            }
            Some(&self.vals[start..i])
        })
    }

    /// The first value of parameter `n`, if present.
    pub fn get(&self, n: usize) -> Option<u16> {
        self.groups().nth(n).map(|g| g[0])
    }

    fn clear(&mut self) {
        self.len = 0;
    }

    fn push(&mut self, sub: bool) {
        if self.len < MAX_PARAMS {
            self.vals[self.len] = 0;
            self.sub[self.len] = sub;
            self.len += 1;
        }
    }

    fn digit(&mut self, d: u8) {
        if self.len == 0 {
            self.push(false);
        }
        if let Some(v) = self.vals.get_mut(self.len - 1) {
            *v = v.saturating_mul(10).saturating_add((d - b'0') as u16);
        }
    }

    #[cfg(test)]
    pub fn from_slice(groups: &[&[u16]]) -> Self {
        let mut p = Params::default();
        for g in groups {
            for (i, v) in g.iter().enumerate() {
                p.push(i > 0);
                p.vals[p.len - 1] = *v;
            }
        }
        p
    }
}

pub trait Handler {
    /// Printable ASCII (0x20..=0x7e), never empty.
    fn print_ascii(&mut self, run: &[u8]);
    fn print(&mut self, c: char);
    fn execute(&mut self, byte: u8);
    fn csi(&mut self, params: &Params, intermediates: &[u8], action: u8);
    fn esc(&mut self, intermediates: &[u8], byte: u8);
    fn osc(&mut self, data: &[u8]);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    EscapeIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    Osc,
    /// DCS, SOS, PM and APC strings: skipped until ST.
    IgnoreString,
}

pub struct Parser {
    state: State,
    params: Params,
    intermediates: [u8; MAX_INTERMEDIATES],
    n_intermediates: usize,
    /// More intermediates than fit: the sequence is ignored.
    overflow: bool,
    osc: Vec<u8>,
    /// ESC seen inside a string (the first byte of ST, ESC \).
    string_esc: bool,
    /// A UTF-8 character split across two `advance` calls.
    utf8: [u8; 4],
    utf8_len: usize,
}

impl Default for Parser {
    fn default() -> Self {
        Parser::new()
    }
}

#[inline]
fn printable_ascii_len(bytes: &[u8]) -> usize {
    // Branch-light loop the compiler vectorizes; a hand-written SIMD scan
    // replaces it in step 2.
    bytes
        .iter()
        .position(|&b| !(0x20..0x7f).contains(&b))
        .unwrap_or(bytes.len())
}

fn utf8_len(first: u8) -> usize {
    match first {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 1,
    }
}

impl Parser {
    pub fn new() -> Self {
        Parser {
            state: State::Ground,
            params: Params::default(),
            intermediates: [0; MAX_INTERMEDIATES],
            n_intermediates: 0,
            overflow: false,
            osc: Vec::new(),
            string_esc: false,
            utf8: [0; 4],
            utf8_len: 0,
        }
    }

    pub fn advance<H: Handler>(&mut self, h: &mut H, mut bytes: &[u8]) {
        if self.utf8_len > 0 {
            bytes = self.finish_utf8(h, bytes);
        }
        while !bytes.is_empty() {
            if self.state == State::Ground {
                let n = printable_ascii_len(bytes);
                if n > 0 {
                    h.print_ascii(&bytes[..n]);
                    bytes = &bytes[n..];
                    continue;
                }
                let b = bytes[0];
                if b >= 0x80 {
                    bytes = self.utf8_run(h, bytes);
                    continue;
                }
            }
            self.byte(h, bytes[0]);
            bytes = &bytes[1..];
        }
    }

    /// Decodes UTF-8 text up to the next ASCII byte.
    fn utf8_run<'a, H: Handler>(&mut self, h: &mut H, bytes: &'a [u8]) -> &'a [u8] {
        let end = bytes.iter().position(|&b| b < 0x80).unwrap_or(bytes.len());
        let mut run = &bytes[..end];
        while !run.is_empty() {
            match std::str::from_utf8(run) {
                Ok(s) => {
                    s.chars().for_each(|c| h.print(c));
                    run = &[];
                }
                Err(e) => {
                    let (good, rest) = run.split_at(e.valid_up_to());
                    // SAFETY-free: `good` was just validated.
                    std::str::from_utf8(good)
                        .unwrap_or_default()
                        .chars()
                        .for_each(|c| h.print(c));
                    match e.error_len() {
                        Some(bad) => {
                            h.print('\u{fffd}');
                            run = &rest[bad..];
                        }
                        None => {
                            // Incomplete character at the end: wait for the next chunk.
                            self.utf8[..rest.len()].copy_from_slice(rest);
                            self.utf8_len = rest.len();
                            run = &[];
                        }
                    }
                }
            }
        }
        &bytes[end..]
    }

    fn finish_utf8<'a, H: Handler>(&mut self, h: &mut H, bytes: &'a [u8]) -> &'a [u8] {
        let need = utf8_len(self.utf8[0]);
        let mut used = 0;
        while self.utf8_len < need && used < bytes.len() && (0x80..0xc0).contains(&bytes[used]) {
            self.utf8[self.utf8_len] = bytes[used];
            self.utf8_len += 1;
            used += 1;
        }
        if self.utf8_len < need && used == bytes.len() {
            return &bytes[used..]; // still incomplete
        }
        match std::str::from_utf8(&self.utf8[..self.utf8_len]) {
            Ok(s) => s.chars().for_each(|c| h.print(c)),
            Err(_) => h.print('\u{fffd}'),
        }
        self.utf8_len = 0;
        &bytes[used..]
    }

    fn reset_sequence(&mut self) {
        self.params.clear();
        self.n_intermediates = 0;
        self.overflow = false;
    }

    fn intermediate(&mut self, b: u8) {
        if self.n_intermediates < MAX_INTERMEDIATES {
            self.intermediates[self.n_intermediates] = b;
            self.n_intermediates += 1;
        } else {
            self.overflow = true;
        }
    }

    fn byte<H: Handler>(&mut self, h: &mut H, b: u8) {
        // Anywhere: CAN and SUB abort, ESC starts a new sequence (or ends a string).
        match b {
            0x18 | 0x1a => {
                if matches!(self.state, State::Osc | State::IgnoreString) {
                    self.osc.clear();
                }
                self.state = State::Ground;
                return;
            }
            0x1b => {
                if matches!(self.state, State::Osc | State::IgnoreString) {
                    self.string_esc = true;
                    return;
                }
                self.reset_sequence();
                self.state = State::Escape;
                return;
            }
            _ => {}
        }
        match self.state {
            State::Ground => {
                if b < 0x20 || b == 0x7f {
                    h.execute(b);
                } else if b >= 0x80 {
                    // Lone byte from a split chunk boundary; handled by utf8_run.
                    self.utf8_run(h, &[b]);
                }
            }
            State::Escape => match b {
                0x00..=0x1f => h.execute(b),
                0x20..=0x2f => {
                    self.intermediate(b);
                    self.state = State::EscapeIntermediate;
                }
                b'[' => {
                    self.reset_sequence();
                    self.state = State::CsiEntry;
                }
                b']' => {
                    self.osc.clear();
                    self.string_esc = false;
                    self.state = State::Osc;
                }
                b'P' | b'X' | b'^' | b'_' => {
                    self.string_esc = false;
                    self.state = State::IgnoreString;
                }
                0x30..=0x7e => {
                    h.esc(&[], b);
                    self.state = State::Ground;
                }
                _ => self.state = State::Ground,
            },
            State::EscapeIntermediate => match b {
                0x00..=0x1f => h.execute(b),
                0x20..=0x2f => self.intermediate(b),
                0x30..=0x7e => {
                    if !self.overflow {
                        h.esc(&self.intermediates[..self.n_intermediates], b);
                    }
                    self.state = State::Ground;
                }
                _ => self.state = State::Ground,
            },
            State::CsiEntry | State::CsiParam => match b {
                0x00..=0x1f => h.execute(b),
                b'0'..=b'9' => {
                    self.params.digit(b);
                    self.state = State::CsiParam;
                }
                b';' => {
                    if self.params.is_empty() {
                        self.params.push(false);
                    }
                    self.params.push(false);
                    self.state = State::CsiParam;
                }
                b':' => {
                    if self.params.is_empty() {
                        self.params.push(false);
                    }
                    self.params.push(true);
                    self.state = State::CsiParam;
                }
                0x3c..=0x3f => {
                    // Private markers (?, >, =, <) only at the start.
                    if self.state == State::CsiEntry {
                        self.intermediate(b);
                    } else {
                        self.state = State::CsiIgnore;
                    }
                }
                0x20..=0x2f => {
                    self.intermediate(b);
                    self.state = State::CsiIntermediate;
                }
                0x40..=0x7e => self.dispatch_csi(h, b),
                _ => self.state = State::CsiIgnore,
            },
            State::CsiIntermediate => match b {
                0x00..=0x1f => h.execute(b),
                0x20..=0x2f => self.intermediate(b),
                0x40..=0x7e => self.dispatch_csi(h, b),
                _ => self.state = State::CsiIgnore,
            },
            State::CsiIgnore => match b {
                0x00..=0x1f => h.execute(b),
                0x40..=0x7e => self.state = State::Ground,
                _ => {}
            },
            State::Osc => {
                if self.string_esc {
                    self.string_esc = false;
                    if b == b'\\' {
                        h.osc(&self.osc);
                    }
                    self.osc.clear();
                    self.state = State::Ground;
                    if b != b'\\' {
                        // ESC followed by something else: start that escape.
                        self.reset_sequence();
                        self.state = State::Escape;
                        self.byte(h, b);
                    }
                } else if b == 0x07 {
                    h.osc(&self.osc);
                    self.osc.clear();
                    self.state = State::Ground;
                } else if b >= 0x20 && self.osc.len() < MAX_OSC {
                    self.osc.push(b);
                }
            }
            State::IgnoreString => {
                if self.string_esc {
                    self.string_esc = false;
                    self.state = State::Ground;
                    if b != b'\\' {
                        self.reset_sequence();
                        self.state = State::Escape;
                        self.byte(h, b);
                    }
                } else if b == 0x07 {
                    self.state = State::Ground;
                }
            }
        }
    }

    fn dispatch_csi<H: Handler>(&mut self, h: &mut H, action: u8) {
        if !self.overflow {
            h.csi(
                &self.params,
                &self.intermediates[..self.n_intermediates],
                action,
            );
        }
        self.state = State::Ground;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log(Vec<String>);

    impl Handler for Log {
        fn print_ascii(&mut self, run: &[u8]) {
            self.0.push(format!("a:{}", String::from_utf8_lossy(run)));
        }
        fn print(&mut self, c: char) {
            self.0.push(format!("p:{c}"));
        }
        fn execute(&mut self, b: u8) {
            self.0.push(format!("x:{b}"));
        }
        fn csi(&mut self, p: &Params, i: &[u8], a: u8) {
            let groups: Vec<String> = p.groups().map(|g| format!("{g:?}")).collect();
            self.0.push(format!(
                "csi:{}{}{}",
                String::from_utf8_lossy(i),
                groups.join(""),
                a as char
            ));
        }
        fn esc(&mut self, i: &[u8], b: u8) {
            self.0
                .push(format!("esc:{}{}", String::from_utf8_lossy(i), b as char));
        }
        fn osc(&mut self, d: &[u8]) {
            self.0.push(format!("osc:{}", String::from_utf8_lossy(d)));
        }
    }

    fn parse(chunks: &[&[u8]]) -> Vec<String> {
        let mut p = Parser::new();
        let mut log = Log::default();
        for c in chunks {
            p.advance(&mut log, c);
        }
        log.0
    }

    #[test]
    fn ascii_runs_are_one_call() {
        assert_eq!(
            parse(&[b"hello world\r\n"]),
            ["a:hello world", "x:13", "x:10"]
        );
    }

    #[test]
    fn csi_params_and_sub_params() {
        assert_eq!(
            parse(&[b"\x1b[1;31m\x1b[38:2::1:2:3m\x1b[?1049h\x1b[m\x1b[;5H"]),
            [
                "csi:[1][31]m",
                "csi:[38, 2, 0, 1, 2, 3]m",
                "csi:?[1049]h",
                "csi:m",
                "csi:[0][5]H",
            ]
        );
    }

    #[test]
    fn sequences_split_across_chunks() {
        assert_eq!(
            parse(&[b"\x1b", b"[3", b"1m", b"\xc4", b"\x9f!"]),
            ["csi:[31]m", "p:ğ", "a:!"]
        );
        assert_eq!(parse(&[b"\xe6\x97", b"\xa5"]), ["p:日"]);
    }

    #[test]
    fn osc_with_bel_and_st_and_dcs_is_skipped() {
        assert_eq!(
            parse(&[b"\x1b]0;title\x07\x1b]2;two\x1b\\\x1bPq#0;2;0;0;0\x1b\\ok"]),
            ["osc:0;title", "osc:2;two", "a:ok",]
        );
    }

    #[test]
    fn invalid_utf8_becomes_replacement_and_cancel_aborts() {
        assert_eq!(parse(&[b"\xff\x1b[1\x18x"]), ["p:\u{fffd}", "a:x"]);
    }

    #[test]
    fn esc_dispatch_with_intermediates() {
        assert_eq!(
            parse(&[b"\x1b7\x1b#8\x1b(B"]),
            ["esc:7", "esc:#8", "esc:(B"]
        );
    }

    #[test]
    fn huge_params_saturate_and_never_panic() {
        let mut input = b"\x1b[".to_vec();
        input.extend(std::iter::repeat_n(b'9', 100));
        input.extend(std::iter::repeat_n(b';', 100));
        input.push(b'm');
        let out = parse(&[&input]);
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with("csi:[65535]"));
    }

    #[test]
    fn params_helper() {
        let p = Params::from_slice(&[&[38, 5, 1], &[4]]);
        assert_eq!(p.groups().count(), 2);
        assert_eq!(p.get(1), Some(4));
    }
}
