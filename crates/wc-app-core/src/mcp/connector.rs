//! The connector loop of "Bu bilgisayar" (Hybrid Access H3,
//! docs/HYBRID_ACCESS.md §5 and §8), for the apps that hold the core in
//! process (the Linux Management Center). The Windows app runs the same loop
//! in C# (`center-windows/Core/RemoteConnector.cs`) against `wecommander-core`.
//!
//! While the app is signed in as Management Center `centerId`, the loop
//!
//! 1. publishes the saved SSH hosts shared with remote AI ([`super::remote::targets`]:
//!    name, preset, sudo, capabilities; never an address, user or key) when
//!    they change and once a minute,
//! 2. long-polls the gateway for the calls Claude/ChatGPT made through
//!    wecommander.app, and
//! 3. runs each call in the core ([`super::remote::call`], which connects
//!    from this computer: SSH keys and passwords never leave it) and posts
//!    the result back.
//!
//! The loop never approves anything: the gateway is the approval authority
//! and sends `approved` with each call; the loop hands that flag to the core
//! unchanged. When no host is shared it only checks again now and then.
//! Errors back off (5 s, doubling, at most a minute; 30 s when the token is
//! refused); the loop stops when the app signs out (the stop channel).
use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{watch, Notify};
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::remote::{self, RemoteCall};
use crate::time::now_unix;
use crate::AppState;

/// Published targets are sent again after this long even when unchanged.
pub const REPUBLISH_EVERY: Duration = Duration::from_secs(60);
/// How often the loop looks again while nothing is shared (or no centre id yet).
pub const IDLE_CHECK: Duration = Duration::from_secs(15);
/// First wait after an error; doubles with each failure in a row.
pub const RETRY_AFTER: Duration = Duration::from_secs(5);
/// The longest wait after errors in a row.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Wait after the gateway refused the token (the app signs out on its own sync).
pub const UNAUTHORIZED_WAIT: Duration = Duration::from_secs(30);
/// Long-poll wait; under the app's 20 s HTTP timeout (the gateway allows 15 s).
pub const CLAIM_WAIT_MS: u64 = 12_000;

/// A remote AI call the gateway queued for this computer.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCall {
    pub id: String,
    #[serde(default)]
    pub host_id: String,
    pub tool: String,
    /// The tool's arguments; the gateway puts the host id in `target`.
    #[serde(default)]
    pub args: Map<String, Value>,
    /// The gateway holds the person's one-time approval of exactly this call.
    #[serde(default)]
    pub approved: bool,
    /// The AI client as the gateway knows it.
    #[serde(default)]
    pub client: String,
}

impl ConnectorCall {
    /// The calls of a claim reply (`{items: [...]}`); malformed items are skipped.
    pub fn from_claim(body: &Value) -> Vec<ConnectorCall> {
        body.get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value::<ConnectorCall>(item.clone()).ok())
                    .filter(|c| !c.id.trim().is_empty() && !c.tool.trim().is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Why a gateway request failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// The token was revoked or expired.
    Unauthorized,
    /// No answer (offline, timeout, TLS).
    Network(String),
    /// The gateway answered with an error (older server, rate limit, call over).
    Rejected { status: u16, code: String },
    /// The core on this computer failed (host list busy).
    Local(String),
}

impl TransportError {
    /// A short code for the app's status line.
    pub fn code(&self) -> String {
        match self {
            TransportError::Unauthorized => "unauthorized".into(),
            TransportError::Network(_) => "offline".into(),
            TransportError::Rejected { status, code } if code.is_empty() => {
                format!("http_{status}")
            }
            TransportError::Rejected { code, .. } => code.clone(),
            TransportError::Local(_) => "core".into(),
        }
    }
}

/// The gateway side of the connector (the app's HTTP client; a fake in tests).
/// It has no way to approve: approvals are decided by the person on the
/// gateway (web Approvals page, the app's approval notifications).
pub trait ConnectorTransport: Send + Sync + 'static {
    /// Replaces the hosts this computer shares with remote AI.
    fn publish(&self, targets: Value) -> impl Future<Output = Result<(), TransportError>> + Send;
    /// Waits up to `wait_ms` for calls queued for this computer.
    fn claim(
        &self,
        wait_ms: u64,
    ) -> impl Future<Output = Result<Vec<ConnectorCall>, TransportError>> + Send;
    fn post_result(
        &self,
        call_id: &str,
        result: Value,
    ) -> impl Future<Output = Result<(), TransportError>> + Send;
}

