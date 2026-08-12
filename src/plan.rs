use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::RuntimeConfig;
use crate::enhance::{flush_sse_event, parse_sse_line, SseEvent};
use crate::error::ErrorItem;
use crate::model::PlanResult;

// Relay 侧 y-plan 的 search_context 上限（yPlanMaxSearchContext = 30000 字符）。
pub(crate) const MAX_SEARCH_CONTEXT_CHARS: usize = 30_000;

/// 请求级 BYOK 自备模型配置（提示词增强与 Y-Plan 共用；服务端各有独立开关）。
#[derive(Debug, Clone, Default)]
pub struct PlanCustomProvider {
    pub provider: String,
    pub base_url: String,
    pub token: String,
    pub model: String,
    pub temperature: Option<f64>,
    pub force_stream: bool,
}

impl PlanCustomProvider {
    pub fn is_configured(&self) -> bool {
        !self.provider.trim().is_empty()
            || !self.base_url.trim().is_empty()
            || !self.token.trim().is_empty()
            || !self.model.trim().is_empty()
    }

    /// 序列化成服务端契约的 camelCase config 字段。
    pub fn to_request_config(&self) -> Value {
        let mut config = json!({
            "provider": self.provider,
            "baseUrl": self.base_url,
            "token": self.token,
            "model": self.model,
        });
        if let Some(temperature) = self.temperature {
            config["temperature"] = json!(temperature);
        }
        if self.force_stream {
            config["forceStream"] = Value::Bool(true);
        }
        config
    }
}

#[derive(Debug, Clone, Default)]
pub struct PlanRequest {
    pub task: String,
    pub history: Option<String>,
    pub search_context: Option<String>,
    pub enable_web_search: Option<bool>,
    pub language: Option<String>,
}

pub struct PlanOutcome {
    pub result: PlanResult,
    pub error: Option<ErrorItem>,
    pub duration_ms: u128,
}

#[derive(Clone)]
pub struct PlanClient {
    http: reqwest::Client,
    relay_url: String,
    relay_token: String,
    custom_provider: PlanCustomProvider,
}

