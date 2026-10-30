use crate::{policy::PathPolicy, terminal_history::HistoryStore};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

const BUFFER_CAP: usize = 1024 * 1024;
const MAX_SESSIONS: usize = 32;
const MAX_TERMINAL_INPUT_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_INPUT_BASE64_BYTES: usize = MAX_TERMINAL_INPUT_BYTES.div_ceil(3) * 4;

// Reject oversized base64 BEFORE decoding, not after allocating an
// unbounded output buffer. The decoded check is still required because
// adjacent byte lengths can share the same padded base64 length.
fn decode_terminal_input(data_base64: &str) -> Result<Vec<u8>> {
    if data_base64.len() > MAX_TERMINAL_INPUT_BASE64_BYTES {
        return Err(anyhow!("terminal input too large"));
    }
    let data = STANDARD
        .decode(data_base64)
        .context("invalid base64 terminal input")?;
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(anyhow!("terminal input too large"));
    }
    Ok(data)
}

// A bounded, non-consuming history independent of the destructive PTY read queue.
// Offsets refer to the absolute byte position in the session's output stream.
#[derive(Default)]
struct OutputHistory {
    bytes: VecDeque<u8>,
    total_bytes: u64,
    durable: bool,
}

impl OutputHistory {
    fn push(&mut self, chunk: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.len() as u64);
        self.bytes.extend(chunk.iter().copied());
        let excess = self.bytes.len().saturating_sub(BUFFER_CAP);
        self.bytes.drain(..excess);
    }

    // Advisory prompt detection only. Never use terminal output as authorization
    // or proof that a command completed; arbitrary programs can print prompts.
    fn prompt_kind(&self) -> Option<&'static str> {
        let tail: Vec<u8> = self.bytes.iter().rev().take(512).copied().collect();
        let tail: Vec<u8> = tail.into_iter().rev().collect();
        let output = String::from_utf8_lossy(&tail);
        let line = output.rsplit(['\n', '\r']).next().unwrap_or("");
        // Ignore terminal color/control sequences in the bounded final line.
        let mut plain = String::with_capacity(line.len());
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\u{1b}' && chars.peek() == Some(&'[') {
                chars.next();
                for code in chars.by_ref() {
                    if ('@'..='~').contains(&code) {
                        break;
                    }
                }
            } else if !ch.is_control() || ch == '\t' {
                plain.push(ch);
            }
        }
        if plain.ends_with(">>> ") {
            Some("python")
        } else if plain.ends_with("... ") {
            Some("python_continuation")
        } else if plain.starts_with("PS ") && plain.ends_with("> ") {
            Some("powershell")
        } else if plain.ends_with("$ ") || plain.ends_with("# ") || plain.ends_with("% ") {
            Some("shell")
        } else if (plain.starts_with("sqlite>") || plain.starts_with("(gdb)"))
            && plain.ends_with(' ')
        {
            Some("repl")
        } else {
            None
        }
    }

    fn page(&self, offset_bytes: Option<i64>, max_bytes: Option<usize>) -> Value {
        let retained_start = self.total_bytes.saturating_sub(self.bytes.len() as u64);
        let requested = match offset_bytes.unwrap_or(0) {
            offset if offset < 0 => self.total_bytes.saturating_sub(offset.unsigned_abs()),
            offset => offset as u64,
        };
        let start = requested.clamp(retained_start, self.total_bytes);
        let limit = max_bytes.unwrap_or(64 * 1024).clamp(1, 256 * 1024);
        let bytes: Vec<u8> = self
            .bytes
            .iter()
            .skip((start - retained_start) as usize)
            .take(limit)
            .copied()
            .collect();
        let end = start + bytes.len() as u64;
        let prompt_kind = self.prompt_kind();
        json!({
            "bytes": bytes.len(),
            "dataBase64": STANDARD.encode(&bytes),
            "text": String::from_utf8_lossy(&bytes),
            "offsetBytes": start,
            "nextOffsetBytes": end,
            "bufferedBytes": self.bytes.len(),
            "retainedStartBytes": retained_start,
            "totalOutputBytes": self.total_bytes,
            "truncatedBeforeOffset": requested < retained_start,
            "hasMore": end < self.total_bytes,
            "promptDetected": prompt_kind.is_some(),
            "promptKind": prompt_kind,
            "historyDurable": self.durable
        })
    }
}

