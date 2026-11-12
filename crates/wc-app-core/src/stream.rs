//! Terminals that are not SSH sessions (Telnet, serial ports, Mosh): a task
//! owns the connection; the app talks to it through a channel, and its
//! output reaches the app as the same terminal events SSH terminals send.

use base64::Engine;
use std::sync::Arc;
use tokio::sync::mpsc;
use wc_ssh_core::client::ShellWriter;

use crate::{AppState, TerminalExit, TerminalOutput};

/// What the app sends to a stream terminal.
pub enum StreamCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// The app's handle on a stream terminal.
pub struct StreamWriter {
    tx: mpsc::UnboundedSender<StreamCmd>,
}

impl StreamWriter {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<StreamCmd>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    fn send(&self, cmd: StreamCmd) -> Result<(), String> {
        self.tx.send(cmd).map_err(|_| "terminal closed".to_string())
    }
}

/// How the app writes to a terminal, whatever its protocol.
pub enum TermWriter {
    Ssh(Arc<ShellWriter>),
    Stream(Arc<StreamWriter>),
}

impl Clone for TermWriter {
    fn clone(&self) -> Self {
        match self {
            Self::Ssh(w) => Self::Ssh(w.clone()),
            Self::Stream(w) => Self::Stream(w.clone()),
        }
    }
}

impl TermWriter {
    pub async fn write(&self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Ssh(w) => w.write(bytes).await.map_err(|e| e.to_string()),
            Self::Stream(w) => w.send(StreamCmd::Data(bytes.to_vec())),
        }
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        match self {
            Self::Ssh(w) => w.resize(cols, rows).await.map_err(|e| e.to_string()),
            Self::Stream(w) => w.send(StreamCmd::Resize(cols, rows)),
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        match self {
            Self::Ssh(w) => w.close().await.map_err(|e| e.to_string()),
            Self::Stream(w) => w.send(StreamCmd::Close),
        }
    }
}

/// Sends a stream terminal's output and its end to the app.
#[derive(Clone)]
pub struct StreamEvents {
    pub(crate) state: Arc<AppState>,
    pub(crate) session_id: String,
}

impl StreamEvents {
    pub fn output(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.state.emit(
            "terminal-output",
            TerminalOutput {
                session_id: self.session_id.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        );
    }

    /// The connection ended; the terminal is removed from the app's list.
    pub fn exit(&self, code: Option<u32>) {
        self.state.emit(
            "terminal-exit",
            TerminalExit {
                session_id: self.session_id.clone(),
                code,
            },
        );
        if let Ok(mut terminals) = self.state.terminals.lock() {
            terminals.remove(&self.session_id);
        }
    }
}