/// What runs the calls: the core ([`AppState`]); a fake in tests.
pub trait CallRunner: Send + Sync + 'static {
    /// What to publish for connector `center_id` (`mcp.remoteTargets`).
    fn targets(&self, center_id: &str) -> Result<Value, String>;
    /// `{ok: true, result}` or `{ok: false, error, message}` (`mcp.remoteCall`).
    fn run(&self, center_id: &str, call: &ConnectorCall) -> impl Future<Output = Value> + Send;
}

impl CallRunner for Arc<AppState> {
    fn targets(&self, center_id: &str) -> Result<Value, String> {
        let targets = remote::targets(self, center_id)?;
        serde_json::to_value(targets).map_err(|e| e.to_string())
    }

    async fn run(&self, center_id: &str, call: &ConnectorCall) -> Value {
        let request = RemoteCall {
            call_id: call.id.clone(),
            center_id: center_id.to_owned(),
            client: call.client.clone(),
            tool: call.tool.clone(),
            args: call.args.clone(),
            // As the gateway sent it: this side never turns a call into an approved one.
            approved: call.approved,
        };
        remote::call(self, request).await
    }
}

/// What the app shows about the connector.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    /// The loop runs (signed in).
    pub running: bool,
    /// The last gateway request succeeded.
    pub online: bool,
    /// Hosts shared right now (last published).
    pub shared: usize,
    /// Calls running now.
    pub active: usize,
    /// Calls answered since the app started.
    pub handled: u64,
    /// Code of the last error ("offline", "unauthorized", ...), cleared on success.
    pub last_error: Option<String>,
    /// Unix seconds of the last successful gateway request.
    pub last_contact: Option<i64>,
}

/// The wait before the next round after `failures` errors in a row.
pub fn backoff(error: &TransportError, failures: u32) -> Duration {
    if *error == TransportError::Unauthorized {
        return UNAUTHORIZED_WAIT;
    }
    let shift = failures.saturating_sub(1).min(8);
    (RETRY_AFTER * (1u32 << shift)).min(MAX_BACKOFF)
}

/// The answer posted when the core gave nothing usable (English: it goes to the AI client).
fn connector_error() -> Value {
    json!({
        "ok": false,
        "error": "connector_error",
        "message": "WECOMMANDER on the person's computer could not run this call; try again.",
    })
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    loop {
        if *stop.borrow_and_update() {
            return;
        }
        if stop.changed().await.is_err() {
            // The sender is gone: the app signed out or quit.
            return;
        }
    }
}

/// One connector; [`Connector::run`] while signed in.
#[derive(Default)]
pub struct Connector {
    status: Mutex<ConnectorStatus>,
    active: Arc<Mutex<HashSet<String>>>,
    handled: Arc<Mutex<u64>>,
    published: Mutex<Option<(String, Instant)>>,
    wake: Notify,
}

impl Connector {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn status(&self) -> ConnectorStatus {
        let mut status = self.status.lock().map(|s| s.clone()).unwrap_or_default();
        status.active = self.active.lock().map(|a| a.len()).unwrap_or(0);
        status.handled = self.handled.lock().map(|h| *h).unwrap_or(0);
        status
    }

    /// Ends an idle or error wait now (the person changed what is shared).
    pub fn nudge(&self) {
        self.wake.notify_one();
    }

