use crate::{policy::PathPolicy, process_ops};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_RETAINED_TASKS: usize = 100;
const MAX_RUNNING_TASKS: usize = 16;

struct TaskEntry {
    status: &'static str,
    created_at_ms: u128,
    finished_at_ms: Option<u128>,
    result: Option<Value>,
    error: Option<String>,
    abort: Option<tokio::task::AbortHandle>,
}

#[derive(Clone, Default)]
pub struct TaskManager {
    tasks: std::sync::Arc<Mutex<HashMap<String, TaskEntry>>>,
}

impl TaskManager {
    pub async fn start(
        &self,
        policy: PathPolicy,
        command: String,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        if command.trim().is_empty() {
            return Err(anyhow!("command cannot be empty"));
        }

        self.prune().await;

        {
            let tasks = self.tasks.lock().await;
            let running = tasks
                .values()
                .filter(|entry| entry.status == "running")
                .count();
            if running >= MAX_RUNNING_TASKS {
                return Err(anyhow!(
                    "too many running tasks; limit is {MAX_RUNNING_TASKS}"
                ));
            }
        }

        let task_id = Uuid::new_v4().to_string();
        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(
                task_id.clone(),
                TaskEntry {
                    status: "running",
                    created_at_ms: now_ms(),
                    finished_at_ms: None,
                    result: None,
                    error: None,
                    abort: None,
                },
            );
        }

        let tasks = std::sync::Arc::clone(&self.tasks);
        let id_for_job = task_id.clone();
        let job = tokio::spawn(async move {
            let outcome =
                process_ops::exec_task(&policy, &command, cwd.as_deref(), timeout_ms).await;

            let mut map = tasks.lock().await;
            let Some(entry) = map.get_mut(&id_for_job) else {
                return;
            };
            if entry.status == "canceled" {
                return;
            }

            entry.finished_at_ms = Some(now_ms());
            entry.abort = None;
            match outcome {
                Ok(result) => {
                    entry.status = "completed";
                    entry.result = Some(result);
                    entry.error = None;
                }
                Err(error) => {
                    entry.status = "failed";
                    entry.result = None;
                    entry.error = Some(error.to_string());
                }
            }
        });

        {
            let mut tasks = self.tasks.lock().await;
            if let Some(entry) = tasks.get_mut(&task_id) {
                if entry.status == "running" {
                    entry.abort = Some(job.abort_handle());
                }
            }
        }

        Ok(json!({ "taskId": task_id, "status": "running" }))
    }

    pub async fn list(&self) -> Result<Value> {
        let tasks = self.tasks.lock().await;
        let mut items: Vec<Value> = tasks
            .iter()
            .map(|(task_id, entry)| {
                json!({
                    "taskId": task_id,
                    "status": entry.status,
                    "createdAtMs": entry.created_at_ms.to_string(),
                    "finishedAtMs": entry.finished_at_ms.map(|value| value.to_string())
                })
            })
            .collect();
        items.sort_by(|left, right| {
            right["createdAtMs"]
                .as_str()
                .cmp(&left["createdAtMs"].as_str())
        });
        Ok(json!({ "items": items }))
    }

    pub async fn status(&self, task_id: &str) -> Result<Value> {
        let tasks = self.tasks.lock().await;
        let entry = tasks
            .get(task_id)
            .ok_or_else(|| anyhow!("task not found"))?;

        Ok(json!({
            "taskId": task_id,
            "status": entry.status,
            "createdAtMs": entry.created_at_ms.to_string(),
            "finishedAtMs": entry.finished_at_ms.map(|value| value.to_string()),
            "result": entry.result,
            "error": entry.error,
        }))
    }

    pub async fn cancel(&self, task_id: &str) -> Result<Value> {
        let abort = {
            let mut tasks = self.tasks.lock().await;
            let entry = tasks
                .get_mut(task_id)
                .ok_or_else(|| anyhow!("task not found"))?;

            if entry.status != "running" {
                return Ok(json!({ "taskId": task_id, "status": entry.status, "canceled": false }));
            }

            entry.status = "canceled";
            entry.finished_at_ms = Some(now_ms());
            entry.error = Some("task canceled".into());
            entry.abort.take()
        };

        if let Some(handle) = abort {
            handle.abort();
        }

        Ok(json!({ "taskId": task_id, "status": "canceled", "canceled": true }))
    }

    async fn prune(&self) {
        let mut tasks = self.tasks.lock().await;
        if tasks.len() < MAX_RETAINED_TASKS {
            return;
        }

        let mut finished: Vec<(String, u128)> = tasks
            .iter()
            .filter(|(_, entry)| entry.status != "running")
            .map(|(id, entry)| {
                (
                    id.clone(),
                    entry.finished_at_ms.unwrap_or(entry.created_at_ms),
                )
            })
            .collect();
        finished.sort_by_key(|(_, timestamp)| *timestamp);

        let remove_count = tasks
            .len()
            .saturating_sub(MAX_RETAINED_TASKS - 1)
            .min(finished.len());

        for (id, _) in finished.into_iter().take(remove_count) {
            tasks.remove(&id);
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}
