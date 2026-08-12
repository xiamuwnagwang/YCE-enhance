use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use crate::config::RuntimeConfig;
use crate::error::ErrorItem;
use crate::model::{EnhanceResult, RawEventsSummary};

const MAX_INSTALLED_SKILLS: usize = 256;

#[derive(Debug, Clone, Serialize)]
struct InstalledSkill {
    name: String,
    description: String,
    triggers: Vec<String>,
    #[serde(rename = "quickStart", skip_serializing_if = "Option::is_none")]
    quick_start: Option<String>,
}

#[derive(Debug, Serialize)]
struct EnhanceRequest {
    request_id: String,
    mode: &'static str,
    prompt: String,
    conversation_history: String,
    context_files: Vec<String>,
    agent_config: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    /// BYOK 自备模型（服务端 prompt_enhance_allow_custom_model 放行后才生效）。
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    installed_skills: Vec<InstalledSkill>,
}

#[derive(Debug, Serialize)]
struct EnhanceDirectRequest {
    request_id: String,
    prompt: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    conversation_history: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<Value>,
}

#[derive(Debug)]
pub(crate) struct SseEvent {
    pub(crate) event: String,
    pub(crate) data: Value,
}

pub struct EnhanceOutcome {
    pub result: EnhanceResult,
    pub error: Option<ErrorItem>,
    pub duration_ms: u128,
}

#[derive(Clone)]
pub struct EnhanceClient {
    http: reqwest::Client,
    api_url: String,
    token: String,
    enhance_mode: String,
    enable_search: bool,
    custom_provider: crate::plan::PlanCustomProvider,
}

