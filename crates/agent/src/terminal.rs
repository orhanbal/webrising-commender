use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

const BUFFER_CAP: usize = 1024 * 1024;
const MAX_SESSIONS: usize = 32;

// A bounded, non-consuming history independent of the destructive PTY read queue.
// Offsets refer to the absolute byte position in the session's output stream.
#[derive(Default)]
struct OutputHistory {
    bytes: VecDeque<u8>,
    total_bytes: u64,
}

impl OutputHistory {
    fn push(&mut self, chunk: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.len() as u64);
        self.bytes.extend(chunk.iter().copied());
        let excess = self.bytes.len().saturating_sub(BUFFER_CAP);
        self.bytes.drain(..excess);
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
            "hasMore": end < self.total_bytes
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
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    pending_starts: Arc<AtomicUsize>,
}

impl TerminalManager {
    pub fn start(
        &self,
        policy: &PathPolicy,
        shell: Option<&str>,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<Value> {
        let reservation = self.reserve_start()?;

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

        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let buffer = Arc::new(Mutex::new(VecDeque::new()));
        let read_buffer = Arc::clone(&buffer);
        let history = Arc::new(Mutex::new(OutputHistory::default()));
        let read_history = Arc::clone(&history);

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

        let id = Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            buffer,
            history,
        });

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?;
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

    pub fn list(&self) -> Result<Value> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?;
        let mut items = Vec::with_capacity(sessions.len());

        for (id, session) in sessions.iter() {
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

    pub fn input(&self, id: &str, data_base64: &str) -> Result<Value> {
        let session = self.get(id)?;
        let data = STANDARD
            .decode(data_base64)
            .context("invalid base64 terminal input")?;
        if data.len() > 256 * 1024 {
            return Err(anyhow!("terminal input too large"));
        }
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| anyhow!("terminal writer lock poisoned"))?;
        writer.write_all(&data)?;
        writer.flush()?;
        Ok(json!({ "ok": true, "bytes": data.len() }))
    }

    pub fn read(&self, id: &str, max_bytes: usize) -> Result<Value> {
        let session = self.get(id)?;
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

        Ok(json!({
            "bytes": bytes.len(),
            "dataBase64": STANDARD.encode(&bytes),
            "text": String::from_utf8_lossy(&bytes),
            "remainingBytes": queue.len()
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
    ) -> Result<Value> {
        let session = self.get(id)?;
        let history = session
            .history
            .lock()
            .map_err(|_| anyhow!("terminal history lock poisoned"))?;
        Ok(history.page(offset_bytes, max_bytes))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<Value> {
        let session = self.get(id)?;
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

    pub fn stop(&self, id: &str) -> Result<Value> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?
            .remove(id)
            .ok_or_else(|| anyhow!("terminal session not found"))?;

        let mut child = session
            .child
            .lock()
            .map_err(|_| anyhow!("terminal child lock poisoned"))?;
        child.kill()?;

        Ok(json!({ "ok": true }))
    }

    fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("terminal session not found"))
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
