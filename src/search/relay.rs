use std::io::Write;
use std::time::{Duration, Instant};

use flate2::{write::GzEncoder, Compression};
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::time::sleep;
use uuid::Uuid;

use crate::config::RuntimeConfig;

use super::protobuf::{
    decode_connect_frames, encode_connect_frame, extract_strings, ProtobufEncoder,
};

const APP_ID: &str = "yce";
const APP_VERSION: &str = "1.48.2";
const LANGUAGE_SERVER_VERSION: &str = "1.9544.35";
const MODEL: &str = "MODEL_SWE_1_6_FAST";
const LEASE_SAFETY_SECONDS: i64 = 15;
const DEFAULT_MAX_STREAM_CALLS: u32 = 16;
const RETRY_HEADROOM: u32 = 4;

#[derive(Debug, Clone)]
pub struct RelayError {
    pub code: String,
    pub message: String,
    pub source: String,
    pub status: Option<u16>,
    pub retryable: bool,
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RelayError {}

#[derive(Debug, Clone, Deserialize)]
struct LeaseResponse {
    api_key: String,
    key_id: String,
    lease_id: String,
    #[serde(default)]
    lease_expires_at: String,
    #[serde(default)]
    lease_reusable: Option<bool>,
    #[serde(default)]
    max_stream_calls: Option<u32>,
    #[serde(default)]
    usage_mode: Option<String>,
}

#[derive(Debug, Clone)]
struct Lease {
    api_key: String,
    key_id: String,
    lease_id: String,
    expires_at: Option<OffsetDateTime>,
    reusable: bool,
    max_stream_calls: u32,
    usage_mode: String,
    logical_calls: u32,
    attempts: u32,
    total_duration_ms: u64,
    last_status: Option<u16>,
    last_error: Option<RelayError>,
}

#[derive(Debug)]
pub struct RelaySession {
    api_key: String,
    jwt: String,
    lease: Option<Lease>,
    direct: bool,
    release_transport: SearchTransport,
}

#[derive(Debug, Clone)]
pub struct SearchTransport {
    http: reqwest::Client,
    relay_url: String,
    api_base: String,
    auth_base: String,
    relay_token: String,
    direct_api_key: String,
}

impl SearchTransport {
    pub fn new(config: &RuntimeConfig) -> Result<Self, RelayError> {
        let http = reqwest::Client::builder()
            .user_agent("connect-go/1.18.1 (go1.25.5)")
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| RelayError::local("HTTP_CLIENT", error.to_string()))?;
        Ok(Self {
            http,
            relay_url: config.relay_url.clone(),
            api_base: config.api_base.clone(),
            auth_base: config.auth_base.clone(),
            relay_token: config.relay_token.clone(),
            direct_api_key: config.direct_api_key.clone(),
        })
    }

    pub async fn begin_session(&self) -> Result<RelaySession, RelayError> {
        if !self.relay_token.trim().is_empty() {
            let lease = self.lease_key(&[], 0).await?;
            let jwt = self.fetch_jwt(&lease.api_key, Some(&lease)).await?;
            return Ok(RelaySession {
                api_key: lease.api_key.clone(),
                jwt,
                lease: Some(lease),
                direct: false,
                release_transport: self.clone(),
            });
        }
        if self.direct_api_key.trim().is_empty() {
            return Err(RelayError::local(
                "AUTH_ERROR",
                "缺少 YCE_RELAY_TOKEN；若不使用 Relay，则必须设置 YCE_API_KEY。",
            ));
        }
        if is_public_protocol_proxy(&self.api_base) || is_public_protocol_proxy(&self.auth_base) {
            return Err(RelayError::local(
                "AUTH_ERROR",
                "YCE_API_KEY 直连模式必须同时设置非公共 Relay 的 YCE_API_BASE 和 YCE_AUTH_BASE；公共 /yce/api 与 /yce/auth 必须使用 YCE_RELAY_TOKEN 租约。",
            ));
        }
        let jwt = self.fetch_jwt(self.direct_api_key.trim(), None).await?;
        Ok(RelaySession {
            api_key: self.direct_api_key.trim().to_string(),
            jwt,
            lease: None,
            direct: true,
            release_transport: self.clone(),
        })
    }