// A pending PTY spawn must consume quota before the OS process is created.
// Otherwise concurrent terminal_start requests can all observe the same
// sessions.len() and exceed MAX_SESSIONS before any one inserts its session.
struct StartReservation(Arc<AtomicUsize>);

impl Drop for StartReservation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    buffer: Arc<Mutex<VecDeque<u8>>>,
    history: Arc<Mutex<OutputHistory>>,
    owner_scope: String,
    // Holds a device-wide OS file lock until this session is retired.
    _live_slot: Option<File>,
    #[cfg(windows)]
    _windows_job: crate::windows_job::WindowsJob,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    pending_starts: Arc<AtomicUsize>,
    store: Option<Arc<HistoryStore>>,
}

impl TerminalManager {
    pub fn for_device(id: &str) -> Result<Self> {
        Ok(Self {
            store: Some(Arc::new(HistoryStore::for_device(id)?)),
            ..Self::default()
        })
    }

    pub fn start(
        &self,
        policy: &PathPolicy,
        shell: Option<&str>,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        scope: &str,
    ) -> Result<Value> {
        let reservation = self.reserve_start()?;
        // Allocate the archive before spawning an OS child. A disk failure
        // must never leave an untracked live shell behind.
        let id = Uuid::new_v4().to_string();
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows: rows.clamp(5, 300),
            cols: cols.clamp(10, 500),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = shell.map(str::to_owned).unwrap_or_else(default_shell);
        let mut command = CommandBuilder::new(shell);

        if let Some(raw) = cwd {
            command.cwd(policy.resolve_existing(raw)?);
        } else if let Some(root) = policy.roots().first() {
            command.cwd(root);
        }

        // Acquire both fallible master-side handles before spawning a child.
        // Otherwise a failed reader/writer setup after spawn can orphan a live
        // shell and leave an unused durable-history archive behind.
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // Cross-process quota is reserved only after cwd and PTY preflight.
        // Invalid requests must not create even a stable slot file on disk.
        // The lease remains held until the session is removed.
        let live_slot = self
            .store
            .as_ref()
            .map(|store| store.reserve_live_slot())
            .transpose()?;

        // Validate shell/cwd and prepare the PTY before reserving durable disk
        // history. A rejected cwd or PTY handle must not consume an archive slot.
        let history_store = self
            .store
            .as_ref()
            .map(|store| store.scoped(scope))
            .transpose()?
            .map(Arc::new);
        if let Some(store) = &history_store {
            store.save(&id, 0, &VecDeque::new())?;
        }

        // The session map must be writable BEFORE creating the OS child.
        // A poisoned map discovered after spawn would otherwise strand a
        // live shell with no session ID or way to stop it through MCP.
        // Hold this guard until registration, including the spawn itself.
        let mut sessions = match self.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => {
                if let Some(store) = &history_store {
                    store.discard_unstarted(&id).context(
                        "terminal session lock poisoned; startup archive cleanup failed",
                    )?;
                }
                return Err(anyhow!("terminal session lock poisoned"));
            }
        };

        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                // Keep the pre-spawn durability check, but do not retain a
                // phantom 24-hour archive when no OS child was created.
                if let Some(store) = &history_store {
                    store.discard_unstarted(&id).with_context(|| {
                        format!("terminal spawn failed ({error}); startup archive cleanup failed")
                    })?;
                }
                return Err(error);
            }
        };
        #[cfg(windows)]
        let mut child = child;

        // Attach the PTY root to a kill-on-close Windows Job Object before
        // publishing the session. A failed attachment must not leave a live,
        // untracked shell behind. The short spawn-to-attach window remains a
        // separate 2C acceptance gate (suspended creation is not yet used).
        #[cfg(windows)]
        let windows_job = match child
            .as_raw_handle()
            .ok_or_else(|| anyhow!("PTY child handle unavailable"))
            .and_then(crate::windows_job::WindowsJob::attach)
        {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(store) = &history_store {
                    store.discard_unstarted(&id)?;
                }
                return Err(error.context("Windows PTY job assignment failed closed"));
            }
        };
        drop(pair.slave);

        let buffer = Arc::new(Mutex::new(VecDeque::new()));
        let read_buffer = Arc::clone(&buffer);
        let history = Arc::new(Mutex::new(OutputHistory::default()));
        let read_history = Arc::clone(&history);
        let history_id = id.clone();

        std::thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        // Publish history first: a destructive reader must never
                        // observe bytes that are not yet available for paging.
                        if let Ok(mut retained) = read_history.lock() {
                            retained.push(&chunk[..size]);
                            if let Some(store) = &history_store {
                                retained.durable = store
                                    .save(&history_id, retained.total_bytes, &retained.bytes)
                                    .is_ok();
                            }
                        }
                        if let Ok(mut queue) = read_buffer.lock() {
                            for byte in &chunk[..size] {
                                queue.push_back(*byte);
                            }
                            while queue.len() > BUFFER_CAP {
                                queue.pop_front();
                            }
                        }
                    }
                }
            }
        });

        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            buffer,
            history,
            owner_scope: scope.to_owned(),
            _live_slot: live_slot,
            #[cfg(windows)]
            _windows_job: windows_job,
        });

        sessions.insert(id.clone(), session);
        // Release the reservation while holding the same mutex used to count
        // active sessions: another starter can never observe a quota gap.
        drop(reservation);

        Ok(json!({ "sessionId": id }))
    }

    fn reserve_start(&self) -> Result<StartReservation> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?;
        sessions.retain(|_, session| {
            let Ok(mut child) = session.child.lock() else {
                return true;
            };
            !matches!(child.try_wait(), Ok(Some(_)))
        });
        let active_and_pending = sessions.len() + self.pending_starts.load(Ordering::SeqCst);
        if active_and_pending >= MAX_SESSIONS {
            return Err(anyhow!(
                "too many terminal sessions; limit is {MAX_SESSIONS}"
            ));
        }
        self.pending_starts.fetch_add(1, Ordering::SeqCst);
        Ok(StartReservation(Arc::clone(&self.pending_starts)))
    }

    pub fn list(&self, scope: &str) -> Result<Value> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?;
        let mut items = Vec::with_capacity(sessions.len());

        for (id, session) in sessions.iter() {
            if session.owner_scope != scope {
                continue;
            }
            let buffered_bytes = session
                .buffer
                .lock()
                .map_err(|_| anyhow!("terminal buffer lock poisoned"))?
                .len();
            let mut child = session
                .child
                .lock()
                .map_err(|_| anyhow!("terminal child lock poisoned"))?;
            let running = child.try_wait()?.is_none();

            items.push(json!({
                "sessionId": id,
                "pid": child.process_id(),
                "running": running,
                "bufferedBytes": buffered_bytes
            }));
        }

        Ok(json!({ "items": items }))
    }

    pub fn input(&self, id: &str, data_base64: &str, scope: &str) -> Result<Value> {
        let session = self.get(id, scope)?;
        let data = decode_terminal_input(data_base64)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| anyhow!("terminal writer lock poisoned"))?;
        writer.write_all(&data)?;
        writer.flush()?;
        Ok(json!({ "ok": true, "bytes": data.len() }))
    }

    pub fn read(&self, id: &str, max_bytes: usize, scope: &str) -> Result<Value> {
        let session = self.get(id, scope)?;
        let max = max_bytes.clamp(1, 256 * 1024);
        let mut queue = session
            .buffer
            .lock()
            .map_err(|_| anyhow!("terminal buffer lock poisoned"))?;
        let mut bytes = Vec::with_capacity(max.min(queue.len()));
        for _ in 0..max.min(queue.len()) {
            if let Some(byte) = queue.pop_front() {
                bytes.push(byte);
            }
        }

        let remaining_bytes = queue.len();
        drop(queue);
        let history = session
            .history
            .lock()
            .map_err(|_| anyhow!("terminal history lock poisoned"))?;
        let prompt_kind = history.prompt_kind();
        Ok(json!({
            "bytes": bytes.len(),
            "dataBase64": STANDARD.encode(&bytes),
            "text": String::from_utf8_lossy(&bytes),
            "remainingBytes": remaining_bytes,
            "promptDetected": prompt_kind.is_some(),
            "promptKind": prompt_kind
        }))
    }

    /// Peek at retained output even after terminal_read has consumed the live queue.
    /// Nonnegative offsets are absolute stream byte positions; negative offsets
    /// count back from the end. Eviction is explicitly reported to the caller.
    pub fn read_page(
        &self,
        id: &str,
        offset_bytes: Option<i64>,
        max_bytes: Option<usize>,
        scope: &str,
    ) -> Result<Value> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?
            .get(id)
            .cloned();
        if let Some(session) = session {
            if session.owner_scope != scope {
                return Err(anyhow!("terminal session not found"));
            }
            let history = session
                .history
                .lock()
                .map_err(|_| anyhow!("terminal history lock poisoned"))?;
            return Ok(history.page(offset_bytes, max_bytes));
        }
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| anyhow!("terminal session not found"))?;
        let (total_bytes, bytes) = store.scoped(scope)?.load(id)?;
        let history = OutputHistory {
            bytes,
            total_bytes,
            durable: true,
        };
        let mut page = history.page(offset_bytes, max_bytes);
        page["archived"] = json!(true);
        page["running"] = json!(false);
        Ok(page)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16, scope: &str) -> Result<Value> {
        let session = self.get(id, scope)?;
        session
            .master
            .lock()
            .map_err(|_| anyhow!("terminal master lock poisoned"))?
            .resize(PtySize {
                rows: rows.clamp(5, 300),
                cols: cols.clamp(10, 500),
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(json!({ "ok": true }))
    }

    pub fn stop(&self, id: &str, scope: &str) -> Result<Value> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?;
        if sessions
            .get(id)
            .is_none_or(|session| session.owner_scope != scope)
        {
            return Err(anyhow!("terminal session not found"));
        }
        // Keep the session registered until termination succeeds. Removing it
        // first can strand a live child if the child lock or kill fails.
        let session = sessions
            .get(id)
            .ok_or_else(|| anyhow!("terminal session not found"))?;
        {
            let mut child = session
                .child
                .lock()
                .map_err(|_| anyhow!("terminal child lock poisoned"))?;
            // Terminate and wait for the entire Windows Job before returning.
            // Closing the handle only when the final Arc<Session> drops could
            // otherwise acknowledge stop while a concurrent reader still
            // holds the session and its descendants remain alive.
            #[cfg(windows)]
            session._windows_job.terminate()?;
            if child.try_wait()?.is_none() {
                // On Unix, a PTY shell normally leads its own process group.
                // Terminating only the direct shell can leave its foreground
                // descendants alive after the session has been unregistered.
                // Signal the group ONLY if the still-live child is its leader:
                // never send a negative-PID signal to an unrelated group.
                #[cfg(unix)]
                let signaled_group = child.process_id().is_some_and(|id| {
                    let Ok(pid) = i32::try_from(id) else {
                        return false;
                    };
                    pid > 1
                        && unsafe { libc::getpgid(pid) } == pid
                        && unsafe { libc::kill(-pid, libc::SIGKILL) } == 0
                });
                #[cfg(not(unix))]
                let signaled_group = false;

                if !signaled_group {
                    if let Err(error) = child.kill() {
                        // The process may have exited between try_wait and kill.
                        // Retain the session on a genuine termination failure.
                        if child.try_wait()?.is_none() {
                            return Err(error.into());
                        }
                    }
                }
                // kill() or the group signal can return before the child is reaped.
                // Do not unregister a still-live child; bound the wait so a
                // stuck OS process cannot indefinitely block the session map.
                let mut exited = child.try_wait()?.is_some();
                for _ in 0..100 {
                    if exited {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    exited = child.try_wait()?.is_some();
                }
                if !exited {
                    return Err(anyhow!(
                        "terminal child did not exit after kill; session retained"
                    ));
                }
            }
        }
        sessions.remove(id);
        Ok(json!({ "ok": true }))
    }

    fn get(&self, id: &str, scope: &str) -> Result<Arc<Session>> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("terminal session not found"))?;
        if session.owner_scope != scope {
            return Err(anyhow!("terminal session not found"));
        }
        Ok(session)
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_owned())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_terminal_stop_kills_owned_ping_descendant() {
        use base64::Engine as _;
        use std::time::{Duration, Instant};
        use sysinfo::{Pid, ProcessesToUpdate, System};

        let root = std::env::temp_dir().join(format!("wc-pty-job-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let manager = TerminalManager::default();
        let session = manager
            .start(&policy, Some("cmd.exe"), None, 80, 24, "windows-job-test")
            .expect("start Windows PTY with mandatory job attachment");
        let id = session["sessionId"].as_str().unwrap();
        let items = manager.list("windows-job-test").unwrap();
        let root_pid = items["items"][0]["pid"].as_u64().unwrap() as u32;
        manager
            .input(id, &STANDARD.encode(b"ping -n 30 127.0.0.1\r\n"), "windows-job-test")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        let descendant = loop {
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            let found = system.processes().iter().find_map(|(pid, process)| {
                (process.parent() == Some(Pid::from_u32(root_pid))
                    && process.name().to_string_lossy().eq_ignore_ascii_case("ping.exe"))
                .then_some((*pid, process.start_time()))
            });
            if found.is_some() || Instant::now() >= deadline {
                break found;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if descendant.is_none() {
            let _ = manager.stop(id, "windows-job-test");
        }
        let (ping_pid, started) = descendant.expect("PTY command must spawn real ping descendant");
        manager.stop(id, "windows-job-test").expect("stop owned PTY");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            if system
                .process(ping_pid)
                .is_none_or(|process| process.start_time() != started)
            {
                break;
            }
            assert!(Instant::now() < deadline, "owned PTY descendant survived stop");
            std::thread::sleep(Duration::from_millis(25));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pty_master_handles_are_available_before_child_spawn() {
        // This ordering is essential: after spawn there must be no fallible
        // PTY reader/writer acquisition that could strand an untracked child.
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let _reader = pair.master.try_clone_reader().unwrap();
        let _writer = pair.master.take_writer().unwrap();
        // No shell was started and no terminal history was allocated.
    }

    #[test]
    fn concurrent_start_reservations_enforce_quota_and_release_on_drop() {
        use std::{sync::Barrier, thread};
        let manager = TerminalManager::default();
        let contenders = MAX_SESSIONS + 8;
        let begin = Arc::new(Barrier::new(contenders));
        let release = Arc::new(Barrier::new(contenders));
        let accepted = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..contenders {
            let manager = manager.clone();
            let begin = Arc::clone(&begin);
            let release = Arc::clone(&release);
            let accepted = Arc::clone(&accepted);
            threads.push(thread::spawn(move || {
                begin.wait();
                let reservation = manager.reserve_start();
                if reservation.is_ok() {
                    accepted.fetch_add(1, Ordering::SeqCst);
                }
                // Hold every successful reservation until all contenders
                // have attempted to reserve, making the race deterministic.
                release.wait();
                drop(reservation);
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(accepted.load(Ordering::SeqCst), MAX_SESSIONS);
        assert_eq!(manager.pending_starts.load(Ordering::SeqCst), 0);
        let after_failure = manager.reserve_start().unwrap();
        assert_eq!(manager.pending_starts.load(Ordering::SeqCst), 1);
        drop(after_failure);
        assert_eq!(manager.pending_starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn terminal_input_base64_preflight_and_decoded_boundary() {
        let at_limit = STANDARD.encode(vec![b'x'; MAX_TERMINAL_INPUT_BYTES]);
        assert_eq!(at_limit.len(), MAX_TERMINAL_INPUT_BASE64_BYTES);
        assert_eq!(
            decode_terminal_input(&at_limit).unwrap().len(),
            MAX_TERMINAL_INPUT_BYTES
        );

        // 256 KiB + 1 byte has the SAME padded base64 length as 256 KiB.
        // The decoded-size guard must remain in place.
        let one_byte_over = STANDARD.encode(vec![b'x'; MAX_TERMINAL_INPUT_BYTES + 1]);
        assert_eq!(one_byte_over.len(), MAX_TERMINAL_INPUT_BASE64_BYTES);
        assert!(decode_terminal_input(&one_byte_over)
            .unwrap_err()
            .to_string()
            .contains("terminal input too large"));

        // This rejection happens before base64 decoding/allocation.
        let encoded_over = "A".repeat(MAX_TERMINAL_INPUT_BASE64_BYTES + 4);
        assert!(decode_terminal_input(&encoded_over)
            .unwrap_err()
            .to_string()
            .contains("terminal input too large"));
        assert!(decode_terminal_input("%%%")
            .unwrap_err()
            .to_string()
            .contains("invalid base64 terminal input"));
    }

    #[test]
    fn prompt_classification_is_bounded_and_advisory() {
        let mut history = OutputHistory::default();
        history.push(b"Python 3.13\r\n>>> ");
        assert_eq!(history.prompt_kind(), Some("python"));
        assert_eq!(history.page(Some(0), Some(2))["promptKind"], "python");
        history.push(b"print(2)\r\n... ");
        assert_eq!(history.prompt_kind(), Some("python_continuation"));
        history.push(b"\r\n\x1b[32muser@host\x1b[0m$ ");
        assert_eq!(history.prompt_kind(), Some("shell"));
        history.push(b"\r\nPS C:\\\\Users\\\\Test> ");
        assert_eq!(history.prompt_kind(), Some("powershell"));
        history.push(b"\r\nnormal output");
        assert_eq!(history.prompt_kind(), None);
        assert_eq!(history.page(None, None)["promptDetected"], false);
        history.push(b"\r\n>>> ");
        assert_eq!(history.prompt_kind(), Some("python"));
        history.push(&vec![b'x'; BUFFER_CAP]);
        assert_eq!(history.prompt_kind(), None);
    }

    #[test]
    fn retained_history_uses_absolute_offsets_and_reports_eviction() {
        let mut history = OutputHistory::default();
        history.push(b"abcdef");
        let first = history.page(Some(0), Some(3));
        assert_eq!(first["text"], "abc");
        assert_eq!(first["nextOffsetBytes"], 3);
        assert_eq!(first["hasMore"], true);

        history.push(&vec![b'x'; BUFFER_CAP]);
        let expired = history.page(Some(0), Some(3));
        assert_eq!(expired["retainedStartBytes"], 6);
        assert_eq!(expired["offsetBytes"], 6);
        assert_eq!(expired["truncatedBeforeOffset"], true);
        assert_eq!(expired["text"], "xxx");
        let tail = history.page(Some(-4), Some(4));
        assert_eq!(tail["text"], "xxxx");
        assert_eq!(tail["nextOffsetBytes"], (BUFFER_CAP + 6) as u64);
        assert_eq!(tail["hasMore"], false);
    }
}
