use crate::{
    approval, docx_ops, fs_ops, image_ops,
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
    } = context;
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
            "agentMode": "restricted",
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
        } => terminals.read(&session_id, max_bytes.unwrap_or(64 * 1024), require_undo_key()?),
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
        },
        AgentAction::TerminalList => terminals.list(require_undo_key()?),
    }
}