impl EnhanceClient {
    pub fn new(config: &RuntimeConfig) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("yce-mcp/", env!("CARGO_PKG_VERSION")))
                .build()?,
            api_url: config.relay_url.clone(),
            token: config.relay_token.clone(),
            enhance_mode: config.prompt_enhance_mode.clone(),
            enable_search: config.prompt_enhance_enable_search,
            custom_provider: config.enhance_custom_provider.clone(),
        })
    }

    fn byok_config(&self) -> Option<Value> {
        self.custom_provider
            .is_configured()
            .then(|| self.custom_provider.to_request_config())
    }

    pub fn has_token(&self) -> bool {
        !self.token.trim().is_empty()
    }

    /// direct 模式：单次 JSON 增强（/yce/prompt-enhance/direct），
    /// 无 Agent 管线、无技能推荐、无任务锚点，速度最快。
    pub async fn enhance_direct(
        &self,
        prompt: &str,
        history: Option<&str>,
        language: Option<&str>,
        timeout: Duration,
    ) -> EnhanceOutcome {
        let mut result = EnhanceResult {
            executed: true,
            used_history: history.is_some_and(|value| !value.trim().is_empty()),
            ..EnhanceResult::default()
        };
        if !self.has_token() {
            result.executed = false;
            return EnhanceOutcome {
                result,
                error: Some(ErrorItem::new(
                    "prompt-enhance",
                    "AUTH_ERROR",
                    "缺少 YCE Key：请设置 YCE_RELAY_TOKEN。代码检索、联网检索和提示词增强共用该密钥。",
                )),
                duration_ms: 0,
            };
        }

        let request = EnhanceDirectRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            prompt: prompt.to_string(),
            conversation_history: history.unwrap_or_default().to_string(),
            language: language
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            config: self.byok_config(),
        };
        let started = Instant::now();
        let send = async {
            let response = self
                .http
                .post(format!("{}/yce/prompt-enhance/direct", self.api_url))
                .bearer_auth(self.token.trim())
                .json(&request)
                .send()
                .await
                .map_err(|error| redact(&format!("增强请求失败：{error}"), &self.token))?;
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if !status.is_success() {
                let safe: String = redact(&body, &self.token).chars().take(512).collect();
                return Err(format!("HTTP {}: {}", status.as_u16(), safe));
            }
            let payload: Value = serde_json::from_str(&body)
                .map_err(|error| format!("direct 增强返回了无效 JSON：{error}"))?;
            Ok(payload
                .get("enhancedPrompt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string())
        };
        match tokio::time::timeout(timeout, send).await {
            Err(_) => EnhanceOutcome {
                result,
                error: Some(ErrorItem::new(
                    "prompt-enhance",
                    "TIMEOUT",
                    format!("提示词增强在 {}ms 后超时。", timeout.as_millis()),
                )),
                duration_ms: started.elapsed().as_millis(),
            },
            Ok(Err(error)) => {
                let (code, error) = map_enhance_http_failure(error);
                EnhanceOutcome {
                    result,
                    error: Some(ErrorItem::new("prompt-enhance", code, error)),
                    duration_ms: started.elapsed().as_millis(),
                }
            }
            Ok(Ok(enhanced)) => {
                if enhanced.is_empty() {
                    return EnhanceOutcome {
                        result,
                        error: Some(ErrorItem::new(
                            "prompt-enhance",
                            "EMPTY_RESULT",
                            "direct 增强完成，但没有返回增强结果。",
                        )),
                        duration_ms: started.elapsed().as_millis(),
                    };
                }
                result.success = true;
                result.raw_stdout = Some(format!("<enhanced>\n{enhanced}\n</enhanced>"));
                result.prompt = Some(enhanced);
                EnhanceOutcome {
                    result,
                    error: None,
                    duration_ms: started.elapsed().as_millis(),
                }
            }
        }
    }

    pub async fn enhance(
        &self,
        prompt: &str,
        history: Option<&str>,
        language: Option<&str>,
        no_search: bool,
        raw_events: bool,
        timeout: Duration,
    ) -> EnhanceOutcome {
        let mut result = EnhanceResult {
            executed: true,
            used_history: history.is_some_and(|value| !value.trim().is_empty()),
            ..EnhanceResult::default()
        };
        if self.enhance_mode == "disabled" {
            result.success = true;
            result.prompt = Some(prompt.to_string());
            return EnhanceOutcome {
                result,
                error: None,
                duration_ms: 0,
            };
        }
        if !self.has_token() {
            result.executed = false;
            return EnhanceOutcome {
                result,
                error: Some(ErrorItem::new(
                    "prompt-enhance",
                    "AUTH_ERROR",
                    "缺少 YCE Key：请设置 YCE_RELAY_TOKEN。代码检索、联网检索和提示词增强共用该密钥。",
                )),
                duration_ms: 0,
            };
        }

        let installed_skills = scan_all_skills()
            .into_iter()
            .take(MAX_INSTALLED_SKILLS)
            .collect::<Vec<_>>();
        let installed_skill_names = installed_skills
            .iter()
            .map(|skill| normalize_skill_name(&skill.name))
            .collect::<HashSet<_>>();
        let request_prompt = append_skill_instruction(prompt, &installed_skills);
        let request = EnhanceRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            mode: "agent",
            prompt: request_prompt,
            conversation_history: history.unwrap_or_default().to_string(),
            context_files: Vec::new(),
            agent_config: json!({
                "enable_summary": true,
                "enable_intent_analysis": true,
                "enable_search": !no_search && self.enable_search,
                "search_engines": ["grok", "perplexity", "exa", "context7", "deepwiki"],
                "auto_confirm_intent": true
            }),
            language: language
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            config: self.byok_config(),
            installed_skills,
        };

        let started = Instant::now();
        let future = self.request_events(&request);
        let events = match tokio::time::timeout(timeout, future).await {
            Err(_) => {
                return EnhanceOutcome {
                    result,
                    error: Some(ErrorItem::new(
                        "prompt-enhance",
                        "TIMEOUT",
                        format!("提示词增强在 {}ms 后超时。", timeout.as_millis()),
                    )),
                    duration_ms: started.elapsed().as_millis(),
                }
            }
            Ok(Err(error)) => {
                let (code, error) = map_enhance_http_failure(error);
                return EnhanceOutcome {
                    result,
                    error: Some(ErrorItem::new("prompt-enhance", code, error)),
                    duration_ms: started.elapsed().as_millis(),
                };
            }
            Ok(Ok(events)) => events,
        };

        let mut final_answer = String::new();
        let mut pipeline_error = None;
        let mut task_plan: Option<Value> = None;
        let mut event_types = BTreeSet::new();
        for event in &events {
            event_types.insert(event.event.clone());
            match event.event.as_str() {
                "agent4_reset" => final_answer.clear(),
                "agent4_chunk" => {
                    if let Some(chunk) = event.data.get("chunk").and_then(Value::as_str) {
                        final_answer.push_str(chunk);
                    }
                }
                // 任务锚点：服务端剥离 <plan> 块后通过 plan_complete 事件下发
                "plan_complete" => {
                    if let Some(plan) = event.data.get("plan") {
                        let has_goal = plan
                            .get("goal")
                            .and_then(Value::as_str)
                            .is_some_and(|goal| !goal.trim().is_empty());
                        if has_goal {
                            task_plan = Some(plan.clone());
                        }
                    }
                }
                "agent2_needs_confirmation" => {
                    let question = event
                        .data
                        .get("clarified_question")
                        .and_then(Value::as_str)
                        .unwrap_or("意图需要确认");
                    pipeline_error = Some(question.to_string());
                }
                "error" | "forbidden" => {
                    pipeline_error = event
                        .data
                        .get("error")
                        .or_else(|| event.data.get("message"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or_else(|| Some("增强流水线失败。".into()));
                }
                _ => {}
            }
        }

        if raw_events {
            result.raw_events = Some(RawEventsSummary {
                captured: true,
                event_count: events.len(),
                event_types: event_types.into_iter().collect(),
                error: None,
            });
        }
        if let Some(error) = pipeline_error {
            return EnhanceOutcome {
                result,
                error: Some(ErrorItem::new(
                    "prompt-enhance",
                    if contains_quota(&error) {
                        "QUOTA_EXCEEDED"
                    } else {
                        "EXEC_ERROR"
                    },
                    error,
                )),
                duration_ms: started.elapsed().as_millis(),
            };
        }
        let mut cleaned_answer = strip_thinking_markers(&final_answer);
        // 正文兜底：后端未升级时 <plan> 锚点仍留在正文开头，剥离并解析，
        // 保证事件路径与正文路径拿到相同 plan、正文无标签残留。
        let (inline_plan, stripped_answer) = extract_inline_plan(&cleaned_answer);
        if inline_plan.is_some() {
            if task_plan.is_none() {
                task_plan = inline_plan;
            }
            cleaned_answer = stripped_answer;
        }
        if cleaned_answer.trim().is_empty() {
            return EnhanceOutcome {
                result,
                error: Some(ErrorItem::new(
                    "prompt-enhance",
                    "EMPTY_RESULT",
                    "增强流水线完成，但没有返回增强结果。",
                )),
                duration_ms: started.elapsed().as_millis(),
            };
        }

        let (recommended_skills, enhanced_prompt) = parse_enhanced_content(&cleaned_answer);
        result.success = true;
        result.prompt = enhanced_prompt;
        result.recommended_skills =
            filter_recommended_skills(recommended_skills, &installed_skill_names);
        result.task_plan = task_plan;
        result.raw_stdout = Some(format!(
            "<enhanced>\n{}\n</enhanced>",
            cleaned_answer.trim()
        ));
        EnhanceOutcome {
            result,
            error: None,
            duration_ms: started.elapsed().as_millis(),
        }
    }

    async fn request_events(&self, request: &EnhanceRequest) -> Result<Vec<SseEvent>, String> {
        let response = self
            .http
            .post(format!("{}/yce/prompt-enhance/agent", self.api_url))
            .bearer_auth(self.token.trim())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(request)
            .send()
            .await
            .map_err(|error| redact(&format!("增强请求失败：{error}"), &self.token))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let safe: String = redact(&body, &self.token).chars().take(512).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), safe));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut current_event = "message".to_string();
        let mut data_lines = Vec::new();
        let mut events = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("读取增强 SSE 失败：{error}"))?;
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