    fn update(&self, f: impl FnOnce(&mut ConnectorStatus)) {
        if let Ok(mut status) = self.status.lock() {
            f(&mut status);
        }
    }

    /// Runs until `stop` turns true or its sender is dropped. `center_id`
    /// is this app's Management Center id (None while unknown). Calls that
    /// are running when it stops still finish and post their result.
    pub async fn run<T: ConnectorTransport, R: CallRunner>(
        self: Arc<Self>,
        transport: Arc<T>,
        runner: Arc<R>,
        center_id: impl Fn() -> Option<String> + Send,
        mut stop: watch::Receiver<bool>,
    ) {
        self.update(|s| {
            *s = ConnectorStatus {
                running: true,
                ..Default::default()
            }
        });
        if let Ok(mut published) = self.published.lock() {
            *published = None;
        }
        let mut tasks = JoinSet::new();
        let mut failures = 0u32;
        loop {
            while tasks.try_join_next().is_some() {}
            let center = center_id();
            let step = tokio::select! {
                r = self.step(&transport, &runner, center.as_deref(), &mut tasks) => r,
                _ = stopped(&mut stop) => break,
            };
            let wait = match step {
                Ok(wait) => {
                    failures = 0;
                    wait
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    self.update(|s| {
                        s.online = false;
                        s.last_error = Some(error.code());
                    });
                    backoff(&error, failures)
                }
            };
            if !wait.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = self.wake.notified() => {}
                    _ = stopped(&mut stop) => break,
                }
            }
        }
        while tasks.join_next().await.is_some() {}
        self.update(|s| {
            s.running = false;
            s.online = false;
        });
    }

    /// One round: publish if changed (or a minute passed), then claim and
    /// start the calls. Returns how long to wait before the next round.
    pub async fn step<T: ConnectorTransport, R: CallRunner>(
        &self,
        transport: &Arc<T>,
        runner: &Arc<R>,
        center_id: Option<&str>,
        tasks: &mut JoinSet<()>,
    ) -> Result<Duration, TransportError> {
        let Some(center) = center_id.map(str::trim).filter(|c| !c.is_empty()) else {
            return Ok(IDLE_CHECK);
        };
        let targets = runner.targets(center).map_err(TransportError::Local)?;
        let count = targets.as_array().map_or(0, Vec::len);
        let text = targets.to_string();
        let due = match self.published.lock().ok().and_then(|p| p.clone()) {
            Some((last, at)) => last != text || at.elapsed() >= REPUBLISH_EVERY,
            None => true,
        };
        if due {
            transport.publish(targets).await?;
            if let Ok(mut published) = self.published.lock() {
                *published = Some((text, Instant::now()));
            }
            self.update(|s| {
                s.shared = count;
                s.online = true;
                s.last_error = None;
                s.last_contact = Some(now_unix());
            });
        }
        if count == 0 {
            return Ok(IDLE_CHECK);
        }
        let calls = transport.claim(CLAIM_WAIT_MS).await?;
        self.update(|s| {
            s.online = true;
            s.last_error = None;
            s.last_contact = Some(now_unix());
        });
        for call in calls {
            self.start(transport, runner, center, call, tasks);
        }
        Ok(Duration::ZERO)
    }

    fn start<T: ConnectorTransport, R: CallRunner>(
        &self,
        transport: &Arc<T>,
        runner: &Arc<R>,
        center: &str,
        call: ConnectorCall,
        tasks: &mut JoinSet<()>,
    ) {
        {
            let Ok(mut active) = self.active.lock() else {
                return;
            };
            if !active.insert(call.id.clone()) {
                return; // already running (claimed twice)
            }
        }
        let (transport, runner) = (transport.clone(), runner.clone());
        let (active, handled) = (self.active.clone(), self.handled.clone());
        let center = center.to_owned();
        tasks.spawn(async move {
            let result = runner.run(&center, &call).await;
            let result = if result.get("ok").is_some_and(Value::is_boolean) {
                result
            } else {
                connector_error()
            };
            post_with_retry(transport.as_ref(), &call.id, result).await;
            if let Ok(mut active) = active.lock() {
                active.remove(&call.id);
            }
            if let Ok(mut handled) = handled.lock() {
                *handled += 1;
            }
        });
    }
}

