use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GatewayMessage {
    Request {
        request_id: String,
        action: AgentAction,
        approval_token: Option<String>,
    },
    Cancel {
        request_id: String,
    },
    Ping {
        #[serde(rename = "timestamp")]
        _timestamp: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentAction {
    SystemInfo,
    FsList {
        path: String,
    },
    FsStat {
        path: String,
    },
    FsRead {
        path: String,
        max_bytes: Option<usize>,
    },
    FsReadLines {
        path: String,
        offset_lines: Option<i64>,
        limit_lines: Option<usize>,
    },
    FsWrite {
        path: String,
        content_base64: String,
        create_parents: Option<bool>,
    },
    FsAppend {
        path: String,
        content_base64: String,
    },
    FsMkdir {
        path: String,
        recursive: Option<bool>,
    },
    FsDelete {
        path: String,
        recursive: Option<bool>,
    },
    FsMove {
        source: String,
        destination: String,
    },
    FsTree {
        path: String,
        max_depth: Option<usize>,
        max_entries: Option<usize>,
    },
    FsSearch {
        path: String,
        query: String,
        max_results: Option<usize>,
    },
    TextSearch {
        path: String,
        query: String,
        case_sensitive: Option<bool>,
        max_results: Option<usize>,
    },
    FsReplace {
        path: String,
        search: String,
        replace: String,
        replace_all: Option<bool>,
        expected_sha256: Option<String>,
    },
    ProcessExec {
        command: String,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    },
    ProcessList,
    ProcessKill {
        pid: u32,
    },
    TaskStart {
        command: String,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    },
    TaskStatus {
        task_id: String,
    },
    TaskCancel {
        task_id: String,
    },
    TaskList,
    TerminalStart {
        shell: Option<String>,
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    },
    TerminalInput {
        session_id: String,
        data_base64: String,
    },
    TerminalRead {
        session_id: String,
        max_bytes: Option<usize>,
    },
    TerminalReadPage {
        session_id: String,
        offset_bytes: Option<i64>,
        max_bytes: Option<usize>,
    },
    TerminalResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    TerminalStop {
        session_id: String,
    },
    TerminalList,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentMessage {
    Hello {
        device_id: String,
        hostname: String,
        os: String,
        version: String,
        capabilities: Vec<String>,
    },
    Heartbeat {
        timestamp: String,
    },
    Result {
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<AgentError>,
    },
}

#[derive(Debug, Serialize)]
pub struct AgentError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Low,
    Medium,
    High,
}

impl AgentAction {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::SystemInfo => "system_info",
            Self::FsList { .. } => "fs_list",
            Self::FsStat { .. } => "fs_stat",
            Self::FsRead { .. } => "fs_read",
            Self::FsReadLines { .. } => "fs_read_lines",
            Self::FsWrite { .. } => "fs_write",
            Self::FsAppend { .. } => "fs_append",
            Self::FsMkdir { .. } => "fs_mkdir",
            Self::FsDelete { .. } => "fs_delete",
            Self::FsMove { .. } => "fs_move",
            Self::FsTree { .. } => "fs_tree",
            Self::FsSearch { .. } => "fs_search",
            Self::TextSearch { .. } => "text_search",
            Self::FsReplace { .. } => "fs_replace",
            Self::ProcessExec { .. } => "process_exec",
            Self::ProcessList => "process_list",
            Self::ProcessKill { .. } => "process_kill",
            Self::TaskStart { .. } => "task_start",
            Self::TaskStatus { .. } => "task_status",
            Self::TaskCancel { .. } => "task_cancel",
            Self::TaskList => "task_list",
            Self::TerminalStart { .. } => "terminal_start",
            Self::TerminalInput { .. } => "terminal_input",
            Self::TerminalRead { .. } => "terminal_read",
            Self::TerminalReadPage { .. } => "terminal_read_page",
            Self::TerminalResize { .. } => "terminal_resize",
            Self::TerminalStop { .. } => "terminal_stop",
            Self::TerminalList => "terminal_list",
        }
    }

    pub fn risk(&self) -> Risk {
        match self {
            Self::SystemInfo
            | Self::FsList { .. }
            | Self::FsStat { .. }
            | Self::FsRead { .. }
            | Self::FsReadLines { .. }
            | Self::FsTree { .. }
            | Self::FsSearch { .. }
            | Self::TextSearch { .. }
            | Self::ProcessList
            | Self::TaskStatus { .. }
            | Self::TaskList
            | Self::TerminalRead { .. }
            | Self::TerminalReadPage { .. }
            | Self::TerminalList => Risk::Low,

            Self::FsWrite { .. }
            | Self::FsAppend { .. }
            | Self::FsMkdir { .. }
            | Self::FsMove { .. }
            | Self::FsReplace { .. }
            | Self::TerminalInput { .. }
            | Self::TerminalResize { .. } => Risk::Medium,

            Self::FsDelete { .. }
            | Self::ProcessExec { .. }
            | Self::ProcessKill { .. }
            | Self::TaskStart { .. }
            | Self::TaskCancel { .. }
            | Self::TerminalStart { .. }
            | Self::TerminalStop { .. } => Risk::High,
        }
    }
}