pub(crate) fn parse_sse_line(
    line: &str,
    current_event: &mut String,
    data_lines: &mut Vec<String>,
    events: &mut Vec<SseEvent>,
) {
    if line.is_empty() {
        flush_sse_event(current_event, data_lines, events);
        return;
    }
    if line.starts_with(':') {
        return;
    }
    if let Some(event) = line.strip_prefix("event:") {
        if !data_lines.is_empty() {
            flush_sse_event(current_event, data_lines, events);
        }
        *current_event = event.trim().to_string();
        return;
    }
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let data = data.trim_start();
    if data == "keep-alive" || data.is_empty() {
        return;
    }
    data_lines.push(data.to_string());
}

pub(crate) fn flush_sse_event(
    current_event: &mut String,
    data_lines: &mut Vec<String>,
    events: &mut Vec<SseEvent>,
) {
    if data_lines.is_empty() {
        *current_event = "message".into();
        return;
    }
    let data = data_lines.join("\n");
    data_lines.clear();
    let value = serde_json::from_str(&data).unwrap_or_else(|_| json!({"raw": data}));
    events.push(SseEvent {
        event: std::mem::replace(current_event, "message".into()),
        data: value,
    });
}

fn scan_all_skills() -> Vec<InstalledSkill> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    let candidates = [
        ".claude/skills",
        ".config/opencode/skills",
        ".agents/skills",
        ".cursor/skills",
        ".codeium/yce/skills",
        ".cline/skills",
        ".gemini/skills",
        ".copilot/skills",
        ".codex/skills",
        ".codex/plugins/cache",
        "Documents/ai/skills",
    ];
    let mut names = HashSet::new();
    let mut skills = Vec::new();
    if let Some(extra_roots) = std::env::var_os("YCE_MCP_SKILLS_DIRS") {
        for root in std::env::split_paths(&extra_roots) {
            scan_skill_root(&root, 6, &mut names, &mut skills);
        }
    }
    for candidate in candidates {
        let root = home.join(candidate);
        scan_skill_root(&root, 6, &mut names, &mut skills);
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    skills
}

