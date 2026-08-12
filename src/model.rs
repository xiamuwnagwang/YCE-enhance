use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ErrorItem;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Enhance,
    Search,
    Network,
    Plan,
    Task,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Enhance => "enhance",
            Self::Search => "search",
            Self::Network => "network",
            Self::Plan => "plan",
            Self::Task => "task",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct EnhanceResult {
    pub executed: bool,
    pub success: bool,
    pub prompt: Option<String>,
    pub recommended_skills: Vec<String>,
    /// 任务锚点（服务端 plan_complete 事件或正文 <plan> 兜底解析）：
    /// JSON {"goal": "...", "stages": [{"n":1,"title":"...","accept":[...]}]}
    pub task_plan: Option<Value>,
    pub raw_stdout: Option<String>,
    pub stderr_summary: Vec<String>,
    pub used_history: bool,
    pub raw_events: Option<RawEventsSummary>,
}

#[derive(Debug, Clone, Default)]
pub struct RawEventsSummary {
    pub captured: bool,
    pub event_count: usize,
    pub event_types: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchResult {
    pub executed: bool,
    pub success: bool,
    pub result_present: bool,
    pub empty_result: bool,
    pub query: String,
    pub raw_stdout: String,
    pub diagnostics: SearchDiagnostics,
    pub stderr_summary: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchDiagnostics {
    pub tree_depth: Option<u8>,
    pub requested_tree_depth: Option<u8>,
    pub tree_size_kb: Option<f64>,
    pub fell_back: Option<bool>,
    pub auto_depth: Option<bool>,
    pub context_trimmed: Option<bool>,
    pub repo_map_strategy: Option<String>,
    pub max_turns: Option<u8>,
    pub max_commands: Option<u8>,
    pub max_results: Option<u8>,
    pub timeout_ms: Option<u64>,
    pub bootstrap_enabled: Option<bool>,
    pub bootstrap_tree_depth: Option<u8>,
    pub hotspot_top_k: Option<u8>,
    pub hotspot_tree_depth: Option<u8>,
    pub hotspot_max_bytes: Option<usize>,
    pub bootstrap_max_turns: Option<u8>,
    pub bootstrap_max_commands: Option<u8>,
    pub turns_used: Option<u8>,
    pub error_type: Option<String>,
    pub project_path: Option<String>,
    pub ignore_file: Option<String>,
    pub hot_dirs: Vec<String>,
    pub exclude_paths: Vec<String>,
    pub ignore_patterns: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct NetworkResult {
    #[serde(skip)]
    pub executed: bool,
    #[serde(skip)]
    pub success: bool,
    #[serde(skip)]
    pub result_present: bool,
    #[serde(skip)]
    pub request_id: String,
    #[serde(skip)]
    pub query: String,
    #[serde(skip)]
    pub profile: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub classification: Option<Value>,
    #[serde(default)]
    pub evidence: Vec<Value>,
    #[serde(default)]
    pub summaries: Vec<Value>,
    #[serde(rename = "providerRuns", default)]
    pub provider_runs: Vec<Value>,
    #[serde(default)]
    pub failures: Vec<Value>,
    #[serde(default)]
    pub usage: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanResult {
    pub executed: bool,
    pub success: bool,
    pub result_present: bool,
    pub request_id: String,
    pub task: String,
    pub plan: Option<String>,
    pub saved_path: Option<String>,
    pub search_used: bool,
    pub custom_model: bool,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Degradation {
    pub active: bool,
    pub summary: Option<String>,
    pub failed_stage: Option<String>,
    pub search_query_source: Option<String>,
    pub fallback_query: Option<String>,
    pub error: Option<ErrorItem>,
}

#[derive(Debug, Clone, Default)]
pub struct Durations {
    pub enhance_ms: u128,
    pub search_ms: u128,
    pub network_ms: u128,
    pub plan_ms: u128,
    pub total_ms: u128,
}

/// 任务锚点上下文：每次带 cwd 的调用复述当前活跃卡（零配合兜底）。
#[derive(Debug, Clone)]
pub struct TaskContext {
    pub card: crate::task_store::TaskCard,
    pub created_now: bool,
}

#[derive(Debug, Clone)]
pub struct YceResponse {
    pub success: bool,
    pub mode: Mode,
    pub resolved_action: String,
    pub original_query: String,
    pub cwd: Option<String>,
    pub enhance: Option<EnhanceResult>,
    pub search: Option<SearchResult>,
    pub network_search: Option<NetworkResult>,
    pub plan: Option<PlanResult>,
    pub task_context: Option<TaskContext>,
    pub errors: Vec<ErrorItem>,
    pub durations: Durations,
    pub degradation: Degradation,
    pub timestamp: String,
}