impl PlanClient {
    pub fn new(config: &RuntimeConfig) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("yce-mcp/", env!("CARGO_PKG_VERSION")))
                .build()?,
            relay_url: config.relay_url.clone(),
            relay_token: config.relay_token.clone(),
            custom_provider: config.y_plan_custom_provider.clone(),
        })
    }

    pub async fn plan(&self, request: PlanRequest, timeout: Duration) -> PlanOutcome {
        let request_id = Uuid::new_v4().to_string();
        let mut result = PlanResult {
            executed: true,
            request_id: request_id.clone(),
            task: request.task.clone(),
            ..PlanResult::default()
        };

        if self.relay_token.trim().is_empty() {
            return PlanOutcome {
                result,
                error: Some(ErrorItem::new(
                    "y-plan",
                    "AUTH_ERROR",
                    "缺少 YCE Key：请设置 YCE_RELAY_TOKEN。代码检索、联网检索、提示词增强和 Y-Plan 共用该密钥。",
                )),
                duration_ms: 0,
            };
        }

        let mut body = json!({
            "request_id": request_id,
            "task": request.task,
        });
        if let Some(history) = non_empty(request.history.as_deref()) {
            body["conversation_history"] = Value::String(history.to_string());
        }
        if let Some(context) = non_empty(request.search_context.as_deref()) {
            let truncated: String = context.chars().take(MAX_SEARCH_CONTEXT_CHARS).collect();
            body["search_context"] = Value::String(truncated);
        }
        if let Some(enable_web_search) = request.enable_web_search {
            body["enable_web_search"] = Value::Bool(enable_web_search);
        }
        if let Some(language) = non_empty(request.language.as_deref()) {
            body["language"] = Value::String(language.to_string());
        }
        if self.custom_provider.is_configured() {
            body["config"] = self.custom_provider.to_request_config();
            result.custom_model = true;
        }

        let started = Instant::now();
        let events = match tokio::time::timeout(timeout, self.request_events(&body)).await {
            Err(_) => {
                result.status = Some("timeout".into());
                return PlanOutcome {
                    result,
                    error: Some(ErrorItem::new(
                        "y-plan",
                        "TIMEOUT",
                        format!("Y-Plan 规划在 {}ms 后超时。", timeout.as_millis()),
                    )),
                    duration_ms: started.elapsed().as_millis(),
                };
            }
            Ok(Err(failure)) => {
                result.status = Some("failed".into());
                return PlanOutcome {
                    result,
                    error: Some(failure),
                    duration_ms: started.elapsed().as_millis(),
                };
            }
            Ok(Ok(events)) => events,
        };

        let mut accumulated = String::new();
        let mut final_plan: Option<String> = None;
        let mut status: Option<&'static str> = None;
        let mut error_message: Option<String> = None;
        for event in &events {
            match event.event.as_str() {
                "search_complete" => result.search_used = true,
                "chunk" => {
                    if let Some(chunk) = event.data.get("chunk").and_then(Value::as_str) {
                        accumulated.push_str(chunk);
                    }
                }
                "complete" => {
                    final_plan = event
                        .data
                        .get("plan")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    status = Some("succeeded");
                }
                "cancelled" => status = Some("cancelled"),
                "error" | "unauthorized" | "forbidden" => {
                    status = Some("failed");
                    error_message = event
                        .data
                        .get("error")
                        .or_else(|| event.data.get("message"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or_else(|| Some("Y-Plan 规划失败。".into()));
                }
                _ => {}
            }
        }

        let duration_ms = started.elapsed().as_millis();
        match status {
            Some("succeeded") => {
                let plan_text = final_plan
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| (!accumulated.trim().is_empty()).then(|| accumulated.clone()));
                let Some(plan_text) = plan_text else {
                    result.status = Some("failed".into());
                    return PlanOutcome {
                        result,
                        error: Some(ErrorItem::new(
                            "y-plan",
                            "EMPTY_RESULT",
                            "Y-Plan 规划完成，但没有返回计划内容。",
                        )),
                        duration_ms,
                    };
                };
                result.success = true;
                result.result_present = true;
                result.plan = Some(plan_text);
                result.status = Some("succeeded".into());
                PlanOutcome {
                    result,
                    error: None,
                    duration_ms,
                }
            }
            Some("cancelled") => {
                result.status = Some("cancelled".into());
                if !accumulated.trim().is_empty() {
                    result.plan = Some(accumulated);
                }
                PlanOutcome {
                    result,
                    error: Some(ErrorItem::new("y-plan", "CANCELLED", "Y-Plan 规划被取消。")),
                    duration_ms,
                }
            }
            _ => {
                result.status = Some("failed".into());
                if !accumulated.trim().is_empty() {
                    result.plan = Some(accumulated);
                }
                let message =
                    error_message.unwrap_or_else(|| "Y-Plan SSE 流意外结束，未收到终止事件。".into());
                let code = if contains_quota(&message) {
                    "QUOTA_EXCEEDED"
                } else {
                    "EXEC_ERROR"
                };
                PlanOutcome {
                    result,
                    error: Some(ErrorItem::new("y-plan", code, message)),
                    duration_ms,
                }
            }
        }
    }

    async fn request_events(&self, body: &Value) -> Result<Vec<SseEvent>, ErrorItem> {
        let response = self
            .http
            .post(format!("{}/yce/y-plan", self.relay_url))
            .bearer_auth(self.relay_token.trim())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(body)
            .send()
            .await
            .map_err(|error| {
                ErrorItem::new(
                    "y-plan",
                    "EXEC_ERROR",
                    redact(&format!("Y-Plan 请求失败：{error}"), &self.relay_token),
                )
            })?;
        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(map_plan_http_error(status, &body_text, &self.relay_token));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut current_event = "message".to_string();
        let mut data_lines = Vec::new();
        let mut events = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                ErrorItem::new("y-plan", "EXEC_ERROR", format!("读取 Y-Plan SSE 失败：{error}"))
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(newline) = buffer.find('\n') {
                let mut line = buffer[..newline].to_string();
                buffer.drain(..=newline);
                if line.ends_with('\r') {
                    line.pop();
                }
                parse_sse_line(&line, &mut current_event, &mut data_lines, &mut events);
            }
        }
        if !buffer.is_empty() {
            parse_sse_line(&buffer, &mut current_event, &mut data_lines, &mut events);
        }
        flush_sse_event(&mut current_event, &mut data_lines, &mut events);
        Ok(events)
    }
}

fn map_plan_http_error(status: reqwest::StatusCode, body: &str, token: &str) -> ErrorItem {
    let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = payload
        .get("error")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            let safe = redact(body, token);
            format!(
                "HTTP {}: {}",
                status.as_u16(),
                safe.chars().take(512).collect::<String>()
            )
        });
    if status == reqwest::StatusCode::NOT_FOUND {
        return ErrorItem::new(
            "y-plan",
            "NOT_DEPLOYED",
            "线上 YCE 服务尚未部署 Y-Plan 端点（HTTP 404）。请等待服务端发布该能力后重试。",
        );
    }
    let mapped = if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        "AUTH_ERROR"
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS || code.contains("QUOTA") {
        "QUOTA_EXCEEDED"
    } else if code == "Y_PLAN_DISABLED" {
        "DISABLED"
    } else if code == "Y_PLAN_TIMEOUT" {
        "TIMEOUT"
    } else if code.is_empty() {
        "EXEC_ERROR"
    } else {
        code
    };
    ErrorItem::new("y-plan", mapped, message)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// 按对接契约拼落盘文件名：y-plan-<任务摘要>-<yyyyMMdd-HHmmss>.md。
