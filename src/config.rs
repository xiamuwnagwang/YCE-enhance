use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::plan::PlanCustomProvider;

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub runtime_root: PathBuf,
    pub relay_url: String,
    pub api_base: String,
    pub auth_base: String,
    pub relay_token: String,
    pub direct_api_key: String,
    pub prompt_enhance_mode: String,
    pub prompt_enhance_enable_search: bool,
    pub default_mode: String,
    pub timeout_search: Duration,
    pub timeout_enhance: Duration,
    pub timeout_auto_enhance: Duration,
    pub timeout_network: Duration,
    pub timeout_plan: Duration,
    pub y_plan_custom_provider: PlanCustomProvider,
    pub enhance_custom_provider: PlanCustomProvider,
}

impl RuntimeConfig {
    pub fn load(runtime_root: &Path) -> Result<Self> {
        let file_values = parse_env_file(&runtime_root.join(".env"))?;
        let get = |key: &str| -> Option<String> {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| file_values.get(key).cloned())
                .map(|value| value.trim().to_string())
        };

        let relay_url = normalize_http_url(
            get("YCE_RELAY_URL")
                .as_deref()
                .unwrap_or("https://yce.aigy.de"),
            "YCE_RELAY_URL",
        )?;
        let api_base = normalize_http_url(
            get("YCE_API_BASE")
                .as_deref()
                .unwrap_or(&format!("{relay_url}/yce/api")),
            "YCE_API_BASE",
        )?;
        let auth_base = normalize_http_url(
            get("YCE_AUTH_BASE")
                .as_deref()
                .unwrap_or(&format!("{relay_url}/yce/auth")),
            "YCE_AUTH_BASE",
        )?;

        Ok(Self {
            runtime_root: runtime_root.to_path_buf(),
            relay_url,
            api_base,
            auth_base,
            relay_token: get("YCE_RELAY_TOKEN").unwrap_or_default(),
            direct_api_key: get("YCE_API_KEY").unwrap_or_default(),
            prompt_enhance_mode: get("YCE_PROMPT_ENHANCE_MODE")
                .unwrap_or_else(|| "agent".to_string()),
            prompt_enhance_enable_search: parse_bool(
                get("YCE_PROMPT_ENHANCE_ENABLE_SEARCH").as_deref(),
                true,
            )?,
            default_mode: get("YCE_DEFAULT_MODE").unwrap_or_else(|| "auto".to_string()),
            timeout_search: parse_duration(
                get("YCE_TIMEOUT_SEARCH_MS").as_deref(),
                180_000,
                "YCE_TIMEOUT_SEARCH_MS",
            )?,
            timeout_enhance: parse_duration(
                get("YCE_TIMEOUT_ENHANCE_MS").as_deref(),
                300_000,
                "YCE_TIMEOUT_ENHANCE_MS",
            )?,
            timeout_auto_enhance: parse_duration(
                get("YCE_TIMEOUT_AUTO_ENHANCE_MS").as_deref(),
                60_000,
                "YCE_TIMEOUT_AUTO_ENHANCE_MS",
            )?,
            timeout_network: parse_duration(
                get("YCE_TIMEOUT_NETWORK_MS").as_deref(),
                120_000,
                "YCE_TIMEOUT_NETWORK_MS",
            )?,
            // Relay 侧 y-plan 默认服务端超时为 480s，客户端跟随该预算。
            timeout_plan: parse_duration(
                get("YCE_TIMEOUT_PLAN_MS").as_deref(),
                480_000,
                "YCE_TIMEOUT_PLAN_MS",
            )?,
            // BYOK 是可选增值配置：单个值写错只警告并忽略，
            // 不能让整个 MCP 拒绝启动（与 skill CLI 的容错行为一致）。
            y_plan_custom_provider: PlanCustomProvider {
                provider: get("YCE_YPLAN_PROVIDER").unwrap_or_default(),
                base_url: get("YCE_YPLAN_BASE_URL").unwrap_or_default(),
                token: get("YCE_YPLAN_TOKEN").unwrap_or_default(),
                model: get("YCE_YPLAN_MODEL").unwrap_or_default(),
                temperature: parse_lenient_f64(
                    get("YCE_YPLAN_TEMPERATURE").as_deref(),
                    "YCE_YPLAN_TEMPERATURE",
                ),
                force_stream: parse_lenient_bool(
                    get("YCE_YPLAN_FORCE_STREAM").as_deref(),
                    "YCE_YPLAN_FORCE_STREAM",
                ),
            },
            enhance_custom_provider: PlanCustomProvider {
                provider: get("YCE_ENHANCE_PROVIDER").unwrap_or_default(),
                base_url: get("YCE_ENHANCE_BASE_URL").unwrap_or_default(),
                token: get("YCE_ENHANCE_TOKEN").unwrap_or_default(),
                model: get("YCE_ENHANCE_MODEL").unwrap_or_default(),
                temperature: parse_lenient_f64(
                    get("YCE_ENHANCE_TEMPERATURE").as_deref(),
                    "YCE_ENHANCE_TEMPERATURE",
                ),
                force_stream: parse_lenient_bool(
                    get("YCE_ENHANCE_FORCE_STREAM").as_deref(),
                    "YCE_ENHANCE_FORCE_STREAM",
                ),
            },
        })
    }
}

/// BYOK 可选数值：解析失败警告并忽略，绝不阻塞 MCP 启动。
fn parse_lenient_f64(value: Option<&str>, name: &str) -> Option<f64> {
    let value = value?;
    match value.trim().parse::<f64>() {
        Ok(parsed) => Some(parsed),
        Err(_) => {
            eprintln!("yce-mcp: 忽略无效的 {name}（必须是数字）");
            None
        }
    }
}

/// BYOK 可选布尔：解析失败警告并按 false 处理，绝不阻塞 MCP 启动。
fn parse_lenient_bool(value: Option<&str>, name: &str) -> bool {
    let Some(value) = value else {
        return false;
    };
    match parse_bool(Some(value), false) {
        Ok(parsed) => parsed,
        Err(_) => {
            eprintln!("yce-mcp: 忽略无效的 {name}（必须是 true/false）");
            false
        }
    }
}

fn parse_env_file(path: &Path) -> Result<HashMap<String, String>> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(path)
        .with_context(|| format!("无法读取配置文件：{}", path.display()))?;
    let mut values = HashMap::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let value = raw_value
            .trim()
            .trim_matches(|ch| ch == '\'' || ch == '"')
            .trim()
            .to_string();
        values.insert(key.to_string(), value);
    }
    Ok(values)
}

fn normalize_http_url(input: &str, name: &str) -> Result<String> {
    let trimmed = input.trim().trim_end_matches('/');
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(anyhow!("{name} 必须是 http 或 https 绝对地址"));
    }
    let remainder = trimmed
        .split_once("://")
        .map(|(_, value)| value)
        .unwrap_or_default();
    if remainder.is_empty() || remainder.starts_with('/') {
        return Err(anyhow!("{name} 缺少主机名"));
    }
    Ok(trimmed.to_string())
}

fn parse_bool(value: Option<&str>, fallback: bool) -> Result<bool> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(anyhow!("布尔配置值无效：{value}")),
    }
}

fn parse_duration(value: Option<&str>, fallback: u64, name: &str) -> Result<Duration> {
    let millis = match value {
        Some(value) => value
            .trim()
            .parse::<u64>()
            .with_context(|| format!("{name} 必须是正整数毫秒"))?,
        None => fallback,
    };
    if millis == 0 {
        return Err(anyhow!("{name} 必须大于 0"));
    }
    Ok(Duration::from_millis(millis))
}
