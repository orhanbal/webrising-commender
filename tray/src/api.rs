//! Gateway client. Every call carries the center token; the gateway lets it
//! reach only approvals, autonomous mode, the device list and /api/center/*.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize)]
pub struct Approval {
    pub id: String,
    pub device_id: String,
    pub action_kind: String,
    #[serde(default)]
    pub action: Value,
    pub expires_at: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub trust_level: Option<String>,
    #[serde(default)]
    pub trust_full_until: Option<String>,
    #[serde(default)]
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct AutonomyItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub trust_full_until: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub center_id: String,
    pub name: String,
    pub email: Option<String>,
    pub role: String,
    pub organization_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStart {
    pub request_id: String,
    pub request_secret: String,
    pub approve_url: String,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPoll {
    pub status: String,
    #[serde(default)]
    pub center_token: Option<String>,
}

/// Where a request was decided: a Management Center (with its name and kind
/// of computer) or the web panel. `is_self` is this center.
#[derive(Clone, Debug, Deserialize)]
pub struct DecidedVia {
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default, rename = "self")]
    pub is_self: bool,
}

/// The outcome of one approval request (GET /api/approval-requests/{id}).
#[derive(Clone, Debug, Deserialize)]
pub struct Outcome {
    pub status: String,
    #[serde(default)]
    pub decided_via: Option<DecidedVia>,
}

/// The kind of computer this center runs on, as the gateway stores it.
pub const PLATFORM: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

#[derive(Debug)]
pub enum ApiError {
    /// Token revoked, expired, or the user lost access.
    Unauthorized,
    Http {
        status: u16,
        code: String,
    },
    Network(String),
}

impl ApiError {
    /// Message for the person, in Turkish (the window shows it as is).
    pub fn message(&self) -> String {
        match self {
            ApiError::Unauthorized => "Bağlantı iptal edilmiş ya da süresi dolmuş. Yeniden bağlan.".into(),
            ApiError::Network(detail) => format!("Sunucuya ulaşılamıyor ({detail})."),
            ApiError::Http { code, status } => match code.as_str() {
                "reauthentication_failed" => "Şifre hatalı.".into(),
                "approval_request_expired" => "Bu onay isteğinin süresi dolmuş. Yapay zekâ işlemi yeniden denediğinde yeni bir istek gelir.".into(),
                "approval_request_not_pending" => "Bu istek için zaten karar verilmiş.".into(),
                "approval_request_not_found" => "Onay isteği bulunamadı.".into(),
                "forbidden" => "Bu işlem için yönetici ya da sahip rolü gerekiyor.".into(),
                "center_scope" => "Yönetim Merkezi bu işlemi yapamaz.".into(),
                "rate_limited" => "Çok fazla deneme. Biraz sonra yeniden dene.".into(),
                "invalid_request" | "validation_error" => "İstek geçersiz.".into(),
                "" => format!("Sunucu hatası (HTTP {status})."),
                other => other.replace('_', " "),
            },
        }
    }
}

#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    base: String,
}