fn scan_skill_root(
    root: &Path,
    remaining_depth: usize,
    names: &mut HashSet<String>,
    skills: &mut Vec<InstalledSkill>,
) {
    let skill_md = root.join("SKILL.md");
    if let Ok(content) = fs::read_to_string(&skill_md) {
        let meta = parse_frontmatter(&content);
        let fallback_name = root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = meta.get("name").cloned().unwrap_or(fallback_name);
        if names.insert(name.clone()) {
            let description = meta.get("description").cloned().unwrap_or_default();
            skills.push(InstalledSkill {
                name,
                description: description.chars().take(500).collect(),
                triggers: extract_triggers(&description),
                quick_start: extract_quick_start(&content),
            });
        }
    }
    if remaining_depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            scan_skill_root(&entry.path(), remaining_depth - 1, names, skills);
        }
    }
}

fn parse_frontmatter(content: &str) -> std::collections::HashMap<String, String> {
    let mut result = std::collections::HashMap::new();
    let Some(rest) = content.strip_prefix("---") else {
        return result;
    };
    let Some((frontmatter, _)) = rest.split_once("\n---") else {
        return result;
    };
    let mut current_key: Option<String> = None;
    let mut multiline = String::new();
    for line in frontmatter.lines() {
        if line.starts_with("  ") {
            if current_key.is_some() {
                multiline.push_str(line.trim_start());
                multiline.push('\n');
            }
            continue;
        }
        if let Some(key) = current_key.take() {
            result.insert(key, multiline.trim().to_string());
            multiline.clear();
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if value == "|" || value == ">" {
            current_key = Some(key.trim().to_string());
        } else {
            result.insert(
                key.trim().to_string(),
                value.trim_matches(|ch| ch == '\'' || ch == '"').to_string(),
            );
        }
    }
    if let Some(key) = current_key {
        result.insert(key, multiline.trim().to_string());
    }
    result
}

fn extract_quick_start(content: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("node ") || line.starts_with("bun ") {
            return Some(line.to_string());
        }
    }
    None
}

