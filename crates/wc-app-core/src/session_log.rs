//! Session logs: a host can keep what its terminals show in a text file
//! (`<data dir>/logs/<host>-<date>.log`), with colours and cursor moves
//! taken out so the file reads like the screen did.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where session logs go.
pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// An open session log.
pub struct SessionLog {
    file: Mutex<File>,
    filter: Mutex<AnsiFilter>,
}

impl SessionLog {
    /// Starts a log for host `label`; None when the file cannot be made.
    pub fn start(data_dir: &Path, label: &str) -> Option<Self> {
        let dir = dir(data_dir);
        std::fs::create_dir_all(&dir).ok()?;
        let safe: String = label
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .take(60)
            .collect();
        let stamp = chrono_like_now();
        let path = dir.join(format!("{safe}-{stamp}.log"));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()?;
        Some(Self {
            file: Mutex::new(file),
            filter: Mutex::new(AnsiFilter::default()),
        })
    }

    pub fn write(&self, bytes: &[u8]) {
        let text = match self.filter.lock() {
            Ok(mut f) => f.feed(bytes),
            Err(_) => return,
        };
        if text.is_empty() {
            return;
        }
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(&text);
        }
    }
}

/// `2026-11-12_17-05-09` in UTC, without a date library.
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}_{h:02}-{m:02}-{s:02}")
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Esc {
    #[default]
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
    Charset,
}

/// Takes terminal control sequences (colours, cursor moves, titles) out of
/// the output; keeps text, newlines and tabs. State carries across chunks.
#[derive(Default)]
pub struct AnsiFilter {
    state: Esc,
}

impl AnsiFilter {
    pub fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        for &b in input {
            self.state = match self.state {
                Esc::Text => match b {
                    0x1b => Esc::Escape,
                    b'\r' => Esc::Text, // CR LF becomes LF
                    b'\n' | b'\t' => {
                        out.push(b);
                        Esc::Text
                    }
                    0x08 => {
                        out.pop();
                        Esc::Text
                    }
                    0x00..=0x1f | 0x7f => Esc::Text,
                    _ => {
                        out.push(b);
                        Esc::Text
                    }
                },
                Esc::Escape => match b {
                    b'[' => Esc::Csi,
                    b']' => Esc::Osc,
                    b'(' | b')' | b'*' | b'+' => Esc::Charset,
                    _ => Esc::Text,
                },
                Esc::Csi if (0x40..=0x7e).contains(&b) => Esc::Text,
                Esc::Csi => Esc::Csi,
                Esc::Osc if b == 0x07 => Esc::Text,
                Esc::Osc if b == 0x1b => Esc::OscEscape,
                Esc::Osc => Esc::Osc,
                Esc::OscEscape => Esc::Text,
                Esc::Charset => Esc::Text,
            };
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_titles_and_cursor_moves_are_removed() {
        let mut f = AnsiFilter::default();
        let out = f.feed(b"\x1b]0;user@host: ~\x07\x1b[01;32muser@host\x1b[00m:~$ ls\r\na  b\r\n");
        assert_eq!(out, b"user@host:~$ ls\na  b\n");
    }

    #[test]
    fn sequences_split_across_chunks() {
        let mut f = AnsiFilter::default();
        let a = f.feed(b"ok\x1b[3");
        let b = f.feed(b"1mred\x1b");
        let c = f.feed(b"[0m done\x08\x08\x08\x08 now\n");
        assert_eq!([a, b, c].concat(), b"okred  now\n");
    }

    #[test]
    fn file_names_are_safe_and_dated() {
        let dir = std::env::temp_dir().join(format!("wc-log-{}", std::process::id()));
        let log = SessionLog::start(&dir, "prod/web 1").expect("log");
        log.write(b"\x1b[1mhello\x1b[0m\r\n");
        let files: Vec<_> = std::fs::read_dir(super::dir(&dir))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(files.len(), 1);
        let name = files[0].file_name().to_string_lossy().into_owned();
        assert!(
            name.starts_with("prod_web_1-20") && name.ends_with(".log"),
            "{name}"
        );
        assert_eq!(std::fs::read(files[0].path()).unwrap(), b"hello\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
