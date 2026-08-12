use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::config::RuntimeConfig;
use crate::error::ErrorItem;
use crate::model::NetworkResult;

#[derive(Debug, Serialize)]
struct NetworkSearchRequest<'a> {
    request_id: &'a str,
    query: &'a str,
    profile: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    library: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<&'a str>,
}

pub struct NetworkOutcome {
    pub result: NetworkResult,
    pub error: Option<ErrorItem>,
    pub duration_ms: u128,
}

#[derive(Clone)]
pub struct NetworkClient {
    http: reqwest::Client,
    relay_url: String,
    relay_token: String,
}

impl NetworkClient {
    pub fn new(config: &RuntimeConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("yce-mcp/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            http,
            relay_url: config.relay_url.clone(),
            relay_token: config.relay_token.clone(),
        })
    }

    pub async fn search(
        &self,
        query: &str,
        profile: &str,
        library: Option<&str>,
        repo: Option<&str>,
        timeout: Duration,
    ) -> NetworkOutcome {
        let request_id = Uuid::new_v4().to_string();
        let mut result = NetworkResult {
            executed: true,
            request_id: request_id.clone(),
            query: query.to_string(),
            profile: profile.to_string(),
            ..NetworkResult::default()
        };
        if self.relay_token.trim().is_empty() {
            return NetworkOutcome {
                result,
                error: Some(ErrorItem::new(
                    "network-search",
                    "AUTH_ERROR",
                    "缺少 Relay 用户令牌：请设置 YCE_RELAY_TOKEN。",
                )),
                duration_ms: 0,
            };
        }

        let started = Instant::now();
        let request = NetworkSearchRequest {
            request_id: &request_id,
            query,
            profile,
            library: non_empty(library),
            repo: non_empty(repo),
        };
        let response = self
            .http
            .post(format!("{}/yce/network-search", self.relay_url))
            .bearer_auth(self.relay_token.trim())
            .json(&request)
            .timeout(timeout)
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                return NetworkOutcome {
                    result,
                    error: Some(ErrorItem::new(
                        "network-search",
                        if error.is_timeout() {
                            "TIMEOUT"
                        } else {
                            "EXEC_ERROR"
                        },
                        if error.is_timeout() {
                            format!("联网检索请求在 {}ms 后超时。", timeout.as_millis())
                        } else {
                            format!(
                                "联网检索请求失败：{}",
                                redact(&error.to_string(), &self.relay_token)
                            )
                        },
                    )),
                    duration_ms: started.elapsed().as_millis(),
                };
            }
        };

        let status = response.status();
        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                return NetworkOutcome {
                    result,
                    error: Some(ErrorItem::new(
                        "network-search",
                        "EXEC_ERROR",
                        format!("无法读取联网检索响应：{error}"),
                    )),
                    duration_ms: started.elapsed().as_millis(),
                };
            }
        };
        let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

        if !status.is_success() {
            return NetworkOutcome {
                result,
                error: Some(map_http_error(status, &payload, &body, &self.relay_token)),
                duration_ms: started.elapsed().as_millis(),
            };
        }

        match serde_json::from_value::<NetworkResult>(payload) {
            Ok(decoded) => {
                result.status = decoded.status.or_else(|| Some("succeeded".into()));
                result.classification = decoded.classification;
                result.evidence = decoded.evidence;
                result.summaries = decoded.summaries;
                result.provider_runs = decoded.provider_runs;
                result.failures = decoded.failures;
                result.usage = decoded.usage;
                result.success = true;
                result.result_present = !result.evidence.is_empty() || !result.summaries.is_empty();
                let error = (!result.result_present).then(|| {
                    ErrorItem::new(
                        "network-search",
                        "EMPTY_RESULT",
                        "联网检索完成，但没有返回可用事实依据。",
                    )
                });
                NetworkOutcome {
                    result,
                    error,
                    duration_ms: started.elapsed().as_millis(),
                }
            }
            Err(error) => NetworkOutcome {
                result,
                error: Some(ErrorItem::new(
                    "network-search",
                    "PARSE_ERROR",
                    format!("联网检索返回了无效 JSON：{error}"),
                )),
                duration_ms: started.elapsed().as_millis(),
            },
        }
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

fn map_http_error(status: StatusCode, payload: &Value, raw_body: &str, token: &str) -> ErrorItem {
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
            let safe = redact(raw_body, token);
            safe.chars().take(512).collect()
        });
    let mapped = if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        "AUTH_ERROR"
    } else if status == StatusCode::TOO_MANY_REQUESTS
        || code.contains("QUOTA")
        || code == "EXTRA_QUOTA_EXHAUSTED"
    {
        "QUOTA_EXCEEDED"
    } else if code == "NETWORK_SEARCH_DISABLED" {
        "DISABLED"
    } else if code == "NETWORK_SEARCH_TIMEOUT" {
        "TIMEOUT"
    } else if code.is_empty() {
        "EXEC_ERROR"
    } else {
        code
    };
    ErrorItem::new("network-search", mapped, message)
}

fn redact(text: &str, secret: &str) -> String {
    if secret.len() >= 6 {
        text.replace(secret, "[REDACTED]")
    } else {
        text.to_string()
    }
}