fn append_skill_instruction(prompt: &str, skills: &[InstalledSkill]) -> String {
    if skills.is_empty() {
        return prompt.to_string();
    }
    let names = skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let max_recommendations = skills.len().min(8);
    format!(
        "{prompt}\n\n---\n\n【重要】基于提供的 {} 个本机可用 skill（installed_skills 上下文），先给出 skill 推荐，再给出增强后的提示词。\n\n请严格按以下顺序输出：\n1) 开头先输出“推荐技能”小节\n2) 然后输出“增强提示词正文”\n\n开头格式要求（不要用 XML）：\n推荐技能：\n- skill 名称：推荐理由（一句话）\n\n约束：\n1. 最多推荐 {max_recommendations} 个；没有合适的 skill 可以不推荐\n2. skill 名称只能从“候选 skill 名称”里选择，禁止创造新名字\n3. 推荐理由必须结合当前任务，不要写通用空话\n4. 不要输出 <auto-skills>、<think>、</think> 或任何 XML 标签\n\n候选 skill 名称：{names}",
        skills.len(),
    )
}

fn extract_triggers(description: &str) -> Vec<String> {
    let patterns = [
        r"(?i)触发词[：:]\s*([^\n【]+)",
        r"(?i)(?:smart\s*模式)?额外触发[：:]\s*([^\n【]+)",
        r"(?i)自动触发[：:]\s*([^\n【]+)",
        r"(?i)smart\s+triggers?[：:]\s*([^\n.]+)",
        r"(?i)triggers?[：:]\s*([^\n.]+)",
        r"(?i)关键词[：:]\s*([^\n【]+)",
        r"(?i)keywords?[：:]\s*([^\n.]+)",
        r"(?i)触发关键词[：:]\s*([^\n【]+)",
        r"(?i)激活词[：:]\s*([^\n【]+)",
        r"(?i)activation\s+(?:words?|keywords?)[：:]\s*([^\n.]+)",
    ];
    let mut triggers = Vec::new();
    for pattern in patterns {
        let Ok(regex) = regex::Regex::new(pattern) else {
            continue;
        };
        for captures in regex.captures_iter(description) {
            let Some(raw) = captures.get(1) else {
                continue;
            };
            for trigger in raw
                .as_str()
                .split(['、', ',', '，', '/'])
                .map(str::trim)
                .map(|value| value.trim_matches(['\'', '"']))
                .filter(|value| !value.is_empty())
            {
                if !triggers.iter().any(|existing| existing == trigger) {
                    triggers.push(trigger.to_string());
                }
            }
        }
    }
    triggers
}

fn parse_enhanced_content(content: &str) -> (Vec<String>, Option<String>) {
    let cleaned = strip_thinking_markers(content);
    let text = cleaned.trim();
    if text.is_empty() {
        return (Vec::new(), None);
    }
    let mut skills = Vec::new();
    if let Some(index) = text
        .find("增强提示词正文：")
        .or_else(|| text.find("增强提示词正文:"))
    {
        let marker_len = if text[index..].starts_with("增强提示词正文：") {
            "增强提示词正文：".len()
        } else {
            "增强提示词正文:".len()
        };
        collect_skills(&text[..index], &mut skills);
        return (
            dedupe(skills),
            non_empty_owned(text[index + marker_len..].trim()),
        );
    }

    let mut in_recommendation = false;
    let mut prompt_lines = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("推荐技能") {
            in_recommendation = true;
            continue;
        }
        if in_recommendation {
            if let Some(skill) = parse_skill_line(line) {
                skills.push(skill);
                continue;
            }
            if !line.is_empty() {
                in_recommendation = false;
            }
        }
        if !in_recommendation {
            prompt_lines.push(raw);
        }
    }
    (
        dedupe(skills),
        non_empty_owned(prompt_lines.join("\n").trim()),
    )
}

fn collect_skills(text: &str, skills: &mut Vec<String>) {
    for line in text.lines() {
        if let Some(skill) = parse_skill_line(line.trim()) {
            skills.push(skill);
        }
    }
}

fn parse_skill_line(line: &str) -> Option<String> {
    let line = line.strip_prefix('-')?.trim();
    let split = line.find(['：', ':'])?;
    let name = normalize_skill_name(line[..split].trim());
    (!name.is_empty()).then_some(name)
}

fn normalize_skill_name(value: &str) -> String {
    let mut name = value.trim();
    for _ in 0..2 {
        name = name.trim();
        name = name.strip_prefix("**").unwrap_or(name);
        name = name.strip_suffix("**").unwrap_or(name);
        name = name.trim_matches('`');
    }
    name.trim().to_string()
}

