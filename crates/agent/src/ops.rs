use crate::{
    approval, fs_ops,
    policy::PathPolicy,
    process_ops,
    protocol::{AgentAction, Risk},
    system_ops,
    task_manager::TaskManager,
    terminal::TerminalManager,
};
use anyhow::{anyhow, Result};
use serde_json::Value;

pub async fn execute(
    policy: &PathPolicy,
    terminals: &TerminalManager,
    tasks: &TaskManager,
    action: AgentAction,
    approval_token: Option<&str>,
    approval_key: &str,
    device_id: &str,
) -> Result<Value> {
    if action.risk() == Risk::High {
        let token = approval_token
            .ok_or_else(|| anyhow!("approval token required for high-risk action"))?;
        approval::verify(token, approval_key, device_id, &action)?;
    }

    match action {
        AgentAction::SystemInfo => system_ops::info(),
        AgentAction::PolicyInfo => Ok(serde_json::json!({
            "allowedRoots": policy.roots().iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "agentMode": "restricted",
            "maximumSingleReadBytes": 4 * 1024 * 1024,
            "maximumSingleWriteBytes": 8 * 1024 * 1024,
            "maximumTerminalBufferedBytes": 1024 * 1024
        })),
        AgentAction::FsList { path } => fs_ops::list(policy, &path),
        AgentAction::FsStat { path } => fs_ops::stat(policy, &path),
        AgentAction::FsRead { path, max_bytes } => fs_ops::read(policy, &path, max_bytes),
        AgentAction::FsReadLines {
            path,
            offset_lines,
            limit_lines,
        } => fs_ops::read_lines(policy, &path, offset_lines, limit_lines),
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
        AgentAction::FsAppend {
            path,
            content_base64,
        } => fs_ops::append(policy, &path, &content_base64),
        AgentAction::FsMkdir { path, recursive } => {
            fs_ops::mkdir(policy, &path, recursive.unwrap_or(false))
        }
        AgentAction::FsDelete { path, recursive } => {
            fs_ops::delete(policy, &path, recursive.unwrap_or(false))
        }
        AgentAction::FsMove {
            source,
            destination,
        } => fs_ops::move_path(policy, &source, &destination),
        AgentAction::FsTree {
            path,
            max_depth,
            max_entries,
        } => fs_ops::tree(policy, &path, max_depth, max_entries),
        AgentAction::FsSearch {
            path,
            query,
            case_sensitive,
            max_results,
        } => fs_ops::search(policy, &path, &query, case_sensitive.unwrap_or(false), max_results),
        AgentAction::TextSearch {
            path,
            query,
            case_sensitive,
            max_results,
        } => fs_ops::text_search(
            policy,
            &path,
            &query,
            case_sensitive.unwrap_or(false),
            max_results,
        ),
        AgentAction::FsReplace {
            path,
            search,
            replace,
            replace_all,
            expected_sha256,
        } => fs_ops::replace_text(
            policy,
            &path,
            &search,
            &replace,
            replace_all.unwrap_or(false),
            expected_sha256.as_deref(),
        ),
        AgentAction::ProcessExec {
            command,
            cwd,
            timeout_ms,
        } => process_ops::exec(policy, &command, cwd.as_deref(), timeout_ms).await,
        AgentAction::ProcessList => process_ops::list(),
        AgentAction::ProcessKill { pid } => process_ops::kill(pid),
        AgentAction::TaskStart {
            command,
            cwd,
            timeout_ms,
        } => tasks.start(policy.clone(), command, cwd, timeout_ms).await,
        AgentAction::TaskStatus { task_id } => tasks.status(&task_id).await,
        AgentAction::TaskCancel { task_id } => tasks.cancel(&task_id).await,
        AgentAction::TaskList => tasks.list().await,
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
        AgentAction::TerminalReadPage {
            session_id,
            offset_bytes,
            max_bytes,
        } => terminals.read_page(&session_id, offset_bytes, max_bytes),
        AgentAction::TerminalResize {
            session_id,
            cols,
            rows,
        } => terminals.resize(&session_id, cols, rows),
        AgentAction::TerminalStop { session_id } => terminals.stop(&session_id),
        AgentAction::TerminalList => terminals.list(),
    }
}
