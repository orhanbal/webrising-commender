//! Output redaction (v1.2, AD1-21 slice 1): secrets in command, task,
//! terminal and process-list output are masked on the device, before the
//! result leaves it (to the gateway or a local MCP client).
//!
//! Masked: private key blocks, Authorization header values, well-known token
//! formats (GitHub, GitLab, Slack, AWS access key ids, OpenAI/Anthropic-style
//! `sk-` keys, JWTs), credentials in URLs, and values of assignments whose
//! name says password/secret/token/api key. The name is kept so the reader
//! still sees what was there. File reads are not redacted: editing tools
//! need the exact content, and the person chose that file.
//!
//! Redaction is best effort: it lowers the chance of a secret reaching the AI,
//! it does not prove that none does. Owners can turn it off per device
//! (`capabilities --redact-output off`, or `mcp-stdio --no-redact`).
use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;

pub const MASK: &str = "[REDACTED]";

struct Rule {
    pattern: Regex,
    /// Capture group kept before the mask (0 = mask the whole match).
    keep: usize,
    /// Group `keep + 1` is kept after the mask (e.g. the `@` of a URL).
    suffix: bool,
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let rule = |pattern: &str, keep: usize| Rule {
        pattern: Regex::new(pattern).expect("valid redaction pattern"),
        keep,
        suffix: false,
    };
    vec![
        // PEM private keys (RSA, EC, OPENSSH, PKCS#8, encrypted).
        rule(
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
            0,
        ),
        // Authorization: Bearer|Basic|Token <value>
        rule(
            r"(?i)(\bauthorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s'\x22,;]+",
            1,
        ),
        // user:password@ in URLs (postgres://, https://, redis://, …).
        Rule {
            pattern: Regex::new(r"(?i)(\b[a-z][a-z0-9+.-]*://[^\s:/@'\x22]+:)[^\s@/'\x22]+(@)")
                .expect("valid redaction pattern"),
            keep: 1,
            suffix: true,
        },
        // Well-known token formats.
        rule(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b", 0),
        rule(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b", 0),
        rule(r"\bglpat-[A-Za-z0-9_-]{20,}\b", 0),
        rule(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", 0),
        rule(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0),
        rule(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b", 0),
        rule(
            r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
            0,
        ),
        // NAME=value, NAME: value, "name": "value" where NAME mentions a secret.
        rule(
            r#"(?i)(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*['"]?\s*[:=]\s*['"]?)[^\s'",;&]{3,}"#,
            1,
        ),
    ]
});

/// Mask secrets in one string; returns the new text and how many were masked.
pub fn redact_text(text: &str) -> (String, usize) {
    let mut out = text.to_owned();
    let mut count = 0;
    for rule in RULES.iter() {
        let replaced = rule.pattern.replace_all(&out, |caps: &Captures<'_>| {
            let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let group = |i: usize| caps.get(i).map(|m| m.as_str()).unwrap_or("");
            let prefix = if rule.keep == 0 { "" } else { group(rule.keep) };
            // Already masked by an earlier rule or an earlier pass.
            if whole[prefix.len()..].starts_with(MASK) {
                return whole.to_owned();
            }
            count += 1;
            let suffix = if rule.suffix {
                group(rule.keep + 1)
            } else {
                ""
            };
            format!("{prefix}{MASK}{suffix}")
        });
        if let std::borrow::Cow::Owned(text) = replaced {
            out = text;
        }
    }
    (out, count)
}

/// Mask secrets in every string of a JSON value, in place.
pub fn redact_value(value: &mut Value) -> usize {
    match value {
        Value::String(text) => {
            let (masked, count) = redact_text(text);
            if count > 0 {
                *text = masked;
            }
            count
        }
        Value::Array(items) => items.iter_mut().map(redact_value).sum(),
        Value::Object(map) => map.values_mut().map(redact_value).sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn masked(text: &str) -> String {
        redact_text(text).0
    }

    #[test]
    fn masks_assignments_and_keeps_the_name() {
        assert_eq!(masked("DB_PASSWORD=hunter2xyz"), "DB_PASSWORD=[REDACTED]");
        assert_eq!(
            masked("export API_KEY='abc123def'"),
            "export API_KEY='[REDACTED]'"
        );
        assert_eq!(
            masked(r#"{"client_secret": "s3cr3t-value"}"#),
            r#"{"client_secret": "[REDACTED]"}"#
        );
        assert_eq!(masked("password: correct-horse"), "password: [REDACTED]");
        assert_eq!(
            masked("mysql -u root --password=topsecret db"),
            "mysql -u root --password=[REDACTED] db"
        );
    }

    #[test]
    fn masks_headers_urls_keys_and_tokens() {
        assert_eq!(
            masked("Authorization: Bearer abc.def.ghi"),
            "Authorization: Bearer [REDACTED]"
        );
        assert_eq!(
            masked("postgres://app:pa55word@db:5432/x"),
            "postgres://app:[REDACTED]@db:5432/x"
        );
        assert_eq!(
            masked(&format!("token ghp_{}", "a".repeat(36))),
            "token [REDACTED]"
        );
        assert_eq!(masked("AKIAABCDEFGHIJKLMNOP"), "[REDACTED]");
        assert_eq!(
            masked(&format!("key sk-ant-{}", "x".repeat(30))),
            "key [REDACTED]"
        );
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert_eq!(masked(jwt), "[REDACTED]");
        let pem = "a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nz";
        assert_eq!(masked(pem), "a\n[REDACTED]\nz");
    }

    #[test]
    fn leaves_ordinary_output_alone() {
        for text in [
            "total 12\ndrwxr-xr-x 2 root root 4096 readme.txt",
            "The password policy requires 12 characters.",
            "Tokens are refreshed hourly.",
            "https://example.com/path?q=1",
            "secret=",
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        ] {
            assert_eq!(redact_text(text), (text.to_owned(), 0), "{text}");
        }
    }

    #[test]
    fn counts_and_is_idempotent() {
        let (once, n) = redact_text(
            "PASSWORD=aaa111 TOKEN=bbb222 redis://u:pw1@h api_key=sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert_eq!(n, 4, "{once}");
        assert_eq!(redact_text(&once), (once.clone(), 0));
    }

    #[test]
    fn walks_json_values() {
        let mut value = json!({ "stdout": "SECRET_KEY=abcdef\n", "items": [{ "command": "app --token=zzz999" }], "exitCode": 0 });
        assert_eq!(redact_value(&mut value), 2);
        assert_eq!(value["stdout"], "SECRET_KEY=[REDACTED]\n");
        assert_eq!(value["items"][0]["command"], "app --token=[REDACTED]");
        assert_eq!(value["exitCode"], 0);
    }
}