impl Api {
    pub fn new(base: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("wecommander-center/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self {
            http,
            base: base.trim_end_matches('/').to_owned(),
        }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, ApiError> {
        let response = req.send().await.map_err(|e| ApiError::Network(short(&e)))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.as_u16() == 401 {
            return Err(ApiError::Unauthorized);
        }
        if !status.is_success() {
            let code = body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            return Err(ApiError::Http {
                status: status.as_u16(),
                code,
            });
        }
        Ok(body)
    }

    fn get(&self, token: &str, path: &str) -> reqwest::RequestBuilder {
        self.http
            .get(format!("{}{}", self.base, path))
            .bearer_auth(token)
    }

    fn post(&self, token: Option<&str>, path: &str, body: Value) -> reqwest::RequestBuilder {
        let req = self.http.post(format!("{}{}", self.base, path)).json(&body);
        match token {
            Some(token) => req.bearer_auth(token),
            None => req,
        }
    }

    pub async fn link_start(&self, name: &str) -> Result<LinkStart, ApiError> {
        let body = self
            .send(self.post(
                None,
                "/api/center-link/start",
                json!({ "name": name, "platform": PLATFORM }),
            ))
            .await?;
        serde_json::from_value(body).map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn link_poll(&self, id: &str, secret: &str) -> Result<LinkPoll, ApiError> {
        let body = self
            .send(self.post(
                None,
                "/api/center-link/poll",
                json!({ "requestId": id, "requestSecret": secret }),
            ))
            .await?;
        serde_json::from_value(body).map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn me(&self, token: &str) -> Result<Me, ApiError> {
        let body = self
            .send(self.get(token, &format!("/api/center/me?platform={PLATFORM}")))
            .await?;
        serde_json::from_value(body).map_err(|e| ApiError::Network(e.to_string()))
    }

    async fn items<T: for<'de> Deserialize<'de>>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<Vec<T>, ApiError> {
        let body = self.send(self.get(token, path)).await?;
        serde_json::from_value(body.get("items").cloned().unwrap_or(Value::Array(vec![])))
            .map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn pending(&self, token: &str) -> Result<Vec<Approval>, ApiError> {
        self.items(token, "/api/approval-requests?status=pending&limit=100")
            .await
    }

    pub async fn devices(&self, token: &str) -> Result<Vec<Device>, ApiError> {
        let all: Vec<Device> = self.items(token, "/api/devices").await?;
        Ok(all.into_iter().filter(|d| d.revoked_at.is_none()).collect())
    }

    pub async fn autonomy(&self, token: &str) -> Result<Vec<AutonomyItem>, ApiError> {
        self.items(token, "/api/trust/autonomy").await
    }

    /// Where and how a request ended, once it left the pending list.
    pub async fn outcome(&self, token: &str, id: &str) -> Result<Outcome, ApiError> {
        if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || id.len() != 36 {
            return Err(ApiError::Http {
                status: 400,
                code: "invalid_request".into(),
            });
        }
        let body = self
            .send(self.get(token, &format!("/api/approval-requests/{id}")))
            .await?;
        serde_json::from_value(body.get("item").cloned().unwrap_or(Value::Null))
            .map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn decide(&self, token: &str, id: &str, approve: bool) -> Result<(), ApiError> {
        if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || id.len() != 36 {
            return Err(ApiError::Http {
                status: 400,
                code: "invalid_request".into(),
            });
        }
        let path = format!(
            "/api/approval-requests/{id}/{}",
            if approve { "approve" } else { "deny" }
        );
        self.send(self.post(Some(token), &path, json!({})))
            .await
            .map(|_| ())
    }

    pub async fn set_autonomy(
        &self,
        token: &str,
        enable: bool,
        minutes: Option<u32>,
        device_ids: Option<Vec<String>>,
        password: Option<String>,
    ) -> Result<(), ApiError> {
        let mut body = json!({ "enable": enable });
        if enable {
            body["minutes"] = minutes.map(Value::from).unwrap_or(Value::Null);
            body["currentPassword"] = Value::from(password.unwrap_or_default());
        }
        if let Some(ids) = device_ids {
            body["deviceIds"] = Value::from(ids);
        }
        self.send(self.post(Some(token), "/api/trust/autonomy", body))
            .await
            .map(|_| ())
    }

    pub async fn disconnect(&self, token: &str) -> Result<(), ApiError> {
        self.send(self.post(Some(token), "/api/center/disconnect", json!({})))
            .await
            .map(|_| ())
    }
}

fn short(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "zaman aşımı".into()
    } else if error.is_connect() {
        "bağlantı kurulamadı".into()
    } else {
        "ağ hatası".into()
    }
}

/// "macOS'tan onaylandı" for a request this center showed but another center
/// or the web panel decided; None when nothing should be said (decided here,
/// expired, still pending).
pub fn decided_elsewhere(outcome: &Outcome) -> Option<String> {
    let verb = match outcome.status.as_str() {
        "approved" | "consumed" => "onaylandı",
        "denied" => "reddedildi",
        _ => return None,
    };
    let via = outcome.decided_via.as_ref().filter(|v| !v.is_self)?;
    let place = if via.kind == "panel" {
        "Web panelinden".to_owned()
    } else {
        match via.platform.as_deref() {
            Some("macos") => "macOS'tan".to_owned(),
            Some("windows") => "Windows'tan".to_owned(),
            Some("linux") => "Linux'tan".to_owned(),
            _ => match via.name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => format!("{name} üzerinden"),
                _ => "Başka bir Yönetim Merkezinden".to_owned(),
            },
        }
    };
    Some(format!("{place} {verb}"))
}

/// What an AI wants to type into a terminal: printable, one line, bounded.
pub fn terminal_input(data_base64: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let Ok(bytes) = STANDARD.decode(data_base64) else {
        return String::new();
    };
    String::from_utf8_lossy(&bytes)
        .replace("\r\n", "⏎")
        .replace(['\n', '\r'], "⏎")
        .chars()
        .map(|c| if c.is_control() { '·' } else { c })
        .take(300)
        .collect()
}

/// The exact thing an approval allows: the command, path or name.
pub fn summary(action: &Value) -> String {
    if let Some(Value::String(data)) = action.get("dataBase64") {
        return terminal_input(data);
    }
    for key in [
        "command",
        "path",
        "source",
        "name",
        "pid",
        "taskId",
        "sessionId",
    ] {
        match action.get(key) {
            Some(Value::String(text)) if !text.is_empty() => return text.clone(),
            Some(Value::Number(number)) => return format!("{key} {number}"),
            _ => {}
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_input_and_decided_elsewhere() {
        assert_eq!(
            summary(
                &json!({"kind":"terminal_input","sessionId":"s","dataBase64":"ZWNobyBoaQoHeA=="})
            ),
            "echo hi⏎·x"
        );
        assert_eq!(terminal_input("%%"), "");
        let outcome: Outcome = serde_json::from_value(json!({
            "id": "x", "status": "consumed",
            "decided_via": {"kind":"center","name":"Mac","platform":"macos","self":false}
        }))
        .unwrap();
        assert_eq!(
            decided_elsewhere(&outcome).as_deref(),
            Some("macOS'tan onaylandı")
        );
        let text = |status: &str, via: serde_json::Value| {
            decided_elsewhere(
                &serde_json::from_value(json!({"status": status, "decided_via": via})).unwrap(),
            )
        };
        assert_eq!(
            text("denied", json!({"kind":"panel"})).as_deref(),
            Some("Web panelinden reddedildi")
        );
        assert_eq!(
            text("approved", json!({"kind":"center","name":"Ev"})).as_deref(),
            Some("Ev üzerinden onaylandı")
        );
        assert_eq!(
            text(
                "approved",
                json!({"kind":"center","platform":"linux","self":true})
            ),
            None
        );
        assert_eq!(text("expired", json!(null)), None);
        assert_eq!(
            PLATFORM,
            if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            }
        );
    }

    #[test]
    fn summary_prefers_command_then_path() {
        assert_eq!(
            summary(&json!({"kind":"process_exec","command":"whoami","cwd":"C:\\x"})),
            "whoami"
        );
        assert_eq!(
            summary(&json!({"kind":"fs_delete","path":"/srv/a.txt"})),
            "/srv/a.txt"
        );
        assert_eq!(summary(&json!({"kind":"process_kill","pid":42})), "pid 42");
        assert_eq!(summary(&json!({"kind":"x"})), "");
    }

    #[test]
    fn error_messages_are_turkish_and_specific() {
        let expired = ApiError::Http {
            status: 409,
            code: "approval_request_expired".into(),
        };
        assert!(expired.message().contains("süresi dolmuş"));
        assert_eq!(
            ApiError::Http {
                status: 403,
                code: "reauthentication_failed".into()
            }
            .message(),
            "Şifre hatalı."
        );
        assert!(ApiError::Http {
            status: 500,
            code: String::new()
        }
        .message()
        .contains("500"));
    }

    #[test]
    fn parses_gateway_shapes() {
        let approval: Approval = serde_json::from_value(json!({
            "id":"99413e59-492a-4b60-b53a-9c36d5433112","device_id":"d","requested_by":"token:x",
            "action_kind":"process_exec","action":{"command":"whoami"},"status":"pending",
            "expires_at":"2026-11-07T11:14:18.026Z","created_at":"2026-11-07T11:04:18.026Z"
        }))
        .unwrap();
        assert_eq!(approval.action_kind, "process_exec");
        let device: Device = serde_json::from_value(json!({
            "id":"d","name":"content","platform":"windows","online":true,"trust_level":"standard",
            "trust_full_until":null,"revoked_at":null,"capabilities":{}
        }))
        .unwrap();
        assert!(device.online);
        let me: Me = serde_json::from_value(json!({
            "centerId":"c","name":"Ofis-PC","email":"a@b.c","role":"owner","organizationName":"WebRising"
        })).unwrap();
        assert_eq!(me.name, "Ofis-PC");
    }
}
