//! RFC 3339 times without a date library: what the AI access settings
//! (`timedUntil`), approvals (`expiresAt`) and the MCP audit file need.

/// Seconds since the Unix epoch.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-11-17T09:30:00Z`.
pub fn format_rfc3339(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Unix seconds of an RFC 3339 date-time (`Z` or `±hh:mm`, optional
/// fraction, which is dropped). `None` when it is not one.
pub fn parse_rfc3339(text: &str) -> Option<i64> {
    let t = text.trim().as_bytes();
    if t.len() < 20 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = std::str::from_utf8(t.get(range)?).ok()?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let sep = |i: usize, c: &[u8]| t.get(i).is_some_and(|b| c.contains(b));
    if !(sep(4, b"-") && sep(7, b"-") && sep(10, b"Tt ") && sep(13, b":") && sep(16, b":")) {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let mut i = 19;
    if t.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while t.get(i).is_some_and(|b| b.is_ascii_digit()) {
            i += 1;
        }
        if i == start {
            return None;
        }
    }
    let offset = match t.get(i)? {
        b'Z' | b'z' if i + 1 == t.len() => 0,
        b'+' | b'-' if i + 6 == t.len() && t[i + 3] == b':' => {
            let sign = if t[i] == b'-' { -1 } else { 1 };
            let (oh, om) = (num(i + 1..i + 3)?, num(i + 4..i + 6)?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 3600 + om * 60)
        }
        _ => return None,
    };
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s.min(59) - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_offsets() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        let t = parse_rfc3339("2026-11-17T09:30:05Z").unwrap();
        assert_eq!(format_rfc3339(t), "2026-11-17T09:30:05Z");
        assert_eq!(parse_rfc3339("2026-11-17T12:30:05+03:00"), Some(t));
        assert_eq!(parse_rfc3339("2026-11-17T09:30:05.123456Z"), Some(t));
        assert_eq!(
            parse_rfc3339("2024-02-29T00:00:00Z")
                .map(format_rfc3339)
                .unwrap(),
            "2024-02-29T00:00:00Z"
        );
        for bad in [
            "",
            "2026-11-17",
            "2026-13-01T00:00:00Z",
            "2026-11-17T09:30:05",
            "x026-11-17T09:30:05Z",
            "2026-11-17T09:30:05+0300",
        ] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }
}
