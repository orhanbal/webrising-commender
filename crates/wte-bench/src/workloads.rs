//! Deterministic terminal workloads. The same seed gives the same bytes on
//! every machine, so numbers from Windows, macOS and Linux compare.

/// xorshift64*: small, fast and stable across platforms.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workload {
    /// Plain log lines (`cat build.log`).
    Ascii,
    /// Coloured tokens (`ls --color`, compiler output, `git log --graph`).
    Sgr,
    /// Turkish, CJK, emoji and combining marks.
    Unicode,
    /// Full-screen redraws with 256-colour cells (htop, vim, tmux).
    TuiRedraw,
    /// Very short lines that scroll the whole screen (`yes`).
    Scroll,
}

impl Workload {
    pub const ALL: [Workload; 5] = [
        Workload::Ascii,
        Workload::Sgr,
        Workload::Unicode,
        Workload::TuiRedraw,
        Workload::Scroll,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Workload::Ascii => "ascii",
            Workload::Sgr => "sgr",
            Workload::Unicode => "unicode",
            Workload::TuiRedraw => "tui-redraw",
            Workload::Scroll => "scroll",
        }
    }

    pub fn parse(name: &str) -> Option<Workload> {
        Workload::ALL.into_iter().find(|w| w.name() == name)
    }

    /// At least `size` bytes (whole lines or frames), always the same for a given size.
    pub fn generate(self, size: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(size + 64 * 1024);
        let mut rng = Rng::new(0x5754_4532 ^ self as u64);
        while out.len() < size {
            match self {
                Workload::Ascii => ascii_line(&mut rng, &mut out),
                Workload::Sgr => sgr_line(&mut rng, &mut out),
                Workload::Unicode => unicode_line(&mut rng, &mut out),
                Workload::TuiRedraw => tui_frame(&mut rng, &mut out, 120, 40),
                Workload::Scroll => out.extend_from_slice(b"y\r\n"),
            }
        }
        out
    }
}

fn ascii_line(rng: &mut Rng, out: &mut Vec<u8>) {
    let len = 40 + rng.below(80) as usize;
    for _ in 0..len {
        out.push(b' ' + rng.below(95) as u8);
    }
    out.extend_from_slice(b"\r\n");
}

fn word(rng: &mut Rng, out: &mut Vec<u8>) {
    let len = 2 + rng.below(10) as usize;
    for _ in 0..len {
        out.push(b'a' + rng.below(26) as u8);
    }
}

fn sgr_line(rng: &mut Rng, out: &mut Vec<u8>) {
    let words = 4 + rng.below(10);
    for _ in 0..words {
        match rng.below(4) {
            0 => out.extend_from_slice(format!("\x1b[1;3{}m", 1 + rng.below(7)).as_bytes()),
            1 => out.extend_from_slice(format!("\x1b[38;5;{}m", rng.below(256)).as_bytes()),
            2 => out.extend_from_slice(
                format!(
                    "\x1b[38;2;{};{};{}m",
                    rng.below(256),
                    rng.below(256),
                    rng.below(256)
                )
                .as_bytes(),
            ),
            _ => {}
        }
        word(rng, out);
        out.extend_from_slice(b"\x1b[0m ");
    }
    out.extend_from_slice(b"\r\n");
}

const UNICODE: &[&str] = &[
    "ğüşıöç",
    "İstanbul",
    "日本語",
    "中文字符",
    "한국어",
    "😀",
    "🚀",
    "👍🏽",
    "e\u{301}",
    "a\u{308}",
    "Ω≈ç√∫",
    "│─┼",
    "█▓▒░",
];

fn unicode_line(rng: &mut Rng, out: &mut Vec<u8>) {
    let words = 4 + rng.below(10);
    for _ in 0..words {
        if rng.below(2) == 0 {
            out.extend_from_slice(UNICODE[rng.below(UNICODE.len() as u64) as usize].as_bytes());
        } else {
            word(rng, out);
        }
        out.push(b' ');
    }
    out.extend_from_slice(b"\r\n");
}

fn tui_frame(rng: &mut Rng, out: &mut Vec<u8>, cols: u16, rows: u16) {
    out.extend_from_slice(b"\x1b[?25l\x1b[H");
    for r in 1..=rows {
        out.extend_from_slice(format!("\x1b[{r};1H").as_bytes());
        let mut c = 0;
        while c < cols {
            let run = (1 + rng.below(12) as u16).min(cols - c);
            out.extend_from_slice(
                format!("\x1b[38;5;{};48;5;{}m", rng.below(256), rng.below(256)).as_bytes(),
            );
            for _ in 0..run {
                out.push(b' ' + rng.below(95) as u8);
            }
            c += run;
        }
    }
    out.extend_from_slice(b"\x1b[0m\x1b[?25h");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workloads_are_deterministic_and_valid_utf8() {
        for w in Workload::ALL {
            let a = w.generate(64 * 1024);
            assert!(a.len() >= 64 * 1024, "{}", w.name());
            assert_eq!(a, w.generate(64 * 1024), "{}", w.name());
            assert!(std::str::from_utf8(&a).is_ok(), "{}", w.name());
            assert_eq!(Workload::parse(w.name()), Some(w));
        }
    }

    #[test]
    fn tui_frame_fills_every_row() {
        let mut out = Vec::new();
        tui_frame(&mut Rng::new(7), &mut out, 120, 40);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("\x1b[40;1H"));
        assert!(!text.contains("\x1b[41;1H"));
    }
}