    pub async fn finish_session(&self, session: &mut RelaySession) {
        if let Some(lease) = session.lease.take() {
            let _ = self.release_lease(&lease).await;
        }
    }

    pub fn credentials<'a>(&self, session: &'a RelaySession) -> (&'a str, &'a str) {
        (&session.api_key, &session.jwt)
    }

    pub async fn prepare_call(&self, session: &mut RelaySession) -> Result<(), RelayError> {
        self.ensure_call_credential(session).await
    }

    pub async fn check_rate_limit(&self, session: &RelaySession) -> bool {
        let mut request = ProtobufEncoder::new();
        request.write_message(1, &build_metadata(&session.api_key, &session.jwt));
        request.write_string(3, MODEL);
        match self
            .unary(
                &format!("{}/CheckUserMessageRateLimit", self.api_base),
                request.as_bytes(),
                true,
                session.lease.as_ref(),
                Duration::from_secs(30),
            )
            .await
        {
            Ok(_) => true,
            Err(error) if error.status == Some(429) => false,
            Err(_) => true,
        }
    }

    pub async fn replace_rate_limited_lease(
        &self,
        session: &mut RelaySession,
    ) -> Result<(), RelayError> {
        if session.direct {
            return Err(RelayError {
                code: "RATE_LIMITED".into(),
                message: "YCE API key 已达到上游限额，请稍后重试。".into(),
                source: "upstream".into(),
                status: Some(429),
                retryable: false,
            });
        }
        let excluded = session
            .lease
            .as_ref()
            .map(|lease| vec![lease.key_id.clone()])
            .unwrap_or_default();
        if let Some(mut old) = session.lease.take() {
            old.logical_calls = old.logical_calls.max(1);
            old.last_status = Some(429);
            old.last_error = Some(RelayError {
                code: "RATE_LIMITED".into(),
                message: "租用的上游密钥未通过限额检查。".into(),
                source: "upstream".into(),
                status: Some(429),
                retryable: false,
            });
            let _ = self.release_lease(&old).await;
        }
        self.rotate_lease(session, &excluded, 1).await
    }

    pub async fn replace_failed_lease(
        &self,
        session: &mut RelaySession,
        failure: &RelayError,
        exclude_current_key: bool,
    ) -> Result<(), RelayError> {
        if session.direct {
            return Err(failure.clone());
        }
        let excluded = if exclude_current_key {
            session
                .lease
                .as_ref()
                .map(|lease| vec![lease.key_id.clone()])
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if let Some(mut old) = session.lease.take() {
            old.logical_calls = old.logical_calls.max(1);
            old.last_status = failure.status;
            old.last_error = Some(failure.clone());
            let _ = self.release_lease(&old).await;
        }
        self.rotate_lease(session, &excluded, if exclude_current_key { 1 } else { 0 })
            .await
    }

    pub async fn stream(
        &self,
        session: &mut RelaySession,
        request_proto: &[u8],
        timeout: Duration,
    ) -> Result<Vec<u8>, RelayError> {
        self.ensure_call_credential(session).await?;
        let frame = encode_connect_frame(request_proto, true)
            .map_err(|error| RelayError::local("PROTO_ERROR", error.to_string()))?;
        let deadline = Instant::now() + timeout + Duration::from_secs(5);
        let mut last_error = None;
        for attempt in 0..=2_u32 {
            if Instant::now() >= deadline {
                break;
            }
            if let Some(lease) = session.lease.as_mut() {
                lease.attempts += 1;
            }
            let started = Instant::now();
            let request_timeout = deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_secs(1));
            match self
                .stream_once(session, &frame, timeout, request_timeout)
                .await
            {
                Ok((status, data)) => {
                    self.record_call(session, status, started.elapsed(), None)
                        .await;
                    if !session.direct && !lease_reusable(session.lease.as_ref()) {
                        if let Some(old) = session.lease.take() {
                            let _ = self.release_lease(&old).await;
                        }
                    }
                    return Ok(data);
                }
                Err(error) => {
                    let transient = error.retryable
                        || error.status.is_some_and(|status| status >= 500)
                        || error.code == "TIMEOUT";
                    last_error = Some(error);
                    if attempt >= 2 || !transient {
                        break;
                    }
                    let delay = Duration::from_millis(500 * u64::from(attempt + 1));
                    if Instant::now() + delay + Duration::from_secs(2) >= deadline {
                        break;
                    }
                    sleep(delay).await;
                }
            }
        }
        let error = last_error.unwrap_or_else(|| {
            RelayError::local(
                "TIMEOUT",
                format!("代码检索流在 {}ms 后超时。", timeout.as_millis()),
            )
        });
        self.record_call(
            session,
            error.status.unwrap_or(0),
            Duration::ZERO,
            Some(error.clone()),
        )
        .await;
        Err(error)
    }

    async fn stream_once(
        &self,
        session: &RelaySession,
        frame: &[u8],
        logical_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<(u16, Vec<u8>), RelayError> {
        let trace_id = Uuid::new_v4().simple().to_string();
        let span_id = &Uuid::new_v4().simple().to_string()[..16];
        let mut request = self
            .http
            .post(format!("{}/GetDevstralStream", self.api_base))
            .header(header::CONTENT_TYPE, "application/connect+proto")
            .header("Connect-Protocol-Version", "1")
            .header("Connect-Accept-Encoding", "gzip")
            .header("Connect-Content-Encoding", "gzip")
            .header(
                "Connect-Timeout-Ms",
                logical_timeout.as_millis().to_string(),
            )
            .header(header::ACCEPT_ENCODING, "identity")
            .header(
                "Baggage",
                format!(
                    "sentry-release=language-server-yce@{LANGUAGE_SERVER_VERSION},sentry-environment=stable,sentry-sampled=false,sentry-trace_id={trace_id},sentry-public_key=b813f73488da69eedec534dba1029111"
                ),
            )
            .header("Sentry-Trace", format!("{trace_id}-{span_id}-0"))
            .timeout(request_timeout)
            .body(frame.to_vec());
        request = self.with_auth_headers(request, session.lease.as_ref());
        let response = request
            .send()
            .await
            .map_err(|error| map_reqwest_error(error, "代码检索流请求失败"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(read_http_error(response).await);
        }
        let data = response
            .bytes()
            .await
            .map_err(|error| map_reqwest_error(error, "读取代码检索流失败"))?
            .to_vec();
        if let Some(error) = extract_stream_error(&data) {
            return Err(error);
        }
        Ok((status.as_u16(), data))
    }

    async fn ensure_call_credential(&self, session: &mut RelaySession) -> Result<(), RelayError> {
        if session.direct {
            return Ok(());
        }
        if session
            .lease
            .as_ref()
            .is_some_and(|lease| lease.logical_calls == 0 || lease_reusable(Some(lease)))
        {
            return Ok(());
        }
        self.rotate_lease(session, &[], 0).await
    }

    async fn rotate_lease(
        &self,
        session: &mut RelaySession,
        excluded_key_ids: &[String],
        retry_attempt: u8,
    ) -> Result<(), RelayError> {
        if let Some(old) = session.lease.take() {
            let _ = self.release_lease(&old).await;
        }
        let lease = self.lease_key(excluded_key_ids, retry_attempt).await?;
        let jwt = match self.fetch_jwt(&lease.api_key, Some(&lease)).await {
            Ok(jwt) => jwt,
            Err(error) => {
                let _ = self
                    .report_usage(&lease, usage_from_error(&lease, &error, "code_search"))
                    .await;
                return Err(error);
            }
        };
        session.api_key = lease.api_key.clone();
        session.jwt = jwt;
        session.lease = Some(lease);
        Ok(())
    }

    async fn lease_key(
        &self,
        excluded_key_ids: &[String],
        retry_attempt: u8,
    ) -> Result<Lease, RelayError> {
        if self.relay_token.trim().is_empty() {
            return Err(RelayError::local(
                "AUTH_ERROR",
                "缺少 YCE_RELAY_TOKEN，无法申请 Relay 租约。",
            ));
        }
        let response = self
            .http
            .post(format!("{}/yce/lease-key", self.relay_url))
            .bearer_auth(self.relay_token.trim())
            .header(header::ACCEPT, "application/json")
            .json(&serde_json::json!({
                "exclude_key_ids": excluded_key_ids,
                "retry_attempt": if retry_attempt == 1 { 1 } else { 0 }
            }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| map_reqwest_error(error, "Relay 租约请求失败"))?;
        if !response.status().is_success() {
            return Err(read_http_error(response).await);
        }
        let payload = response.json::<LeaseResponse>().await.map_err(|error| {
            RelayError::local("PARSE_ERROR", format!("Relay 租约响应无效：{error}"))
        })?;
        if payload.api_key.trim().is_empty()
            || payload.key_id.trim().is_empty()
            || payload.lease_id.trim().is_empty()
        {
            return Err(RelayError::local(
                "PARSE_ERROR",
                "Relay 租约缺少 api_key、key_id 或 lease_id。",
            ));
        }
        Ok(Lease {
            api_key: payload.api_key,
            key_id: payload.key_id,
            lease_id: payload.lease_id,
            expires_at: OffsetDateTime::parse(&payload.lease_expires_at, &Rfc3339).ok(),
            reusable: payload.lease_reusable == Some(true),
            max_stream_calls: payload.max_stream_calls.unwrap_or(DEFAULT_MAX_STREAM_CALLS),
            usage_mode: payload.usage_mode.unwrap_or_default(),
            logical_calls: 0,
            attempts: 0,
            total_duration_ms: 0,
            last_status: None,
            last_error: None,
        })
    }

    async fn fetch_jwt(&self, api_key: &str, lease: Option<&Lease>) -> Result<String, RelayError> {
        let mut metadata = ProtobufEncoder::new();
        metadata
            .write_string(1, APP_ID)
            .write_string(2, APP_VERSION)
            .write_string(3, api_key)
            .write_string(4, "zh-cn")
            .write_string(7, LANGUAGE_SERVER_VERSION)
            .write_string(12, APP_ID)
            .write_bytes(30, &[0x00, 0x01]);
        let mut request = ProtobufEncoder::new();
        request.write_message(1, &metadata);
        let response = self
            .unary(
                &format!("{}/GetUserJwt", self.auth_base),
                request.as_bytes(),
                false,
                lease,
                Duration::from_secs(30),
            )
            .await?;
        extract_strings(&response)
            .into_iter()
            .find(|value| value.starts_with("eyJ") && value.contains('.'))
            .ok_or_else(|| RelayError::local("AUTH_ERROR", "GetUserJwt 响应中没有 JWT。"))
    }

    async fn unary(
        &self,
        url: &str,
        proto: &[u8],
        compress: bool,
        lease: Option<&Lease>,
        timeout: Duration,
    ) -> Result<Vec<u8>, RelayError> {
        let body = if compress {
            gzip(proto)?
        } else {
            proto.to_vec()
        };
        let mut last_error = None;
        for attempt in 0..=1 {
            let mut request = self
                .http
                .post(url)
                .header(header::CONTENT_TYPE, "application/proto")
                .header("Connect-Protocol-Version", "1")
                .header(header::ACCEPT_ENCODING, "gzip")
                .timeout(timeout)
                .body(body.clone());
            if compress {
                request = request.header(header::CONTENT_ENCODING, "gzip");
            }
            request = self.with_auth_headers(request, lease);
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    return response
                        .bytes()
                        .await
                        .map(|bytes| bytes.to_vec())
                        .map_err(|error| map_reqwest_error(error, "读取 Protobuf 响应失败"));
                }
                Ok(response) => {
                    let status = response.status();
                    let error = read_http_error(response).await;
                    if attempt == 1 || status.is_client_error() {
                        return Err(error);
                    }
                    last_error = Some(error);
                }
                Err(error) => {
                    let error = map_reqwest_error(error, "Protobuf 请求失败");
                    if attempt == 1 || !error.retryable {
                        return Err(error);
                    }
                    last_error = Some(error);
                }
            }
            sleep(Duration::from_millis(500)).await;
        }
        Err(last_error.unwrap_or_else(|| RelayError::local("EXEC_ERROR", "请求失败。")))
    }

    fn with_auth_headers(
        &self,
        mut request: reqwest::RequestBuilder,
        lease: Option<&Lease>,
    ) -> reqwest::RequestBuilder {
        if let Some(lease) = lease {
            request = request
                .bearer_auth(self.relay_token.trim())
                .header("X-YCE-Lease-Id", &lease.lease_id)
                .header("X-YCE-Key-Id", &lease.key_id);
        }
        request
    }

    async fn record_call(
        &self,
        session: &mut RelaySession,
        status: u16,
        duration: Duration,
        error: Option<RelayError>,
    ) {
        let Some(lease) = session.lease.as_mut() else {
            return;
        };
        lease.logical_calls += 1;
        lease.total_duration_ms = lease
            .total_duration_ms
            .saturating_add(duration.as_millis().min(u128::from(u64::MAX)) as u64);
        lease.last_status = (status > 0).then_some(status);
        lease.last_error = error.clone();
        if lease.usage_mode == "per_call_v1" {
            let event = UsageRequest {
                key_id: &lease.key_id,
                lease_id: &lease.lease_id,
                event: "code_search_call",
                call_seq: Some(lease.logical_calls),
                status_code: lease.last_status,
                error_message: error.as_ref().map(|value| clipped(&value.message, 1000)),
                error_code: error.as_ref().map(|value| clipped(&value.code, 128)),
                error_source: error.as_ref().map(|value| clipped(&value.source, 32)),
                duration_ms: Some(duration.as_millis().min(u128::from(u64::MAX)) as u64),
                calls: Some(1),
            };
            let _ = self.report_usage(lease, event).await;
        }
    }

    async fn release_lease(&self, lease: &Lease) -> bool {
        if lease.logical_calls == 0 {
            return true;
        }
        let event = if lease.usage_mode == "per_call_v1" {
            UsageRequest {
                key_id: &lease.key_id,
                lease_id: &lease.lease_id,
                event: "lease_release",
                call_seq: None,
                status_code: None,
                error_message: None,
                error_code: None,
                error_source: None,
                duration_ms: None,
                calls: None,
            }
        } else {
            UsageRequest {
                key_id: &lease.key_id,
                lease_id: &lease.lease_id,
                event: "code_search",
                call_seq: None,
                status_code: lease.last_status,
                error_message: lease
                    .last_error
                    .as_ref()
                    .map(|value| clipped(&value.message, 1000)),
                error_code: lease
                    .last_error
                    .as_ref()
                    .map(|value| clipped(&value.code, 128)),
                error_source: lease
                    .last_error
                    .as_ref()
                    .map(|value| clipped(&value.source, 32)),
                duration_ms: Some(lease.total_duration_ms),
                calls: Some(lease.logical_calls),
            }
        };
        self.report_usage(lease, event).await
    }

    async fn report_usage(&self, _lease: &Lease, event: UsageRequest<'_>) -> bool {
        for attempt in 0..3 {
            match self
                .http
                .post(format!("{}/yce/usage", self.relay_url))
                .bearer_auth(self.relay_token.trim())
                .header(header::ACCEPT, "application/json")
                .json(&event)
                .timeout(Duration::from_secs(3))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => return true,
                Ok(response)
                    if response.status().is_client_error()
                        && !matches!(
                            response.status(),
                            StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
                        ) =>
                {
                    return false
                }
                _ if attempt < 2 => sleep(Duration::from_millis(150 << attempt)).await,
                _ => return false,
            }
        }
        false
    }
}

