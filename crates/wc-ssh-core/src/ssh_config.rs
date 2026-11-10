//! Reads the hosts of an OpenSSH client config (`~/.ssh/config`) for import
//! (A07). Only concrete `Host` aliases are imported; patterns (`*`, `?`,
//! `!`) and `Match` blocks are skipped. `Include` is not followed.
use crate::HostProfile;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigHost {
    pub profile: HostProfile,
    /// `IdentityFile`, with `~/` expanded against `home`.
    pub identity_file: Option<String>,
}

pub fn parse(text: &str, home: &str, default_user: &str) -> Vec<ConfigHost> {
    #[derive(Default)]
    struct Block {
        aliases: Vec<String>,
        host_name: Option<String>,
        user: Option<String>,
        port: Option<u16>,
        identity: Option<String>,
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut in_match = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (
                k.to_ascii_lowercase(),
                v.trim().trim_start_matches('=').trim(),
            ),
            None => continue,
        };
        let value = value.trim_matches('"');
        match key.as_str() {
            "host" => {
                in_match = false;
                blocks.push(Block {
                    aliases: value
                        .split_whitespace()
                        .filter(|a| !a.contains(['*', '?', '!']))
                        .map(str::to_owned)
                        .collect(),
                    ..Default::default()
                });
            }
            "match" => in_match = true,
            _ if in_match => {}
            "hostname" => {
                if let Some(b) = blocks.last_mut() {
                    b.host_name.get_or_insert_with(|| value.to_owned());
                }
            }
            "user" => {
                if let Some(b) = blocks.last_mut() {
                    b.user.get_or_insert_with(|| value.to_owned());
                }
            }
            "port" => {
                if let Some(b) = blocks.last_mut() {
                    if b.port.is_none() {
                        b.port = value.parse().ok();
                    }
                }
            }
            "identityfile" => {
                if let Some(b) = blocks.last_mut() {
                    if b.identity.is_none() {
                        let path = match value.strip_prefix("~/") {
                            Some(rest) => {
                                format!("{}/{}", home.trim_end_matches(['/', '\\']), rest)
                            }
                            None => value.to_owned(),
                        };
                        b.identity = Some(path);
                    }
                }
            }
            _ => {}
        }
    }
    blocks
        .into_iter()
        .flat_map(|b| {
            b.aliases.clone().into_iter().filter_map(move |alias| {
                let host = b.host_name.clone().unwrap_or_else(|| alias.clone());
                let user = b.user.clone().unwrap_or_else(|| default_user.to_owned());
                HostProfile::new(&alias, &host, b.port.unwrap_or(22), &user)
                    .ok()
                    .map(|profile| ConfigHost {
                        profile,
                        identity_file: b.identity.clone(),
                    })
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_concrete_hosts_only() {
        let text = r#"
# comment
Host *
    User nobody
    ServerAliveInterval 30

Host prod web-1
    HostName 10.0.0.5
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_prod

Host db
    Hostname=db.internal
    IdentityFile "/keys/db key"

Host *.example.com !skip
    User x

Match host bastion
    User ignored
"#;
        let hosts = parse(text, "/home/me", "me");
        let summary: Vec<_> = hosts
            .iter()
            .map(|h| {
                (
                    h.profile.label.as_str(),
                    h.profile.display_target(),
                    h.identity_file.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "prod",
                    "deploy@10.0.0.5:2222".into(),
                    Some("/home/me/.ssh/id_prod")
                ),
                (
                    "web-1",
                    "deploy@10.0.0.5:2222".into(),
                    Some("/home/me/.ssh/id_prod")
                ),
                ("db", "me@db.internal".into(), Some("/keys/db key")),
            ]
        );
    }
}
