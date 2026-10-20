use crate::{
    fs_ops,
    policy::PathPolicy,
    process_ops,
    protocol::{AgentAction, Risk},
    system_ops,
    terminal::TerminalManager,
};
use anyhow::{anyhow, Result};
use serde_json::Value;

pub async fn execute(
    policy: &PathPolicy,
    terminals: &TerminalManager,
    action: AgentAction,
    approval_token: Option<&str>,
) -> Result<Value> {
    if action.risk() == Risk::High && approval_token.is_none() {
        return Err(anyhow!("approval token required for high-risk action"));
    }

    match action {
        AgentAction::SystemInfo => system_ops::info(),
        AgentAction::FsList { path } => fs_ops::list(policy, &path),
        AgentAction::FsStat { path } => fs_ops::stat(policy, &path),
        AgentAction::FsRead { path, max_bytes } => fs_ops::read(policy, &path, max_bytes),
        AgentAction::FsWrite {
            path,
            content_base64,
            create_parents,
        } => fs_ops::write(
            policy,
            &path,
            &content_base64,
            create_parents.unwrap_or(false),
        ),
        AgentAction::FsMkdir { path, recursive } => {
            fs_ops::mkdir(policy, &path, recursive.unwrap_or(false))
        }
        AgentAction::FsDelete { path, recursive } => {
            fs_ops::delete(policy, &path, recursive.unwrap_or(false))
        }
        AgentAction::ProcessExec {
            command,
            cwd,
            timeout_ms,
        } => process_ops::exec(policy, &command, cwd.as_deref(), timeout_ms).await,
        AgentAction::ProcessList => process_ops::list(),
        AgentAction::ProcessKill { pid } => process_ops::kill(pid),
        AgentAction::TerminalStart {
            shell,
            cwd,
            cols,
            rows,
        } => terminals.start(
            policy,
            shell.as_deref(),
            cwd.as_deref(),
            cols.unwrap_or(120),
            rows.unwrap_or(30),
        ),
        AgentAction::TerminalInput {
            session_id,
            data_base64,
        } => terminals.input(&session_id, &data_base64),
        AgentAction::TerminalRead {
            session_id,
            max_bytes,
        } => terminals.read(&session_id, max_bytes.unwrap_or(64 * 1024)),
        AgentAction::TerminalResize {
            session_id,
            cols,
            rows,
        } => terminals.resize(&session_id, cols, rows),
        AgentAction::TerminalStop { session_id } => terminals.stop(&session_id),
    }
}