impl Drop for RelaySession {
    fn drop(&mut self) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        let transport = self.release_transport.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = transport.release_lease(&lease).await;
            });
        }
    }
}

impl RelayError {
    fn local(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            source: "yce-engine".into(),
            status: None,
            retryable: false,
        }
    }
}

#[derive(Debug, Serialize)]
struct UsageRequest<'a> {
    key_id: &'a str,
    lease_id: &'a str,
    event: &'a str,
    call_seq: Option<u32>,
    status_code: Option<u16>,
    error_message: Option<String>,
    error_code: Option<String>,
    error_source: Option<String>,
    duration_ms: Option<u64>,
    calls: Option<u32>,
}

fn usage_from_error<'a>(lease: &'a Lease, error: &RelayError, event: &'a str) -> UsageRequest<'a> {
    UsageRequest {
        key_id: &lease.key_id,
        lease_id: &lease.lease_id,
        event,
        call_seq: None,
        status_code: error.status,
        error_message: Some(clipped(&error.message, 1000)),
        error_code: Some(clipped(&error.code, 128)),
        error_source: Some(clipped(&error.source, 32)),
        duration_ms: None,
        calls: Some(1),
    }
}

pub fn build_metadata(api_key: &str, jwt: &str) -> ProtobufEncoder {
    let os_name = std::env::consts::OS;
    let architecture = std::env::consts::ARCH;
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into());
    let system = serde_json::json!({
        "Os": os_name,
        "Arch": architecture,
        "Release": "",
        "Version": "",
        "Machine": architecture,
        "Nodename": host,
        "Sysname": match os_name {
            "macos" => "Darwin",
            "windows" => "Windows_NT",
            _ => "Linux",
        },
        "ProductVersion": ""
    });
    let threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4);
    let cpu = serde_json::json!({
        "NumSockets": 1,
        "NumCores": threads,
        "NumThreads": threads,
        "VendorID": "",
        "Family": "0",
        "Model": "0",
        "ModelName": "Unknown",
        "Memory": 0
    });
    let mut metadata = ProtobufEncoder::new();
    metadata
        .write_string(1, APP_ID)
        .write_string(2, APP_VERSION)
        .write_string(3, api_key)
        .write_string(4, "zh-cn")
        .write_string(5, &system.to_string())
        .write_string(7, LANGUAGE_SERVER_VERSION)
        .write_string(8, &cpu.to_string())
        .write_string(12, APP_ID)
        .write_string(21, jwt)
        .write_bytes(30, &[0x00, 0x01]);
    metadata
}

