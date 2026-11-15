//! Docker daemons on a server: the system one and every rootless one
//! (a user's own dockerd, socket in `/run/user/<uid>/docker.sock`).
//!
//! Each daemon is a separate environment with its own storage, images and
//! build cache: `docker system df` only answers for the daemon it talks to,
//! so a rootless daemon's tens of gigabytes were invisible to the cleanup
//! before. Everything here goes through that daemon's own API (the Docker
//! CLI with `-H`), never through its folders: nothing deletes
//! `overlayfs/snapshots` or other storage directly, containers and volumes
//! are never removed, and `docker image prune` leaves every image a
//! container (running or stopped) still uses.
//!
//! Values that come from the server (socket paths, user ids, names) never go
//! into a command as text: a rootless daemon is addressed by its numeric uid
//! only, and the socket path is rebuilt from that number.

use serde::Serialize;

use crate::{docker_bytes, first, run, sections, Shell};

/// Where rootless daemons put their socket (`$XDG_RUNTIME_DIR`).
pub(crate) const RUN_USER: &str = "/run/user";
/// The system daemon's socket (`/var/run` is a link to `/run` on current
/// distributions; both are tried).
const SYSTEM_SOCKETS: &[&str] = &["/var/run/docker.sock", "/run/docker.sock"];

/// `dk <socket> <docker args…>`: the Docker CLI against one daemon, as root
/// when this connection can be root, else as the connected user (enough for
/// the system daemon when the user is in the `docker` group, and for the
/// user's own rootless daemon). Every call has a time limit.
pub(crate) const DK: &str = r#"dk() { h=$1; shift; [ "$h" ] && set -- -H "unix://$h" "$@"; if [ "$R" ]; then r timeout 60 docker "$@"; else timeout 60 docker "$@"; fi; }
"#;

/// One Docker daemon on the server.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerEnv {
    /// `system`, or `u<uid>` for a rootless daemon: what cleanup ids carry.
    pub id: String,
    /// `system` or `rootless`.
    pub kind: String,
    /// "Sistem Docker", "DEVAGENT-CI — Rootless Docker".
    pub label: String,
    /// The Linux user the daemon runs as (`root` for the system daemon).
    pub user: String,
    pub uid: u32,
    pub socket: String,
    /// Docker's storage folder (`DockerRootDir`), when the daemon answered.
    pub root_dir: String,
    /// What `docker system df` reports, by type.
    pub images_bytes: u64,
    /// Space that removing every unused image frees, as Docker counts it
    /// (layers shared with a used image are not counted).
    pub images_reclaimable_bytes: u64,
    pub build_cache_bytes: u64,
    pub build_cache_reclaimable_bytes: u64,
    pub containers_bytes: u64,
    pub volumes_bytes: u64,
    /// Images with no tag that no container uses (at most this much).
    pub dangling_bytes: u64,
    pub images_total: u32,
    pub images_active: u32,
    pub containers_total: u32,
    pub containers_running: u32,
    /// Running containers (name and image): never touched by a cleanup.
    pub running: Vec<String>,
    /// Why this daemon could not be read (no access, timeout, not running);
    /// empty when it answered. Its sizes are then unknown, not zero.
    pub error: String,
}

impl DockerEnv {
    pub fn total_bytes(&self) -> u64 {
        self.images_bytes + self.build_cache_bytes + self.containers_bytes + self.volumes_bytes
    }
}

/// A daemon found on the server, before it is asked anything.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Found {
    pub id: String,
    pub uid: u32,
    pub socket: String,
}

/// Finds the daemons: the system socket and `/run/user/<uid>/docker.sock`
/// sockets. A user's folder there is private, so the search runs as root
/// when it can; without root only the connected user's own daemon is seen.
/// A socket counts only when the user who owns it is the one its folder
/// belongs to (another user's socket planted there is ignored).
pub(crate) const DISCOVER: &str = r#"echo @@me; id -u
echo @@hasdocker; command -v docker >/dev/null 2>&1 && echo yes
echo @@system; for s in /var/run/docker.sock /run/docker.sock; do [ -S "$s" ] && { echo "$s"; break; }; done
echo @@rootless; r find /run/user -mindepth 2 -maxdepth 2 -name docker.sock -type s -printf '%h\t%U\n' 2>/dev/null
"#;