/// Posts a result; a network error is tried again twice (1 s, 3 s), any
/// other error ends it (the call is over on the gateway).
async fn post_with_retry<T: ConnectorTransport>(transport: &T, call_id: &str, result: Value) {
    for attempt in 0..3u64 {
        match transport.post_result(call_id, result.clone()).await {
            Ok(()) => return,
            Err(TransportError::Network(_)) if attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(1 + attempt * 2)).await;
            }
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Scripted gateway: each claim takes the next reply (or waits `wait_ms`
    /// and returns nothing), publishes and posts are recorded.
    #[derive(Default)]
    struct FakeGateway {
        publish_errors: Mutex<VecDeque<TransportError>>,
        claims: Mutex<VecDeque<Result<Vec<ConnectorCall>, TransportError>>>,
        post_errors: Mutex<VecDeque<TransportError>>,
        published: Mutex<Vec<(Value, Instant)>>,
        claimed: Mutex<u32>,
        posted: Mutex<Vec<(String, Value)>>,
        post_attempts: Mutex<u32>,
    }

    impl ConnectorTransport for FakeGateway {
        async fn publish(&self, targets: Value) -> Result<(), TransportError> {
            self.published
                .lock()
                .unwrap()
                .push((targets, Instant::now()));
            match self.publish_errors.lock().unwrap().pop_front() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }

        async fn claim(&self, wait_ms: u64) -> Result<Vec<ConnectorCall>, TransportError> {
            *self.claimed.lock().unwrap() += 1;
            let next = self.claims.lock().unwrap().pop_front();
            match next {
                Some(reply) => reply,
                None => {
                    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                    Ok(Vec::new())
                }
            }
        }

        async fn post_result(&self, call_id: &str, result: Value) -> Result<(), TransportError> {
            *self.post_attempts.lock().unwrap() += 1;
            if let Some(e) = self.post_errors.lock().unwrap().pop_front() {
                return Err(e);
            }
            self.posted
                .lock()
                .unwrap()
                .push((call_id.to_owned(), result));
            Ok(())
        }
    }

    /// A core that shares `shared` hosts and records how it was asked.
    struct FakeCore {
        shared: Mutex<Value>,
        ran: Mutex<Vec<(String, String, bool)>>,
        reply: Value,
    }

    impl FakeCore {
        fn new(shared: Value) -> Arc<Self> {
            Arc::new(Self {
                shared: Mutex::new(shared),
                ran: Mutex::new(Vec::new()),
                reply: json!({"ok": true, "result": {"stdout": "up"}}),
            })
        }
    }

    impl CallRunner for FakeCore {
        fn targets(&self, _center_id: &str) -> Result<Value, String> {
            Ok(self.shared.lock().unwrap().clone())
        }

        async fn run(&self, center_id: &str, call: &ConnectorCall) -> Value {
            self.ran
                .lock()
                .unwrap()
                .push((center_id.to_owned(), call.id.clone(), call.approved));
            self.reply.clone()
        }
    }

    fn call(id: &str, approved: bool) -> ConnectorCall {
        ConnectorCall {
            id: id.into(),
            host_id: "h1".into(),
            tool: "process_exec".into(),
            args: json!({"target": "h1", "command": "uptime"})
                .as_object()
                .cloned()
                .unwrap(),
            approved,
            client: "ChatGPT".into(),
        }
    }

    fn one_host() -> Value {
        json!([{"hostId": "h1", "name": "Web", "preset": "approval", "sudo": "never"}])
    }

    async fn until(mut check: impl FnMut() -> bool) {
        for _ in 0..10_000 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached");
    }

    #[test]
    fn parses_claim_replies() {
        let body = json!({"items": [
            {"id": "a", "hostId": "h1", "tool": "fs_list", "args": {"target": "h1", "path": "/"}, "approved": false, "client": "Claude"},
            {"id": "", "tool": "fs_list"},
            {"id": "b", "tool": ""},
            {"tool": "x"},
            {"id": "c", "tool": "process_exec", "approved": true}
        ]});
        let calls = ConnectorCall::from_claim(&body);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args["path"], "/");
        assert!(!calls[0].approved && calls[1].approved);
        assert!(ConnectorCall::from_claim(&json!({})).is_empty());
    }

    #[test]
    fn backoff_doubles_up_to_a_minute() {
        let net = TransportError::Network("down".into());
        let waits: Vec<u64> = (1..=6).map(|n| backoff(&net, n).as_secs()).collect();
        assert_eq!(waits, [5, 10, 20, 40, 60, 60]);
        assert_eq!(backoff(&net, 1000), MAX_BACKOFF);
        assert_eq!(backoff(&TransportError::Unauthorized, 1), UNAUTHORIZED_WAIT);
        assert_eq!(TransportError::Unauthorized.code(), "unauthorized");
        assert_eq!(net.code(), "offline");
        let rejected = TransportError::Rejected {
            status: 404,
            code: String::new(),
        };
        assert_eq!(rejected.code(), "http_404");
    }

    #[tokio::test(start_paused = true)]
    async fn claims_runs_and_posts_without_approving() {
        let gateway = Arc::new(FakeGateway::default());
        gateway.claims.lock().unwrap().push_back(Ok(vec![
            call("c1", false),
            call("c2", true),
            call("c1", false),
        ]));
        let core = FakeCore::new(one_host());
        let connector = Connector::new();
        let (stop, rx) = watch::channel(false);
        let run = tokio::spawn(connector.clone().run(
            gateway.clone(),
            core.clone(),
            || Some("center-1".into()),
            rx,
        ));
        until(|| gateway.posted.lock().unwrap().len() == 2).await;

        // Published once: the shared host only.
        let published = gateway.published.lock().unwrap().clone();
        assert_eq!(published[0].0, one_host());
        // Each call ran once in the core, as center-1, with the gateway's own
        // approval flag: never turned into an approved call here.
        let mut ran = core.ran.lock().unwrap().clone();
        ran.sort();
        assert_eq!(
            ran,
            vec![
                ("center-1".into(), "c1".into(), false),
                ("center-1".into(), "c2".into(), true),
            ]
        );
        let posted = gateway.posted.lock().unwrap().clone();
        assert!(posted.iter().all(|(_, r)| r["ok"] == true));
        let status = connector.status();
        assert!(status.running && status.online);
        assert_eq!((status.shared, status.handled), (1, 2));

        drop(stop);
        run.await.unwrap();
        assert!(!connector.status().running);
    }

    #[tokio::test(start_paused = true)]
    async fn bad_core_answer_becomes_connector_error() {
        let gateway = Arc::new(FakeGateway::default());
        gateway
            .claims
            .lock()
            .unwrap()
            .push_back(Ok(vec![call("c1", false)]));
        let core = Arc::new(FakeCore {
            shared: Mutex::new(one_host()),
            ran: Mutex::new(Vec::new()),
            reply: json!("nonsense"),
        });
        let (_stop, rx) = watch::channel(false);
        let connector = Connector::new();
        tokio::spawn(connector.run(gateway.clone(), core, || Some("c".into()), rx));
        until(|| !gateway.posted.lock().unwrap().is_empty()).await;
        let posted = gateway.posted.lock().unwrap().clone();
        assert_eq!(posted[0].1["error"], "connector_error");
    }

    #[tokio::test(start_paused = true)]
    async fn result_post_retries_network_errors_only() {
        let gateway = Arc::new(FakeGateway::default());
        gateway.post_errors.lock().unwrap().extend([
            TransportError::Network("reset".into()),
            TransportError::Network("reset".into()),
        ]);
        gateway
            .claims
            .lock()
            .unwrap()
            .push_back(Ok(vec![call("c1", false)]));
        let (_stop, rx) = watch::channel(false);
        tokio::spawn(Connector::new().run(
            gateway.clone(),
            FakeCore::new(one_host()),
            || Some("c".into()),
            rx,
        ));
        until(|| gateway.posted.lock().unwrap().len() == 1).await;
        assert_eq!(*gateway.post_attempts.lock().unwrap(), 3);

        // A call the gateway already closed (404) is not retried.
        let gateway = Arc::new(FakeGateway::default());
        gateway
            .post_errors
            .lock()
            .unwrap()
            .push_back(TransportError::Rejected {
                status: 404,
                code: "call_not_found".into(),
            });
        gateway
            .claims
            .lock()
            .unwrap()
            .push_back(Ok(vec![call("c9", false)]));
        let (_stop2, rx) = watch::channel(false);
        let connector = Connector::new();
        tokio::spawn(connector.clone().run(
            gateway.clone(),
            FakeCore::new(one_host()),
            || Some("c".into()),
            rx,
        ));
        until(|| connector.status().handled == 1).await;
        assert_eq!(*gateway.post_attempts.lock().unwrap(), 1);
        assert!(gateway.posted.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn backs_off_after_errors_and_recovers() {
        let gateway = Arc::new(FakeGateway::default());
        gateway.publish_errors.lock().unwrap().extend([
            TransportError::Network("down".into()),
            TransportError::Network("down".into()),
            TransportError::Network("down".into()),
        ]);
        let (_stop, rx) = watch::channel(false);
        let connector = Connector::new();
        tokio::spawn(connector.clone().run(
            gateway.clone(),
            FakeCore::new(one_host()),
            || Some("c".into()),
            rx,
        ));
        until(|| gateway.published.lock().unwrap().len() >= 2).await;
        let status = connector.status();
        assert!(!status.online);
        assert_eq!(status.last_error.as_deref(), Some("offline"));
        until(|| gateway.published.lock().unwrap().len() >= 4).await;
        let at: Vec<Instant> = gateway
            .published
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.1)
            .collect();
        let gaps: Vec<u64> = at.windows(2).map(|w| (w[1] - w[0]).as_secs()).collect();
        assert_eq!(gaps[..3], [5, 10, 20]);
        // The fourth publish worked: online again, claiming.
        until(|| *gateway.claimed.lock().unwrap() >= 1).await;
        let status = connector.status();
        assert!(status.online && status.last_error.is_none());

        // A refused token waits 30 s.
        let gateway = Arc::new(FakeGateway::default());
        gateway
            .claims
            .lock()
            .unwrap()
            .push_back(Err(TransportError::Unauthorized));
        let (_stop2, rx) = watch::channel(false);
        let connector = Connector::new();
        let started = Instant::now();
        tokio::spawn(connector.clone().run(
            gateway.clone(),
            FakeCore::new(one_host()),
            || Some("c".into()),
            rx,
        ));
        until(|| *gateway.claimed.lock().unwrap() >= 2).await;
        assert!(started.elapsed() >= UNAUTHORIZED_WAIT);
    }

    #[tokio::test(start_paused = true)]
    async fn publishes_on_change_and_idles_without_shared_hosts() {
        let gateway = Arc::new(FakeGateway::default());
        let core = FakeCore::new(json!([]));
        let (_stop, rx) = watch::channel(false);
        let connector = Connector::new();
        tokio::spawn(
            connector
                .clone()
                .run(gateway.clone(), core.clone(), || Some("c".into()), rx),
        );
        // Nothing shared: the empty list is published once (clears the
        // gateway), then no claims, only a look every 15 s.
        tokio::time::sleep(Duration::from_secs(50)).await;
        assert_eq!(gateway.published.lock().unwrap().len(), 1);
        assert_eq!(*gateway.claimed.lock().unwrap(), 0);
        // A host is shared: published at the next look (or at once on a nudge).
        *core.shared.lock().unwrap() = one_host();
        connector.nudge();
        until(|| gateway.published.lock().unwrap().len() == 2).await;
        until(|| *gateway.claimed.lock().unwrap() >= 1).await;
        assert_eq!(connector.status().shared, 1);
        // Unchanged: published again only after a minute.
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(gateway.published.lock().unwrap().len(), 2);
        tokio::time::sleep(Duration::from_secs(45)).await;
        assert_eq!(gateway.published.lock().unwrap().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn stops_on_sign_out_even_mid_claim() {
        let gateway = Arc::new(FakeGateway::default());
        let (stop, rx) = watch::channel(false);
        let connector = Connector::new();
        let run = tokio::spawn(connector.clone().run(
            gateway.clone(),
            FakeCore::new(one_host()),
            || Some("c".into()),
            rx,
        ));
        until(|| *gateway.claimed.lock().unwrap() >= 1).await;
        let at = Instant::now();
        stop.send(true).unwrap();
        run.await.unwrap();
        assert!(at.elapsed() < Duration::from_secs(1));
        assert!(!connector.status().running);
        let claims = *gateway.claimed.lock().unwrap();
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(*gateway.claimed.lock().unwrap(), claims);

        // Not signed in as a centre yet: nothing goes to the gateway.
        let gateway = Arc::new(FakeGateway::default());
        let (stop, rx) = watch::channel(false);
        let run = tokio::spawn(Connector::new().run(
            gateway.clone(),
            FakeCore::new(one_host()),
            || None,
            rx,
        ));
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(gateway.published.lock().unwrap().is_empty());
        drop(stop);
        run.await.unwrap();
    }

    #[derive(Default)]
    struct Sink;
    impl crate::EventSink for Sink {
        fn emit(&self, _: &str, _: Value) {}
    }

    /// With the real core: a command the gateway did not approve is refused
    /// (`approval_required`), the shared host is published without its
    /// address, and nothing is approved on the way.
    #[tokio::test(flavor = "multi_thread")]
    async fn real_core_refuses_unapproved_calls() {
        use crate::store::AiAccess;
        let dir = std::env::temp_dir().join(format!("wc-connector-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = crate::open(&dir, "app.wecommander.test.connector", Arc::new(Sink));
        let hosts = crate::add_host(
            &state,
            "Web".into(),
            "203.0.113.9".into(),
            22,
            "deploy".into(),
            "password".into(),
            None,
        )
        .unwrap();
        let web = hosts[0].id.clone();
        state
            .data
            .lock()
            .unwrap()
            .known_hosts
            .insert("203.0.113.9:22".into(), "SHA256:x".into());
        state
            .vault
            .put(&crate::store::secret_key(&web, "password"), "pw")
            .unwrap();
        crate::targets::set_ai_access(
            &state,
            web.clone(),
            AiAccess {
                remote: true,
                connector: "center-1".into(),
                ..Default::default()
            },
        )
        .unwrap();

        let gateway = Arc::new(FakeGateway::default());
        let mut unapproved = call("u1", false);
        unapproved.host_id = web.clone();
        unapproved.args.insert("target".into(), json!(web));
        gateway
            .claims
            .lock()
            .unwrap()
            .push_back(Ok(vec![unapproved]));
        let (stop, rx) = watch::channel(false);
        let run = tokio::spawn(Connector::new().run(
            gateway.clone(),
            Arc::new(state.clone()),
            || Some("center-1".into()),
            rx,
        ));
        until(|| !gateway.posted.lock().unwrap().is_empty()).await;
        let posted = gateway.posted.lock().unwrap().clone();
        assert_eq!(posted[0].0, "u1");
        assert_eq!(posted[0].1["error"], "approval_required");
        let published = gateway.published.lock().unwrap()[0].0.to_string();
        assert!(published.contains(&web) && !published.contains("203.0.113"));
        drop(stop);
        run.await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