fn lease_reusable(lease: Option<&Lease>) -> bool {
    let Some(lease) = lease else {
        return false;
    };
    if !lease.reusable {
        return false;
    }
    let budget = lease.max_stream_calls.saturating_sub(RETRY_HEADROOM).max(1);
    if lease.attempts.max(lease.logical_calls) >= budget {
        return false;
    }
    lease.expires_at.is_some_and(|expires_at| {
        expires_at - time::Duration::seconds(LEASE_SAFETY_SECONDS) > OffsetDateTime::now_utc()
    })
}

fn gzip(data: &[u8]) -> Result<Vec<u8>, RelayError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data)
        .map_err(|error| RelayError::local("GZIP_ERROR", error.to_string()))?;
    encoder
        .finish()
        .map_err(|error| RelayError::local("GZIP_ERROR", error.to_string()))
}

fn map_reqwest_error(error: reqwest::Error, context: &str) -> RelayError {
    let timeout = error.is_timeout();
    RelayError {
        code: if timeout { "TIMEOUT" } else { "NETWORK_ERROR" }.into(),
        message: format!("{context}：{error}"),
        source: "network".into(),
        status: error.status().map(|status| status.as_u16()),
        retryable: timeout || error.is_connect() || error.is_request(),
    }
}

async fn read_http_error(response: reqwest::Response) -> RelayError {
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    let code = payload
        .get("code")
        .or_else(|| payload.pointer("/error/code"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "AUTH_ERROR",
            StatusCode::TOO_MANY_REQUESTS => "RATE_LIMITED",
            _ if status.is_server_error() => "SERVER_ERROR",
            _ => "HTTP_ERROR",
        })
        .to_string();
    let message = payload
        .get("error")
        .or_else(|| payload.get("message"))
        .or_else(|| payload.pointer("/error/message"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("HTTP 请求失败"))
        .to_string();
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("relay")
        .to_string();
    let retryable = payload
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS);
    RelayError {
        code,
        message,
        source,
        status: Some(status.as_u16()),
        retryable,
    }
}