fn filter_recommended_skills(
    recommended: Vec<String>,
    installed_names: &HashSet<String>,
) -> Vec<String> {
    dedupe(
        recommended
            .into_iter()
            .map(|skill| normalize_skill_name(&skill))
            .filter(|skill| installed_names.contains(skill))
            .collect(),
    )
}

/// 正文兜底：解析开头的 <plan>...</plan> 锚点块（后端未升级时留在正文里）。
/// 返回（解析出的 plan JSON, 剥离锚点后的正文）；块缺省或无 goal 时原样返回。
fn extract_inline_plan(answer: &str) -> (Option<Value>, String) {
    let pattern = regex::Regex::new(r"(?is)^\s*<plan>(.*?)</plan>\s*")
        .expect("plan block regex is valid");
    let Some(captures) = pattern.captures(answer) else {
        return (None, answer.to_string());
    };
    let block = captures.get(1).map(|value| value.as_str()).unwrap_or("");
    let body = answer[captures.get(0).expect("full match").end()..].to_string();
    let Some(plan) = parse_plan_block(block) else {
        // 块存在但无有效 goal：仍剥离标签，避免残留污染正文。
        return (None, body);
    };
    (Some(plan), body)
}

/// 解析 <plan> 锚点块，兼容紧凑标签（<g><t><d>）与完整标签（<goal><title><done>），
/// 行为与服务端 promptcore parsePlanBlock 对齐。
fn parse_plan_block(block: &str) -> Option<Value> {
    let pick = |source: &str, tag: &str| -> String {
        regex::Regex::new(&format!(r"(?is)<{tag}>(.*?)</{tag}>"))
            .ok()
            .and_then(|pattern| {
                pattern
                    .captures(source)
                    .and_then(|captures| captures.get(1))
                    .map(|value| value.as_str().trim().to_string())
            })
            .unwrap_or_default()
    };
    let pick_all = |source: &str, tag: &str| -> Vec<String> {
        regex::Regex::new(&format!(r"(?is)<{tag}>(.*?)</{tag}>"))
            .map(|pattern| {
                pattern
                    .captures_iter(source)
                    .filter_map(|captures| captures.get(1))
                    .map(|value| value.as_str().trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut goal = pick(block, "g");
    if goal.is_empty() {
        goal = pick(block, "goal");
    }
    if goal.is_empty() {
        return None;
    }
    let mut stages = Vec::new();
    for stage_block in pick_all(block, "stage") {
        let mut title = pick(&stage_block, "t");
        if title.is_empty() {
            title = pick(&stage_block, "title");
        }
        let mut accept = pick_all(&stage_block, "d");
        if accept.is_empty() {
            accept = pick_all(&stage_block, "done");
        }
        if title.is_empty() && accept.is_empty() {
            continue;
        }
        stages.push(json!({
            "n": stages.len() + 1,
            "title": title,
            "accept": accept,
        }));
    }
    Some(json!({"goal": goal, "stages": stages}))
}

fn strip_thinking_markers(content: &str) -> String {
    let block = regex::Regex::new(r"(?is)<think\b[^>]*>.*?</think\s*>")
        .expect("think block regex is valid");
    let mut cleaned = block.replace_all(content, "").into_owned();

    let closing = regex::Regex::new(r"(?is)</think\b[^>]*>").expect("think close regex is valid");
    if let Some(marker) = closing.find_iter(&cleaned).last() {
        cleaned = cleaned[marker.end()..].to_string();
    }

    let tags = regex::Regex::new(r"(?is)</?think\b[^>]*>").expect("think tag regex is valid");
    tags.replace_all(&cleaned, "").trim().to_string()
}

fn non_empty_owned(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// 把 HTTP 失败字符串映射成稳定错误码；404 明确提示服务端尚未部署。
fn map_enhance_http_failure(error: String) -> (&'static str, String) {
    if error.contains("HTTP 404") {
        return (
            "NOT_DEPLOYED",
            "线上 YCE 服务尚未部署提示词增强端点（HTTP 404）。请等待服务端发布该能力后重试。"
                .to_string(),
        );
    }
    if error.contains("HTTP 401") || error.contains("HTTP 403") {
        return ("AUTH_ERROR", error);
    }
    if contains_quota(&error) {
        return ("QUOTA_EXCEEDED", error);
    }
    ("EXEC_ERROR", error)
}

fn contains_quota(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("quota")
        || lower.contains("payment required")
        || text.contains("额度")
        || text.contains("余额")
        || text.contains("充值")
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
    fn sse_parser_joins_data_lines_and_dispatches_on_blank_line() {
        let mut current_event = "message".to_string();
        let mut data_lines = Vec::new();
        let mut events = Vec::new();
        for line in ["event: agent4_chunk", "data: first", "data: second", ""] {
            parse_sse_line(line, &mut current_event, &mut data_lines, &mut events);
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "agent4_chunk");
        assert_eq!(events[0].data["raw"], "first\nsecond");
    }

    #[test]
    fn trigger_extraction_matches_legacy_description_labels() {
        assert_eq!(
            extract_triggers("触发词：Word、文档\nSmart triggers: docx, report."),
            ["Word", "文档", "docx", "report"]
        );
    }

    #[test]
    fn sse_parser_tolerates_missing_blank_line_before_next_event() {
        let mut current_event = "message".to_string();
        let mut data_lines = Vec::new();
        let mut events = Vec::new();
        for line in [
            "event: agent4_chunk",
            r#"data: {"chunk":"first"}"#,
            "event: agent4_chunk",
            r#"data: {"chunk":"second"}"#,
            "",
        ] {
            parse_sse_line(line, &mut current_event, &mut data_lines, &mut events);
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data["chunk"], "first");
        assert_eq!(events[1].data["chunk"], "second");
    }

    #[test]
    fn strips_complete_and_unmatched_think_markers() {
        assert_eq!(
            strip_thinking_markers("<think>private reasoning</think>final answer"),
            "final answer"
        );
        assert_eq!(
            strip_thinking_markers("private reasoning</think>推荐技能：\n- chrome-cdp：调试浏览器"),
            "推荐技能：\n- chrome-cdp：调试浏览器"
        );
    }

    #[test]
    fn inline_plan_fallback_parses_and_strips_the_anchor_block() {
        let answer = "<plan>\n<g>内联目标</g>\n<stage>\n<t>阶段一</t>\n<d>判据 A</d>\n<d>判据 B</d>\n</stage>\n</plan>\n增强正文";
        let (plan, body) = extract_inline_plan(answer);
        let plan = plan.expect("plan is parsed");
        assert_eq!(plan["goal"], "内联目标");
        assert_eq!(plan["stages"][0]["title"], "阶段一");
        assert_eq!(plan["stages"][0]["accept"][1], "判据 B");
        assert_eq!(body, "增强正文");

        let (none, untouched) = extract_inline_plan("普通正文，无锚点");
        assert!(none.is_none());
        assert_eq!(untouched, "普通正文，无锚点");
    }

    #[test]
    fn inline_plan_supports_full_tags_and_requires_goal() {
        let full = "<plan><goal>目标</goal><stage><title>T</title><done>D1</done></stage></plan>正文";
        let (plan, body) = extract_inline_plan(full);
        assert_eq!(plan.expect("parsed")["stages"][0]["accept"][0], "D1");
        assert_eq!(body, "正文");

        // 无 goal 的块：剥标签但不产出 plan
        let (missing, stripped) = extract_inline_plan("<plan><stage><t>x</t></stage></plan>正文");
        assert!(missing.is_none());
        assert_eq!(stripped, "正文");
    }

    #[test]
    fn parses_markdown_skill_names_and_filters_unknown_recommendations() {
        let (recommended, prompt) = parse_enhanced_content(
            "推荐技能：\n- **chrome-cdp**：调试浏览器\n- qa：测试\n增强提示词正文：\n请执行测试",
        );
        let installed = ["chrome-cdp".to_string()].into_iter().collect();
        assert_eq!(
            filter_recommended_skills(recommended, &installed),
            ["chrome-cdp"]
        );
        assert_eq!(prompt.as_deref(), Some("请执行测试"));
    }
}