fn build_plan_filename(task: &str) -> String {
    let mut summary = String::new();
    let mut last_dash = true;
    for ch in task.trim().chars().take(24) {
        if ch.is_alphanumeric() {
            summary.extend(ch.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            summary.push('-');
            last_dash = true;
        }
    }
    let summary = summary.trim_matches('-');
    let summary = if summary.is_empty() { "plan" } else { summary };
    let now = time::OffsetDateTime::now_utc();
    let stamp = format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    format!("y-plan-{summary}-{stamp}.md")
}

/// 把计划正文写到本地：save_path 为目录时按契约自动命名；
/// 以 .md 结尾时按完整文件路径使用。返回写入后的路径。
pub fn save_plan_to_file(
    plan: &str,
    task: &str,
    save_path: &str,
) -> Result<std::path::PathBuf, String> {
    let mut resolved = std::path::PathBuf::from(save_path.trim());
    let looks_like_file = resolved
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    if !looks_like_file {
        resolved = resolved.join(build_plan_filename(task));
    }
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建目录失败：{error}"))?;
        }
    }
    let front_matter = format!(
        "---\ntask: {}\ngenerated_at: {}\nsource: yce-mcp y_plan\n---\n\n",
        serde_json::to_string(task).unwrap_or_else(|_| "\"\"".into()),
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
    );
    std::fs::write(&resolved, format!("{front_matter}{plan}"))
        .map_err(|error| format!("写入文件失败：{error}"))?;
    Ok(resolved)
}

fn contains_quota(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("quota") || text.contains("额度") || text.contains("配额")
}

fn redact(text: &str, secret: &str) -> String {
    if secret.len() >= 6 {
        text.replace(secret, "[REDACTED]")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_provider_detects_configuration() {
        assert!(!PlanCustomProvider::default().is_configured());
        let provider = PlanCustomProvider {
            model: "gpt-fixture".into(),
            ..PlanCustomProvider::default()
        };
        assert!(provider.is_configured());
    }

    #[test]
    fn plan_filename_follows_the_integration_contract() {
        let name = build_plan_filename("给 Go 服务增加限流中间件!!");
        assert!(
            regex_lite_match(&name),
            "unexpected filename: {name}"
        );
        assert!(name.starts_with("y-plan-给-go-服务增加限流中间件"));

        let fallback = build_plan_filename("!!!");
        assert!(fallback.starts_with("y-plan-plan-"));
    }

    fn regex_lite_match(name: &str) -> bool {
        // y-plan-<summary>-<yyyyMMdd-HHmmss>.md
        name.starts_with("y-plan-")
            && name.ends_with(".md")
            && name.len() > "y-plan--20260101-000000.md".len() - 1
    }

    #[test]
    fn save_plan_writes_front_matter_and_honors_explicit_md_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 目录：自动命名
        let saved = save_plan_to_file("# Y-Plan\nbody", "auto name", dir.path().to_str().unwrap())
            .expect("saved");
        let content = std::fs::read_to_string(&saved).expect("readable");
        assert!(content.starts_with("---\ntask: \"auto name\""));
        assert!(content.contains("# Y-Plan"));

        // 显式 .md 路径：原样使用
        let explicit = dir.path().join("nested").join("my-plan.md");
        let saved = save_plan_to_file("body", "explicit", explicit.to_str().unwrap())
            .expect("saved");
        assert_eq!(saved, explicit);
    }

    #[test]
    fn plan_http_errors_map_to_stable_codes() {
        let quota = map_plan_http_error(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":"y-plan quota reached","code":"Y_PLAN_DAILY_QUOTA_EXCEEDED"}"#,
            "secret-token",
        );
        assert_eq!(quota.code, "QUOTA_EXCEEDED");

        let disabled = map_plan_http_error(
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            r#"{"error":"y-plan is disabled","code":"Y_PLAN_DISABLED"}"#,
            "secret-token",
        );
        assert_eq!(disabled.code, "DISABLED");

        let auth = map_plan_http_error(reqwest::StatusCode::UNAUTHORIZED, "{}", "secret-token");
        assert_eq!(auth.code, "AUTH_ERROR");
    }
}
