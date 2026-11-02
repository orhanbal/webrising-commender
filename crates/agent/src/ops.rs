use crate::{
    approval,
    config::DeviceCapabilities,
    docx_ops, fs_ops, image_ops,
    policy::PathPolicy,
    process_ops,
    protocol::{AgentAction, Risk, UndoScope},
    spreadsheet_ops, system_ops,
    task_manager::TaskManager,
    terminal::TerminalManager,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};
use tokio::sync::mpsc;

pub struct ExecutionContext<'a> {
    pub policy: &'a PathPolicy,
    pub terminals: &'a TerminalManager,
    pub tasks: &'a TaskManager,
    pub approval_token: Option<&'a str>,
    pub approval_key: &'a str,
    pub device_id: &'a str,
    pub undo_scope: Option<&'a UndoScope>,
    pub cancelled: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    pub search_progress: Option<mpsc::Sender<Value>>,
    pub capabilities: DeviceCapabilities,
}

/// Device-local capability check. Runs before approval verification so a
/// disabled capability is refused even with a valid human approval.
pub fn enforce_capabilities(capabilities: DeviceCapabilities, action: &AgentAction) -> Result<()> {
    let needs_commands = matches!(
        action,
        AgentAction::ProcessExec { .. }
            | AgentAction::ProcessKill { .. }
            | AgentAction::TaskStart { .. }
            | AgentAction::TerminalStart { .. }
            | AgentAction::TerminalInput { .. }
    );
    let needs_writes = matches!(
        action,
        AgentAction::FsWrite { .. }
            | AgentAction::FsAppend { .. }
            | AgentAction::FsMkdir { .. }
            | AgentAction::FsDelete { .. }
            | AgentAction::FsMove { .. }
            | AgentAction::FsReplace { .. }
            | AgentAction::FsUndo { .. }
            | AgentAction::XlsxWriteCells { .. }
    );
    if needs_commands && !capabilities.commands {
        return Err(anyhow!(
            "device_policy_denied: command execution is disabled on this device"
        ));
    }
    if needs_writes && !capabilities.file_writes {
        return Err(anyhow!(
            "device_policy_denied: file writes are disabled on this device"
        ));
    }
    Ok(())
}