fn clipped(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn is_public_protocol_proxy(base: &str) -> bool {
    let lower = base.to_ascii_lowercase();
    lower.contains("/yce/api") || lower.contains("/yce/auth") || lower.contains("yce.aigy.de")
}

fn extract_stream_error(data: &[u8]) -> Option<RelayError> {
    let frames = decode_connect_frames(data).ok()?;
    for frame in frames {
        let Ok(text) = std::str::from_utf8(&frame) else {
            continue;
        };
        let text = text.trim();
        if !text.starts_with('{') {
            continue;
        }
        let value = serde_json::from_str::<Value>(text).ok()?;
        let error = value.get("error")?;
        let upstream_code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let capacity = is_transient_capacity(upstream_code, message);
        return Some(RelayError {
            code: if capacity {
                "TRANSIENT_CAPACITY".into()
            } else {
                "SERVER_ERROR".into()
            },
            message: format!("[Error] {upstream_code}: {message}"),
            source: "upstream".into(),
            status: Some(200),
            retryable: false,
        });
    }
    None
}

fn is_transient_capacity(code: &str, message: &str) -> bool {
    let normalized = format!("{code} {message}").to_ascii_lowercase();
    normalized.contains("resource_exhausted")
        || normalized.contains("rate limit")
        || normalized.contains("rate_limit")
        || normalized.contains("quota exceeded")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_contains_protocol_constants_and_secret_fields() {
        let metadata = build_metadata("api-key-123456", "eyJ.header.payload");
        for expected in [
            APP_ID,
            APP_VERSION,
            "api-key-123456",
            "zh-cn",
            LANGUAGE_SERVER_VERSION,
            "eyJ.header.payload",
        ] {
            assert!(
                metadata
                    .as_bytes()
                    .windows(expected.len())
                    .any(|window| window == expected.as_bytes()),
                "{expected}"
            );
        }
    }

    #[test]
    fn lease_reuse_requires_server_capability_expiry_and_budget() {
        let lease = Lease {
            api_key: "x".repeat(32),
            key_id: "key".into(),
            lease_id: "lease".into(),
            expires_at: Some(OffsetDateTime::now_utc() + time::Duration::minutes(5)),
            reusable: true,
            max_stream_calls: 16,
            usage_mode: "per_call_v1".into(),
            logical_calls: 1,
            attempts: 1,
            total_duration_ms: 0,
            last_status: None,
            last_error: None,
        };
        assert!(lease_reusable(Some(&lease)));
        let mut incapable = lease.clone();
        incapable.reusable = false;
        assert!(!lease_reusable(Some(&incapable)));
        let mut expired = lease;
        expired.expires_at = Some(OffsetDateTime::now_utc());
        assert!(!lease_reusable(Some(&expired)));
    }
}