/// [`DISCOVER`] for another folder than `/run/user` (tests).
pub(crate) fn discover_script(run_user: &str) -> String {
    if run_user == RUN_USER {
        DISCOVER.to_owned()
    } else {
        DISCOVER.replace("/run/user", run_user)
    }
}

pub(crate) fn parse_found(text: &str, run_user: &str) -> (bool, String, Vec<Found>) {
    let s = sections(text);
    let has_docker = first(&s, "hasdocker") == "yes";
    let system = first(&s, "system").to_owned();
    let mut found = Vec::new();
    // The system daemon: its socket when one is there, else whatever the CLI
    // reaches by default (a DOCKER_HOST or context set on the server).
    if has_docker {
        let socket = if SYSTEM_SOCKETS.contains(&system.as_str()) {
            system.clone()
        } else {
            String::new()
        };
        found.push(Found {
            id: "system".into(),
            uid: 0,
            socket,
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for line in s.get("rootless").into_iter().flatten() {
        let Some((dir, owner)) = line.split_once('\t') else {
            continue;
        };
        let Some(name) = dir.strip_prefix(run_user).and_then(|d| d.strip_prefix('/')) else {
            continue;
        };
        let (Ok(uid), Ok(owner)) = (name.parse::<u32>(), owner.trim().parse::<u32>()) else {
            continue;
        };
        // The folder is the uid's; the socket must be that user's too.
        if uid != owner || name != uid.to_string() || uid == 0 || !seen.insert(uid) {
            continue;
        }
        found.push(Found {
            id: format!("u{uid}"),
            uid,
            socket: format!("{run_user}/{uid}/docker.sock"),
        });
    }
    (has_docker, system, found)
}

/// One script that asks every daemon the same questions; each answer is in
/// its own `@@<what>.<id>` section, with the exit code of `system df`.
pub(crate) fn query_script(found: &[Found]) -> String {
    let mut script = String::from(DK);
    for f in found {
        let id = &f.id;
        // `f.socket` is a fixed system path or `<run_user>/<digits>/docker.sock`.
        let h = &f.socket;
        if f.uid != 0 {
            script.push_str(&format!(
                "echo @@user.{id}; r getent passwd {uid} | cut -d: -f1\n",
                uid = f.uid
            ));
        }
        script.push_str(&format!(
            "echo @@df.{id}; out=$(dk '{h}' system df --format '{{{{.Type}}}}\t{{{{.TotalCount}}}}\t{{{{.Active}}}}\t{{{{.Size}}}}\t{{{{.Reclaimable}}}}' 2>&1); c=$?; printf '%s\\n' \"$out\"; echo @@code.{id}; echo $c
echo @@root.{id}; dk '{h}' info --format '{{{{.DockerRootDir}}}}' 2>/dev/null
echo @@ps.{id}; dk '{h}' ps --format '{{{{.Names}}}}\t{{{{.Image}}}}' 2>/dev/null | head -50
echo @@all.{id}; dk '{h}' ps -aq 2>/dev/null | wc -l
echo @@dangling.{id}; dk '{h}' images -f dangling=true --format '{{{{.Size}}}}' 2>/dev/null
"
        ));
    }
    script
}

/// A daemon's answer that is an error, as the person should read it.
fn explain(output: &str, code: &str) -> String {
    let text = output.trim();
    let lower = text.to_ascii_lowercase();
    if code == "124" || lower.contains("timeout") || lower.contains("timed out") {
        "Docker zamanında yanıt vermedi (60 sn).".into()
    } else if lower.contains("permission denied") {
        "Bu Docker'a erişim izni yok: sunucuya root (ya da parolasız sudo) ile bağlanın.".into()
    } else if lower.contains("cannot connect")
        || lower.contains("connection refused")
        || lower.contains("no such file")
    {
        "Bu Docker şu an çalışmıyor ya da soketine ulaşılamadı.".into()
    } else if text.is_empty() {
        format!("Docker yanıt vermedi (çıkış kodu {code}).")
    } else {
        format!(
            "Docker hata verdi: {}",
            text.lines()
                .last()
                .unwrap_or(text)
                .chars()
                .take(200)
                .collect::<String>()
        )
    }
}

fn count(text: &str) -> u32 {
    text.split_whitespace()
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

pub(crate) fn parse_envs(text: &str, found: &[Found]) -> Vec<DockerEnv> {
    let s = sections(text);
    let lines = |name: &str| -> Vec<String> { s.get(name).cloned().unwrap_or_default() };
    found
        .iter()
        .map(|f| {
            let id = &f.id;
            let user = if f.uid == 0 {
                "root".to_owned()
            } else {
                let u = first(&s, &format!("user.{id}")).to_owned();
                let valid = !u.is_empty()
                    && u.len() <= 32
                    && u.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
                if valid {
                    u
                } else {
                    format!("uid {}", f.uid)
                }
            };
            let label = if f.uid == 0 {
                "Sistem Docker".to_owned()
            } else {
                format!("{} — Rootless Docker", user.to_uppercase())
            };
            let mut env = DockerEnv {
                id: id.clone(),
                kind: if f.uid == 0 { "system" } else { "rootless" }.into(),
                label,
                user,
                uid: f.uid,
                socket: f.socket.clone(),
                ..Default::default()
            };
            let code = first(&s, &format!("code.{id}")).to_owned();
            let df = lines(&format!("df.{id}"));
            let rows: Vec<Vec<&str>> = df
                .iter()
                .map(|l| l.split('\t').collect::<Vec<_>>())
                .filter(|f| f.len() >= 5)
                .collect();
            if code != "0" || rows.is_empty() {
                env.error = explain(&df.join("\n"), &code);
                return env;
            }
            for r in rows {
                let size = docker_bytes(r[3]);
                let reclaim = docker_bytes(r[4]);
                match r[0].trim().to_ascii_lowercase().as_str() {
                    "images" => {
                        env.images_total = count(r[1]);
                        env.images_active = count(r[2]);
                        env.images_bytes = size;
                        env.images_reclaimable_bytes = reclaim;
                    }
                    "containers" => {
                        env.containers_total = count(r[1]);
                        env.containers_running = count(r[2]);
                        env.containers_bytes = size;
                    }
                    "local volumes" => env.volumes_bytes = size,
                    "build cache" => {
                        env.build_cache_bytes = size;
                        env.build_cache_reclaimable_bytes = reclaim;
                    }
                    _ => {}
                }
            }
            env.root_dir = first(&s, &format!("root.{id}")).to_owned();
            env.running = lines(&format!("ps.{id}"))
                .iter()
                .filter_map(|l| l.split_once('\t'))
                .map(|(name, image)| format!("{name} ({image})"))
                .collect();
            let all = count(first(&s, &format!("all.{id}")));
            env.containers_total = env.containers_total.max(all);
            env.containers_running = env.containers_running.max(env.running.len() as u32);
            // Untagged images are a subset of the unused ones: never more.
            env.dangling_bytes = lines(&format!("dangling.{id}"))
                .iter()
                .map(|x| docker_bytes(x))
                .sum::<u64>()
                .min(env.images_reclaimable_bytes);
            env
        })
        .collect()
}

/// Every daemon on the server, read: the system one first. Empty when
/// Docker is not installed.
pub async fn environments<S: Shell>(sh: &S) -> Result<Vec<DockerEnv>, String> {
    environments_in(sh, RUN_USER).await
}

pub(crate) async fn environments_in<S: Shell>(
    sh: &S,
    run_user: &str,
) -> Result<Vec<DockerEnv>, String> {
    let (has_docker, _, found) =
        parse_found(&run(sh, &discover_script(run_user), 30).await?, run_user);
    if !has_docker || found.is_empty() {
        return Ok(Vec::new());
    }
    // A minute per daemon at most, plus a margin.
    let secs = 30 + 70 * found.len() as u64;
    Ok(parse_envs(
        &run(sh, &query_script(&found), secs).await?,
        &found,
    ))
}

/// The Docker cleanup kinds, per daemon.
pub(crate) struct DockerKind {
    pub kind: &'static str,
    pub title: &'static str,
    pub detail: &'static str,
    /// The Docker CLI arguments (after `-H`); fixed text.
    pub args: &'static str,
    pub warning: &'static str,
}

pub(crate) const DOCKER_KINDS: &[DockerKind] = &[
    DockerKind {
        kind: "docker-build",
        title: "Docker build önbelleği",
        detail: "İmaj derlerken biriken katmanlar. Yeniden oluşturulabilir; sonraki derleme biraz uzun sürebilir.",
        args: "builder prune -af",
        warning: "",
    },
    DockerKind {
        kind: "docker-dangling",
        title: "Docker: etiketsiz imajlar",
        detail: "Yeni sürümü gelmiş, hiçbir konteynerin kullanmadığı eski imaj katmanları.",
        args: "image prune -f",
        warning: "",
    },
    DockerKind {
        kind: "docker-unused",
        title: "Docker: kullanılmayan tüm imajlar",
        detail: "Hiçbir konteynerin (durmuş olanlar dahil) kullanmadığı imajlar. Çalışan ve durmuş konteynerlerin imajları, konteynerler ve volume'ler korunur.",
        args: "image prune -af",
        warning: "Coolify gibi araçlar eski sürüme dönmek için bu imajları kullanır; silinince o sürüme geri dönülemez.",
    },
];

/// The command a Docker cleanup runs, for the daemon at `socket` (empty:
/// the system daemon as the CLI finds it, as before rootless support).
pub(crate) fn docker_clean_command(kind: &DockerKind, socket: &str) -> String {
    if socket.is_empty() {
        format!("docker {}", kind.args)
    } else {
        format!("docker -H unix://{socket} {}", kind.args)
    }
}

/// Splits a cleanup id: `docker-build` (the system daemon) or
/// `docker-build@u1000` (user 1000's rootless daemon).
pub(crate) fn split_id(id: &str) -> (&str, Option<&str>) {
    match id.split_once('@') {
        Some((kind, env)) => (kind, Some(env)),
        None => (id, None),
    }
}

/// Where a daemon keeps its data, for the Disk page: a folder there is
/// shown as that daemon's storage, with a way to its cleanup.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerStore {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub user: String,
    pub socket: String,
    pub root_dir: String,
    pub error: String,
}

/// The daemons and their storage folders only (quick: no sizes).
pub async fn stores<S: Shell>(sh: &S) -> Result<Vec<DockerStore>, String> {
    let (has_docker, _, found) = parse_found(&run(sh, DISCOVER, 30).await?, RUN_USER);
    if !has_docker || found.is_empty() {
        return Ok(Vec::new());
    }
    let mut script = String::from(DK);
    for f in &found {
        let (id, h) = (&f.id, &f.socket);
        if f.uid != 0 {
            script.push_str(&format!(
                "echo @@user.{id}; r getent passwd {} | cut -d: -f1\n",
                f.uid
            ));
        }
        script.push_str(&format!(
            "echo @@root.{id}; out=$(dk '{h}' info --format '{{{{.DockerRootDir}}}}' 2>&1); c=$?; printf '%s\\n' \"$out\"; echo @@code.{id}; echo $c\n"
        ));
    }
    let s = sections(&run(sh, &script, 30 + 70 * found.len() as u64).await?);
    // The same names and labels as the cleanup's environments.
    let envs = parse_envs("", &found);
    Ok(found
        .iter()
        .zip(envs)
        .map(|(f, e)| {
            let id = &f.id;
            let user = if f.uid == 0 {
                "root".to_owned()
            } else {
                let u = first(&s, &format!("user.{id}")).to_owned();
                if !u.is_empty()
                    && u.len() <= 32
                    && u.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                {
                    u
                } else {
                    e.user.clone()
                }
            };
            let label = if f.uid == 0 {
                e.label.clone()
            } else {
                format!("{} — Rootless Docker", user.to_uppercase())
            };
            let code = first(&s, &format!("code.{id}")).to_owned();
            let out = s
                .get(&format!("root.{id}"))
                .map(|l| l.join("\n"))
                .unwrap_or_default();
            let ok = code == "0" && out.trim().starts_with('/');
            DockerStore {
                id: id.clone(),
                kind: e.kind,
                label,
                user,
                socket: f.socket.clone(),
                root_dir: if ok {
                    out.trim().to_owned()
                } else {
                    String::new()
                },
                error: if ok {
                    String::new()
                } else {
                    explain(&out, &code)
                },
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(text: &str) -> (bool, String, Vec<Found>) {
        parse_found(text, RUN_USER)
    }

    const SYSTEM_DF: &str = "Images\t12\t3\t9.5GB\t6.2GB (65%)\nContainers\t3\t2\t120MB\t10MB (8%)\nLocal Volumes\t4\t2\t1.1GB\t0B (0%)\nBuild Cache\t40\t0\t2.5GB\t2.5GB";

    /// The `@@…` answer of [`query_script`] for daemons `envs`:
    /// (id, df, code, root, running, all, dangling sizes, user).
    #[allow(clippy::type_complexity)]
    fn answers(envs: &[(&str, &str, &str, &str, &str, &str, &str, &str)]) -> String {
        let mut t = String::new();
        for (id, df, code, root, running, all, dangling, user) in envs {
            if !user.is_empty() {
                t.push_str(&format!("@@user.{id}\n{user}\n"));
            }
            t.push_str(&format!(
                "@@df.{id}\n{df}\n@@code.{id}\n{code}\n@@root.{id}\n{root}\n@@ps.{id}\n{running}\n@@all.{id}\n{all}\n@@dangling.{id}\n{dangling}\n"
            ));
        }
        t
    }

    // 1. Only the system daemon.
    #[test]
    fn only_the_system_daemon() {
        let (has, _, f) =
            found("@@me\n0\n@@hasdocker\nyes\n@@system\n/var/run/docker.sock\n@@rootless\n");
        assert!(has);
        assert_eq!(
            f,
            vec![Found {
                id: "system".into(),
                uid: 0,
                socket: "/var/run/docker.sock".into()
            }]
        );
        let envs = parse_envs(
            &answers(&[(
                "system",
                SYSTEM_DF,
                "0",
                "/var/lib/docker",
                "web\tnginx:1",
                "3",
                "300MB",
                "",
            )]),
            &f,
        );
        assert_eq!(envs[0].label, "Sistem Docker");
        assert_eq!(envs[0].kind, "system");
        assert_eq!(envs[0].images_reclaimable_bytes, 6_200_000_000);
        assert_eq!(envs[0].build_cache_reclaimable_bytes, 2_500_000_000);
        assert_eq!(envs[0].volumes_bytes, 1_100_000_000);
        assert_eq!(envs[0].root_dir, "/var/lib/docker");
        assert!(envs[0].error.is_empty());
    }

    // 2 and 3. The system daemon and one or more rootless ones, each separate.
    #[test]
    fn system_and_several_rootless_daemons_are_separate_environments() {
        let (_, _, f) = found(
            "@@hasdocker\nyes\n@@system\n/var/run/docker.sock\n@@rootless\n/run/user/1000\t1000\n/run/user/1001\t1001\n",
        );
        assert_eq!(
            f.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            ["system", "u1000", "u1001"]
        );
        assert_eq!(f[1].socket, "/run/user/1000/docker.sock");
        let devagent_df = "Images\t31\t1\t61.2GB\t13.9GB (22%)\nContainers\t1\t1\t2MB\t0B (0%)\nLocal Volumes\t3\t1\t328MB\t0B (0%)\nBuild Cache\t512\t0\t33.77GB\t33.77GB";
        let envs = parse_envs(
            &answers(&[
                ("system", SYSTEM_DF, "0", "/var/lib/docker", "", "0", "", ""),
                ("u1000", devagent_df, "0", "/var/lib/devagent-ci/.local/share/docker", "devagent-stage2-gpu-relay\tdevagent/relay:42", "1", "1.2GB\n800MB", "devagent-ci"),
                ("u1001", "Images\t0\t0\t0B\t0B\nContainers\t0\t0\t0B\t0B\nLocal Volumes\t0\t0\t0B\t0B\nBuild Cache\t0\t0\t0B\t0B", "0", "/home/ci2/.local/share/docker", "", "0", "", "ci2"),
            ]),
            &f,
        );
        let devagent = &envs[1];
        assert_eq!(devagent.label, "DEVAGENT-CI — Rootless Docker");
        assert_eq!(devagent.kind, "rootless");
        assert_eq!(devagent.user, "devagent-ci");
        assert_eq!(devagent.socket, "/run/user/1000/docker.sock");
        assert_eq!(devagent.build_cache_reclaimable_bytes, 33_770_000_000);
        assert_eq!(
            devagent.root_dir,
            "/var/lib/devagent-ci/.local/share/docker"
        );
        // 5. The running relay container is listed as protected.
        assert_eq!(devagent.containers_running, 1);
        assert_eq!(
            devagent.running,
            ["devagent-stage2-gpu-relay (devagent/relay:42)"]
        );
        assert_eq!(envs[2].label, "CI2 — Rootless Docker");
    }

    // A socket in another user's folder, or root's, is not a rootless daemon.
    #[test]
    fn a_socket_not_owned_by_its_folders_user_is_ignored() {
        let (_, _, f) = found("@@hasdocker\nyes\n@@system\n\n@@rootless\n/run/user/1000\t0\n/run/user/0\t0\n/run/user/abc\t1000\n/run/user/1002\t1002\n");
        assert_eq!(
            f.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            ["system", "u1002"]
        );
        // No system socket file: the CLI's own default, not a made-up path.
        assert_eq!(f[0].socket, "");
    }

    #[test]
    fn no_docker_no_environments() {
        let (has, _, f) = found("@@hasdocker\n\n@@system\n\n@@rootless\n/run/user/1000\t1000\n");
        assert!(!has);
        assert!(f.iter().all(|f| f.id != "system"));
    }

    // 4 and 10. No access, a dead socket, a timeout: an error for that daemon
    // alone, never sizes of zero.
    #[test]
    fn unreadable_daemons_carry_their_reason_not_zero() {
        let f = vec![
            Found {
                id: "system".into(),
                uid: 0,
                socket: "/var/run/docker.sock".into(),
            },
            Found {
                id: "u1000".into(),
                uid: 1000,
                socket: "/run/user/1000/docker.sock".into(),
            },
            Found {
                id: "u1001".into(),
                uid: 1001,
                socket: "/run/user/1001/docker.sock".into(),
            },
            Found {
                id: "u1002".into(),
                uid: 1002,
                socket: "/run/user/1002/docker.sock".into(),
            },
        ];
        let envs = parse_envs(
            &answers(&[
                ("system", SYSTEM_DF, "0", "/var/lib/docker", "", "0", "", ""),
                ("u1000", "permission denied while trying to connect to the Docker daemon socket", "1", "", "", "", "", "devagent-ci"),
                ("u1001", "Cannot connect to the Docker daemon at unix:///run/user/1001/docker.sock. Is the docker daemon running?", "1", "", "", "", "", "ci2"),
                ("u1002", "", "124", "", "", "", "", "ci3"),
            ]),
            &f,
        );
        assert!(envs[0].error.is_empty());
        assert!(
            envs[1].error.contains("erişim izni yok"),
            "{}",
            envs[1].error
        );
        assert!(envs[2].error.contains("çalışmıyor"), "{}", envs[2].error);
        assert!(envs[3].error.contains("zamanında"), "{}", envs[3].error);
        for e in &envs[1..] {
            assert_eq!(e.total_bytes(), 0);
            assert!(!e.error.is_empty());
        }
    }

    // 8. Images are not added up: Docker's own reclaimable (shared layers
    // counted once) is what is offered; untagged images never exceed it.
    #[test]
    fn shared_layers_are_not_counted_twice() {
        let f = vec![Found {
            id: "u1000".into(),
            uid: 1000,
            socket: "/run/user/1000/docker.sock".into(),
        }];
        // Ten 5 GB images sharing layers: listed sizes add up to 50 GB, Docker
        // says 4 GB can be freed.
        let dangling = ["5GB"; 10].join("\n");
        let envs = parse_envs(
            &answers(&[(
                "u1000",
                "Images\t10\t0\t6GB\t4GB (66%)\nBuild Cache\t0\t0\t0B\t0B",
                "0",
                "/x",
                "",
                "0",
                &dangling,
                "u",
            )]),
            &f,
        );
        assert_eq!(envs[0].images_reclaimable_bytes, 4_000_000_000);
        assert_eq!(envs[0].dangling_bytes, 4_000_000_000);
    }

    // 5, 6, 7 and the forbidden list: only Docker's own prune commands, never
    // containers, volumes, system prune or storage folders.
    #[test]
    fn cleanups_only_prune_unused_images_and_build_cache() {
        for k in DOCKER_KINDS {
            let c = docker_clean_command(k, "/run/user/1000/docker.sock");
            assert!(
                c.starts_with("docker -H unix:///run/user/1000/docker.sock "),
                "{c}"
            );
            for forbidden in [
                "rm ",
                "volume",
                "container",
                "system prune",
                "--volumes",
                "snapshots",
                "overlayfs",
                "kill",
                "stop",
            ] {
                assert!(!c.contains(forbidden), "{c} contains {forbidden}");
            }
        }
        // `image prune` (with or without -a) leaves the image of every container, running or stopped.
        assert!(DOCKER_KINDS
            .iter()
            .any(|k| k.args == "image prune -af" && !k.warning.is_empty()));
        assert_eq!(
            docker_clean_command(&DOCKER_KINDS[0], ""),
            "docker builder prune -af"
        );
    }

    #[test]
    fn cleanup_ids_name_their_daemon() {
        assert_eq!(split_id("docker-build"), ("docker-build", None));
        assert_eq!(
            split_id("docker-build@u1000"),
            ("docker-build", Some("u1000"))
        );
    }
}