pub async fn execute(context: ExecutionContext<'_>, action: AgentAction) -> Result<Value> {
    let ExecutionContext {
        policy,
        terminals,
        tasks,
        approval_token,
        approval_key,
        device_id,
        undo_scope,
        cancelled,
        paused,
        search_progress,
        capabilities,
    } = context;
    enforce_capabilities(capabilities, &action)?;
    if action.risk() == Risk::High {
        let token = approval_token
            .ok_or_else(|| anyhow!("approval token required for high-risk action"))?;
        approval::verify(token, approval_key, device_id, &action)?;
    }

    // Only the authenticated Gateway sets this scope, never tool arguments.
    // Device identity is taken from the enrolled Agent configuration.
    let undo_key = undo_scope
        .map(|scope| {
            fs_ops::undo_scope_fingerprint(&scope.organization_id, &scope.actor, device_id)
        })
        .transpose()?;
    let require_undo_key = || {
        undo_key
            .as_deref()
            .ok_or_else(|| anyhow!("undo_scope_required"))
    };

    match action {
        AgentAction::SystemInfo => system_ops::info(),
        AgentAction::PolicyInfo => Ok(serde_json::json!({
            "allowedRoots": policy.roots().iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "agentMode": if !capabilities.commands && !capabilities.file_writes { "read_only" } else { "restricted" },
            "commandExecution": if capabilities.commands { "enabled" } else { "disabled" },
            "fileWrites": if capabilities.file_writes { "enabled" } else { "disabled" },
            "maximumSingleReadBytes": 4 * 1024 * 1024,
            "maximumSingleWriteBytes": 8 * 1024 * 1024,
            "maximumTerminalBufferedBytes": 1024 * 1024
        })),
        AgentAction::FsList { path } => fs_ops::list(policy, &path),
        AgentAction::FsStat { path } => fs_ops::stat(policy, &path),
        AgentAction::FsRead { path, max_bytes } => fs_ops::read(policy, &path, max_bytes),
        AgentAction::FsReadMultiple { paths, max_bytes } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || fs_ops::read_multiple(&policy, &paths, max_bytes))
                .await?
        }
        AgentAction::FsReadLines {
            path,
            offset_lines,
            limit_lines,
        } => fs_ops::read_lines(policy, &path, offset_lines, limit_lines),
        AgentAction::ImageInspect { path } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || image_ops::inspect(&policy, &path)).await?
        }
        AgentAction::DocxInspect { path } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || docx_ops::inspect(&policy, &path)).await?
        }
        AgentAction::DocxReadParagraphs {
            path,
            offset,
            limit,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                docx_ops::read_paragraphs(&policy, &path, offset.unwrap_or(0), limit.unwrap_or(50))
            })
            .await?
        }
        AgentAction::DocxReadTable {
            path,
            table_index,
            offset_rows,
            limit_rows,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                docx_ops::read_table(
                    &policy,
                    &path,
                    table_index,
                    offset_rows.unwrap_or(0),
                    limit_rows.unwrap_or(20),
                )
            })
            .await?
        }
        AgentAction::XlsxInspect { path } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || spreadsheet_ops::inspect(&policy, &path)).await?
        }
        AgentAction::XlsxReadRange {
            path,
            sheet,
            start_row,
            start_column,
            row_count,
            column_count,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                spreadsheet_ops::read_range(
                    &policy,
                    &path,
                    &sheet,
                    start_row,
                    start_column,
                    row_count,
                    column_count,
                )
            })
            .await?
        }
        AgentAction::XlsxFind {
            path,
            sheet,
            query,
            case_sensitive,
            max_results,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                spreadsheet_ops::find_cells(
                    &policy,
                    &path,
                    sheet.as_deref(),
                    &query,
                    case_sensitive.unwrap_or(false),
                    max_results.unwrap_or(50),
                )
            })
            .await?
        }
        AgentAction::XlsxWriteCells {
            path,
            output_path,
            sheet,
            updates,
            expected_sha256,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                spreadsheet_ops::write_cells(
                    &policy,
                    &path,
                    &output_path,
                    &sheet,
                    &updates,
                    expected_sha256.as_deref(),
                )
            })
            .await?
        }
        AgentAction::FsWrite {
            path,
            content_base64,
            create_parents,
            expected_sha256,
            with_undo,
        } => {
            let with_undo = with_undo.unwrap_or(false);
            if with_undo {
                fs_ops::write_scoped(
                    policy,
                    &path,
                    &content_base64,
                    create_parents.unwrap_or(false),
                    expected_sha256.as_deref(),
                    true,
                    require_undo_key()?,
                )
            } else {
                fs_ops::write(
                    policy,
                    &path,
                    &content_base64,
                    create_parents.unwrap_or(false),
                    expected_sha256.as_deref(),
                    false,
                )
            }
        }
        AgentAction::FsAppend {
            path,
            content_base64,
            expected_sha256,
            with_undo,
        } => {
            let with_undo = with_undo.unwrap_or(false);
            if with_undo {
                fs_ops::append_scoped(
                    policy,
                    &path,
                    &content_base64,
                    expected_sha256.as_deref(),
                    true,
                    require_undo_key()?,
                )
            } else {
                fs_ops::append(
                    policy,
                    &path,
                    &content_base64,
                    expected_sha256.as_deref(),
                    false,
                )
            }
        }
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
            resume_checkpoint,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                if let Some(sender) = search_progress {
                    let report =
                        move |items: &[Value],
                              scanned: usize,
                              bytes: u64,
                              checkpoint: Option<&Value>| {
                            let _ = sender.try_send(json!({
                                "items": items,
                                "scannedEntries": scanned,
                                "scannedBytes": bytes,
                                "checkpoint": checkpoint,
                            }));
                        };
                    fs_ops::search_cancellable_controlled(
                        &policy,
                        &path,
                        &query,
                        case_sensitive.unwrap_or(false),
                        max_results,
                        (&cancelled, &paused, resume_checkpoint.as_ref()),
                        &report,
                    )
                } else {
                    if resume_checkpoint.is_some() {
                        return Err(anyhow!("invalid_search_checkpoint"));
                    }
                    fs_ops::search_cancellable(
                        &policy,
                        &path,
                        &query,
                        case_sensitive.unwrap_or(false),
                        max_results,
                        &cancelled,
                    )
                }
            })
            .await?
        }
        AgentAction::TextSearch {
            path,
            query,
            case_sensitive,
            max_results,
            resume_checkpoint,
        } => {
            let policy = policy.clone();
            tokio::task::spawn_blocking(move || {
                if let Some(sender) = search_progress {
                    let report =
                        move |items: &[Value],
                              scanned: usize,
                              bytes: u64,
                              checkpoint: Option<&Value>| {
                            let _ = sender.try_send(json!({
                                "items": items,
                                "scannedEntries": scanned,
                                "scannedBytes": bytes,
                                "checkpoint": checkpoint,
                            }));
                        };
                    fs_ops::text_search_cancellable_controlled(
                        &policy,
                        &path,
                        &query,
                        case_sensitive.unwrap_or(false),
                        max_results,
                        (&cancelled, &paused, resume_checkpoint.as_ref()),
                        &report,
                    )
                } else {
                    if resume_checkpoint.is_some() {
                        return Err(anyhow!("invalid_search_checkpoint"));
                    }
                    fs_ops::text_search_cancellable(
                        &policy,
                        &path,
                        &query,
                        case_sensitive.unwrap_or(false),
                        max_results,
                        &cancelled,
                    )
                }
            })
            .await?
        }
        AgentAction::FsReplace {
            path,
            search,
            replace,
            replace_all,
            expected_sha256,
        } => fs_ops::replace_text_scoped(
            policy,
            &path,
            &search,
            &replace,
            replace_all.unwrap_or(false),
            expected_sha256.as_deref(),
            require_undo_key()?,
        ),
        AgentAction::FsVersions { path } => {
            fs_ops::versions_scoped(policy, &path, require_undo_key()?)
        }
        AgentAction::FsUndo {
            path,
            undo_id,
            expected_sha256,
        } => fs_ops::undo_scoped(
            policy,
            &path,
            &undo_id,
            &expected_sha256,
            require_undo_key()?,
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
            require_undo_key()?,
        ),
        AgentAction::TerminalInput {
            session_id,
            data_base64,
        } => terminals.input(&session_id, &data_base64, require_undo_key()?),
        AgentAction::TerminalRead {
            session_id,
            max_bytes,
        } => terminals.read(
            &session_id,
            max_bytes.unwrap_or(64 * 1024),
            require_undo_key()?,
        ),
        AgentAction::TerminalReadPage {
            session_id,
            offset_bytes,
            max_bytes,
        } => terminals.read_page(&session_id, offset_bytes, max_bytes, require_undo_key()?),
        AgentAction::TerminalResize {
            session_id,
            cols,
            rows,
        } => terminals.resize(&session_id, cols, rows, require_undo_key()?),
        AgentAction::TerminalStop { session_id } => {
            terminals.stop(&session_id, require_undo_key()?)
        }
        AgentAction::TerminalList => terminals.list(require_undo_key()?),
    }
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    use crate::config::DeviceCapabilities;

    fn action(value: Value) -> AgentAction {
        serde_json::from_value(value).unwrap()
    }

    fn commands() -> Vec<AgentAction> {
        vec![
            action(json!({"kind": "process_exec", "command": "id"})),
            action(json!({"kind": "process_kill", "pid": 1})),
            action(json!({"kind": "task_start", "command": "sleep 1"})),
            action(json!({"kind": "terminal_start"})),
            action(json!({"kind": "terminal_input", "sessionId": "s", "dataBase64": "aWQK"})),
        ]
    }

    fn writes() -> Vec<AgentAction> {
        vec![
            action(json!({"kind": "fs_write", "path": "/x", "contentBase64": ""})),
            action(json!({"kind": "fs_append", "path": "/x", "contentBase64": ""})),
            action(json!({"kind": "fs_mkdir", "path": "/x"})),
            action(json!({"kind": "fs_delete", "path": "/x"})),
            action(json!({"kind": "fs_move", "source": "/x", "destination": "/y"})),
            action(json!({"kind": "fs_replace", "path": "/x", "search": "a", "replace": "b"})),
            action(json!({"kind": "fs_undo", "path": "/x", "undoId": "u", "expectedSha256": "0"})),
            action(
                json!({"kind": "xlsx_write_cells", "path": "/x.xlsx", "outputPath": "/y.xlsx", "sheet": "S", "updates": []}),
            ),
        ]
    }

    fn reads() -> Vec<AgentAction> {
        vec![
            action(json!({"kind": "system_info"})),
            action(json!({"kind": "policy_info"})),
            action(json!({"kind": "fs_read", "path": "/x"})),
            action(json!({"kind": "fs_list", "path": "/x"})),
            action(json!({"kind": "task_status", "taskId": "t"})),
            action(json!({"kind": "task_cancel", "taskId": "t"})),
            action(json!({"kind": "terminal_stop", "sessionId": "s"})),
            action(json!({"kind": "process_list"})),
        ]
    }

    #[test]
    fn default_capabilities_allow_everything() {
        let all = DeviceCapabilities::default();
        for a in commands()
            .iter()
            .chain(writes().iter())
            .chain(reads().iter())
        {
            enforce_capabilities(all, a).unwrap();
        }
    }

    #[test]
    fn disabled_commands_refuse_every_execution_path_only() {
        let caps = DeviceCapabilities {
            commands: false,
            file_writes: true,
        };
        for a in commands() {
            let error = enforce_capabilities(caps, &a).unwrap_err().to_string();
            assert!(
                error.contains("command execution is disabled"),
                "{}: {error}",
                a.kind_name()
            );
        }
        for a in writes().iter().chain(reads().iter()) {
            enforce_capabilities(caps, a).unwrap();
        }
    }

    #[test]
    fn read_only_refuses_every_write_path_only() {
        let caps = DeviceCapabilities {
            commands: true,
            file_writes: false,
        };
        for a in writes() {
            let error = enforce_capabilities(caps, &a).unwrap_err().to_string();
            assert!(
                error.contains("file writes are disabled"),
                "{}: {error}",
                a.kind_name()
            );
        }
        for a in commands().iter().chain(reads().iter()) {
            enforce_capabilities(caps, a).unwrap();
        }
    }

    #[test]
    fn every_medium_or_high_risk_mutation_is_classified() {
        // Any new mutating action must be added to a capability class.
        let caps = DeviceCapabilities {
            commands: false,
            file_writes: false,
        };
        let allowed_anyway = ["task_cancel", "terminal_stop", "terminal_resize"];
        for a in commands().iter().chain(writes().iter()) {
            assert!(enforce_capabilities(caps, a).is_err());
        }
        for a in reads() {
            if a.risk() != Risk::Low {
                assert!(allowed_anyway.contains(&a.kind_name()), "{}", a.kind_name());
            }
        }
    }
}
