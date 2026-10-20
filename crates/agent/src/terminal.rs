use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const BUFFER_CAP: usize = 1024 * 1024;

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    buffer: Arc<Mutex<VecDeque<u8>>>,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
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

        std::thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
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
        });

        self.sessions
            .lock()
            .map_err(|_| anyhow!("terminal session lock poisoned"))?
            .insert(id.clone(), session);

        Ok(json!({ "sessionId": id }))
    }

    pub fn input(&self, id: &str, data_base64: &str) -> Result<Value> {
        let session = self.get(id)?;
        let data = STANDARD.decode(data_base64).context("invalid base64 terminal input")?;
        if data.len() > 256 * 1024 {
            return Err(anyhow!("terminal input too large"));
        }
        let mut writer = session.writer.lock().map_err(|_| anyhow!("terminal writer lock poisoned"))?;
        writer.write_all(&data)?;
        writer.flush()?;
        Ok(json!({ "ok": true, "bytes": data.len() }))
    }

    pub fn read(&self, id: &str, max_bytes: usize) -> Result<Value> {
        let session = self.get(id)?;
        let max = max_bytes.clamp(1, 256 * 1024);
        let mut queue = session.buffer.lock().map_err(|_| anyhow!("terminal buffer lock poisoned"))?;
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
