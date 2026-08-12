use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::RuntimeConfig;
use crate::error::ErrorItem;
use crate::model::{SearchDiagnostics, SearchResult};
use crate::tools::SearchArgs;

use super::executor::ToolExecutor;
use super::protobuf::ProtobufEncoder;
use super::relay::{build_metadata, RelayError, RelaySession, SearchTransport};
use super::repo_map::{build_repo_map, RepoMapOptions};
use super::response::{
    parse_answer, parse_stream_response, ParsedResponse, ParsedToolCall, RelevantFile,
};

const MAX_PROTO_BYTES: usize = 320 * 1024;
const MAX_COMPENSATED_TURNS: u8 = 2;
const FINAL_FORCE_ANSWER: &str =
    "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete.";

#[derive(Debug)]
struct ChatMessage {
    role: u64,
    content: String,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    tool_args_json: Option<String>,
    ref_call_id: Option<String>,
}

#[derive(Debug, Default)]
struct BootstrapHints {
    rg_patterns: Vec<String>,
    hot_dirs: Vec<String>,
}

impl ChatMessage {
    fn plain(role: u64, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_call_id: None,
            tool_name: None,
            tool_args_json: None,
            ref_call_id: None,
        }
    }
}

pub struct SearchOutcome {
    pub result: SearchResult,
    pub error: Option<ErrorItem>,
    pub duration_ms: u128,
}

#[derive(Clone)]
pub struct SearchEngine {
    transport: SearchTransport,
}

impl SearchEngine {
    pub fn new(config: &RuntimeConfig) -> Result<Self, RelayError> {
        Ok(Self {
            transport: SearchTransport::new(config)?,
        })
    }

    pub async fn search(
        &self,
        arguments: &SearchArgs,
        project_root: &Path,
        fallback_timeout: Duration,
    ) -> SearchOutcome {
        let started = Instant::now();
        let mut result = SearchResult {
            executed: true,
            query: arguments.query.clone(),
            ..SearchResult::default()
        };
        let timeout = arguments.timeout_search(fallback_timeout);
        let max_turns = arguments.max_turns.unwrap_or(3);
        let max_commands = arguments.max_commands.unwrap_or(8);
        let max_results = arguments.max_results.unwrap_or(10);
        let requested_tree_depth = arguments.tree_depth.unwrap_or(3);
        let repo_map_mode = arguments
            .repo_map_mode
            .as_deref()
            .unwrap_or("bootstrap_hotspot");
        let bootstrap_enabled = arguments.bootstrap_enabled.unwrap_or(true);
        let bootstrap_tree_depth = arguments.bootstrap_tree_depth.unwrap_or(1);
        let hotspot_top_k = arguments.hotspot_top_k.unwrap_or(4);
        let hotspot_tree_depth = arguments.hotspot_tree_depth.unwrap_or(2);
        let hotspot_max_bytes = arguments.hotspot_max_bytes.unwrap_or(120 * 1024);
        let bootstrap_max_turns = arguments.bootstrap_max_turns.unwrap_or(2);
        let bootstrap_max_commands = arguments.bootstrap_max_commands.unwrap_or(6);

        let mut executor = match ToolExecutor::new(project_root, &arguments.exclude) {
            Ok(executor) => executor,
            Err(error) => {
                return failed_outcome(
                    result,
                    "LOCAL_SEARCH_ERROR",
                    error.to_string(),
                    started.elapsed().as_millis(),
                )
            }
        };
        let mut repo_map = build_repo_map(
            executor.root(),
            executor.ignore_rules(),
            &RepoMapOptions {
                query: &arguments.query,
                requested_depth: requested_tree_depth,
                mode: repo_map_mode,
                bootstrap_tree_depth,
                hotspot_top_k,
                hotspot_tree_depth,
                hotspot_max_bytes,
                bootstrap_patterns: &[],
                bootstrap_hot_dirs: &[],
            },
        );
        let mut diagnostics = SearchDiagnostics {
            tree_depth: Some(repo_map.depth),
            requested_tree_depth: Some(requested_tree_depth),
            tree_size_kb: Some(((repo_map.size_bytes as f64 / 1024.0) * 10.0).round() / 10.0),
            fell_back: Some(repo_map.fell_back),
            auto_depth: Some(repo_map.auto_depth),
            context_trimmed: Some(false),
            repo_map_strategy: Some(repo_map.strategy.clone()),
            max_turns: Some(max_turns),
            max_commands: Some(max_commands),
            max_results: Some(max_results),
            timeout_ms: Some(timeout.as_millis().min(u128::from(u64::MAX)) as u64),
            bootstrap_enabled: Some(bootstrap_enabled),
            bootstrap_tree_depth: Some(bootstrap_tree_depth),
            hotspot_top_k: Some(hotspot_top_k),
            hotspot_tree_depth: Some(hotspot_tree_depth),
            hotspot_max_bytes: Some(hotspot_max_bytes),
            bootstrap_max_turns: Some(bootstrap_max_turns),
            bootstrap_max_commands: Some(bootstrap_max_commands),
            project_path: Some(project_root.display().to_string()),
            ignore_file: executor
                .ignore_rules()
                .source
                .as_ref()
                .map(|path| path.display().to_string()),
            hot_dirs: repo_map.hot_dirs.clone(),
            exclude_paths: arguments.exclude.clone(),
            ignore_patterns: executor.ignore_rules().patterns.clone(),
            ..SearchDiagnostics::default()
        };

        let mut session = match self.transport.begin_session().await {
            Ok(session) => session,
            Err(error) => {
                diagnostics.error_type = Some(error.code.clone());
                result.diagnostics = diagnostics;
                return failed_relay_outcome(result, error, started.elapsed().as_millis());
            }
        };
        if !self.transport.check_rate_limit(&session).await {
            match self
                .transport
                .replace_rate_limited_lease(&mut session)
                .await
            {
                Ok(()) if self.transport.check_rate_limit(&session).await => {}
                Ok(()) => {
                    self.transport.finish_session(&mut session).await;
                    diagnostics.error_type = Some("RATE_LIMITED".into());
                    result.diagnostics = diagnostics;
                    return failed_outcome(
                        result,
                        "RATE_LIMITED",
                        "Relay 提供的两个上游密钥都达到限额，请稍后重试。".into(),
                        started.elapsed().as_millis(),
                    );
                }
                Err(error) => {
                    self.transport.finish_session(&mut session).await;
                    diagnostics.error_type = Some(error.code.clone());
                    result.diagnostics = diagnostics;
                    return failed_relay_outcome(result, error, started.elapsed().as_millis());
                }
            }
        }

        let bootstrap_hints = if bootstrap_enabled {
            self.run_bootstrap(
                &mut session,
                &mut executor,
                &arguments.query,
                bootstrap_tree_depth,
                bootstrap_max_turns,
                bootstrap_max_commands,
                timeout,
            )
            .await
        } else {
            BootstrapHints::default()
        };
        if bootstrap_enabled {
            repo_map = build_repo_map(
                executor.root(),
                executor.ignore_rules(),
                &RepoMapOptions {
                    query: &arguments.query,
                    requested_depth: requested_tree_depth,
                    mode: repo_map_mode,
                    bootstrap_tree_depth,
                    hotspot_top_k,
                    hotspot_tree_depth,
                    hotspot_max_bytes,
                    bootstrap_patterns: &bootstrap_hints.rg_patterns,
                    bootstrap_hot_dirs: &bootstrap_hints.hot_dirs,
                },
            );
            diagnostics.tree_depth = Some(repo_map.depth);
            diagnostics.tree_size_kb =
                Some(((repo_map.size_bytes as f64 / 1024.0) * 10.0).round() / 10.0);
            diagnostics.fell_back = Some(repo_map.fell_back);
            diagnostics.auto_depth = Some(repo_map.auto_depth);
            diagnostics.repo_map_strategy = Some(repo_map.strategy.clone());
            diagnostics.hot_dirs = repo_map.hot_dirs.clone();
        }

        let system_prompt = build_system_prompt(max_turns, max_commands, max_results);
        let user_prompt = format!(
            "Problem Statement: {}\n\nRepo Map (tree -L {} /codebase):\n```text\n{}\n```",
            arguments.query, repo_map.depth, repo_map.tree
        );
        let mut messages = vec![
            ChatMessage::plain(5, system_prompt),
            ChatMessage::plain(1, user_prompt),
        ];
        let tool_definitions = build_tool_definitions(max_commands);
        let mut compensated_turns = 0_u8;
        let mut force_answer_injected = false;
        let mut final_files = Vec::new();
        let mut raw_response = None;
        let mut search_error: Option<RelayError> = None;
        let total_api_calls = max_turns + 1;
        let mut turn = 0_u8;

        'turns: while turn < total_api_calls.saturating_add(compensated_turns) {
            turn += 1;
            diagnostics.turns_used = Some(turn);
            let mut credential_retry = 0_u8;
            let response = loop {
                if let Err(error) = self.transport.prepare_call(&mut session).await {
                    search_error = Some(error);
                    break 'turns;
                }
                let (api_key, jwt) = self.transport.credentials(&session);
                let mut request = build_request(api_key, jwt, &messages, &tool_definitions);
                if request.len() > MAX_PROTO_BYTES && trim_messages(&mut messages, &arguments.query)
                {
                    diagnostics.context_trimmed = Some(true);
                    let (api_key, jwt) = self.transport.credentials(&session);
                    request = build_request(api_key, jwt, &messages, &tool_definitions);
                }
                if request.len() > MAX_PROTO_BYTES {
                    search_error = Some(RelayError {
                        code: "PAYLOAD_TOO_LARGE".into(),
                        message: format!(
                            "裁剪后请求仍有 {} 字节，超过 {} 字节安全线。",
                            request.len(),
                            MAX_PROTO_BYTES
                        ),
                        source: "yce-engine".into(),
                        status: None,
                        retryable: false,
                    });
                    break 'turns;
                }
                match self.transport.stream(&mut session, &request, timeout).await {
                    Ok(response) => break response,
                    Err(error)
                        if credential_retry == 0
                            && (is_lease_lifecycle_error(&error)
                                || error.code == "TRANSIENT_CAPACITY") =>
                    {
                        let exclude_current = error.code == "TRANSIENT_CAPACITY";
                        if let Err(replacement_error) = self
                            .transport
                            .replace_failed_lease(&mut session, &error, exclude_current)
                            .await
                        {
                            search_error = Some(replacement_error);
                            break 'turns;
                        }
                        credential_retry += 1;
                    }
                    Err(error) => {
                        search_error = Some(error);
                        break 'turns;
                    }
                }
            };
            match parse_stream_response(&response) {
                Ok(ParsedResponse::ToolCall(call)) if call.name == "answer" => {
                    let answer = call
                        .arguments
                        .get("answer")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    final_files = parse_answer(answer, project_root, usize::from(max_results));
                    break;
                }
                Ok(ParsedResponse::ToolCall(call)) if call.name == "restricted_exec" => {
                    let valid_commands = ToolExecutor::valid_command_count(
                        &call.arguments,
                        usize::from(max_commands),
                    );
                    if valid_commands == 0 && compensated_turns < MAX_COMPENSATED_TURNS {
                        compensated_turns += 1;
                    }
                    let tool_result =
                        executor.execute_tool_call(&call.arguments, usize::from(max_commands));
                    append_tool_exchange(&mut messages, call, tool_result);
                    let effective_turn = turn.saturating_sub(compensated_turns);
                    if effective_turn >= max_turns && !force_answer_injected {
                        messages.push(ChatMessage::plain(1, FINAL_FORCE_ANSWER));
                        force_answer_injected = true;
                    }
                }
                Ok(ParsedResponse::ToolCall(call)) => {
                    search_error = Some(RelayError {
                        code: "INVALID_TOOL_CALL".into(),
                        message: format!("远端模型调用了未允许的工具：{}", call.name),
                        source: "upstream".into(),
                        status: None,
                        retryable: false,
                    });
                    break;
                }
                Ok(ParsedResponse::RemoteError { code, message }) => {
                    search_error = Some(RelayError {
                        code,
                        message,
                        source: "upstream".into(),
                        status: None,
                        retryable: false,
                    });
                    break;
                }
                Ok(ParsedResponse::Text(text)) => {
                    raw_response = Some(text);
                    break;
                }
                Err(error) => {
                    search_error = Some(RelayError {
                        code: "PARSE_ERROR".into(),
                        message: error.to_string(),
                        source: "yce-engine".into(),
                        status: None,
                        retryable: false,
                    });
                    break;
                }
            }
        }
        self.transport.finish_session(&mut session).await;

        let patterns = executor.collected_rg_patterns();
        if let Some(error) = search_error {
            diagnostics.error_type = Some(error.code.clone());
            result.diagnostics = diagnostics;
            return failed_relay_outcome(result, error, started.elapsed().as_millis());
        }
        result.success = true;
        result.result_present = !final_files.is_empty() || !patterns.is_empty();
        result.empty_result = !result.result_present;
        result.raw_stdout = format_search_output(&final_files, &patterns, raw_response.as_deref());
        result.diagnostics = diagnostics;
        SearchOutcome {
            result,
            error: None,
            duration_ms: started.elapsed().as_millis(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_bootstrap(
        &self,
        session: &mut RelaySession,
        executor: &mut ToolExecutor,
        query: &str,
        tree_depth: u8,
        max_turns: u8,
        max_commands: u8,
        timeout: Duration,
    ) -> BootstrapHints {
        let mini_map = build_repo_map(
            executor.root(),
            executor.ignore_rules(),
            &RepoMapOptions {
                query,
                requested_depth: tree_depth,
                mode: "classic",
                bootstrap_tree_depth: tree_depth,
                hotspot_top_k: 0,
                hotspot_tree_depth: 1,
                hotspot_max_bytes: 64 * 1024,
                bootstrap_patterns: &[],
                bootstrap_hot_dirs: &[],
            },
        );
        let mut messages = vec![
            ChatMessage::plain(
                5,
                format!(
                    r#"You are a bootstrap planning agent for codebase hotspot discovery.
Use restricted_exec only. Prefer rg and tree. Do not return a final ANSWER.
Discover high-signal search patterns and top-level directories for the later full search.
You have at most {max_turns} turns and {max_commands} commands per turn."#
                ),
            ),
            ChatMessage::plain(
                1,
                format!(
                    "Problem Statement: {query}\n\nMini Repo Map:\n```text\n{}\n```",
                    mini_map.tree
                ),
            ),
        ];
        let tool_definitions = build_tool_definitions(max_commands);
        let mut hints = BootstrapHints::default();
        for _ in 0..max_turns {
            if self.transport.prepare_call(session).await.is_err() {
                break;
            }
            let (api_key, jwt) = self.transport.credentials(session);
            let request = build_request(api_key, jwt, &messages, &tool_definitions);
            if request.len() > MAX_PROTO_BYTES {
                break;
            }
            let Ok(response) = self.transport.stream(session, &request, timeout).await else {
                break;
            };
            let Ok(ParsedResponse::ToolCall(call)) = parse_stream_response(&response) else {
                break;
            };
            if call.name != "restricted_exec" {
                break;
            }
            collect_bootstrap_hints(&call.arguments, &mut hints, usize::from(max_commands));
            let tool_result =
                executor.execute_tool_call(&call.arguments, usize::from(max_commands));
            append_tool_exchange(&mut messages, call, tool_result);
        }
        hints.rg_patterns.truncate(30);
        hints.hot_dirs.truncate(12);
        hints
    }
}

fn is_lease_lifecycle_error(error: &RelayError) -> bool {
    error.source == "relay"
        && [
            "LEASE_REQUIRED",
            "LEASE_INVALID",
            "LEASE_INACTIVE",
            "LEASE_EXPIRED",
            "LEASE_CALL_LIMIT",
        ]
        .contains(&error.code.as_str())
}

fn collect_bootstrap_hints(arguments: &Value, hints: &mut BootstrapHints, max_commands: usize) {
    let Some(commands) = arguments.as_object() else {
        return;
    };
    let mut keys = commands
        .keys()
        .filter(|key| key.starts_with("command"))
        .collect::<Vec<_>>();
    keys.sort();
    for key in keys.into_iter().take(max_commands) {
        let command = &commands[key];
        match command.get("type").and_then(Value::as_str) {
            Some("rg") => {
                if let Some(pattern) = command.get("pattern").and_then(Value::as_str) {
                    if !pattern.is_empty() && !hints.rg_patterns.iter().any(|item| item == pattern)
                    {
                        hints.rg_patterns.push(pattern.to_string());
                    }
                }
            }
            Some("tree") => {
                if let Some(path) = command.get("path").and_then(Value::as_str) {
                    if let Some(relative) = path.strip_prefix("/codebase/") {
                        if let Some(top) =
                            relative.split('/').next().filter(|item| !item.is_empty())
                        {
                            if !hints.hot_dirs.iter().any(|item| item == top) {
                                hints.hot_dirs.push(top.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn append_tool_exchange(
    messages: &mut Vec<ChatMessage>,
    call: ParsedToolCall,
    tool_result: String,
) {
    let call_id = Uuid::new_v4().to_string();
    messages.push(ChatMessage {
        role: 2,
        content: call.thinking,
        tool_call_id: Some(call_id.clone()),
        tool_name: Some("restricted_exec".into()),
        tool_args_json: Some(call.arguments.to_string()),
        ref_call_id: None,
    });
    messages.push(ChatMessage {
        role: 4,
        content: tool_result,
        tool_call_id: None,
        tool_name: None,
        tool_args_json: None,
        ref_call_id: Some(call_id),
    });
}

fn build_request(
    api_key: &str,
    jwt: &str,
    messages: &[ChatMessage],
    tool_definitions: &str,
) -> Vec<u8> {
    let mut request = ProtobufEncoder::new();
    request.write_message(1, &build_metadata(api_key, jwt));
    for message in messages {
        let mut encoded = ProtobufEncoder::new();
        encoded
            .write_varint(2, message.role)
            .write_string(3, &message.content);
        if let (Some(call_id), Some(name), Some(arguments)) = (
            message.tool_call_id.as_deref(),
            message.tool_name.as_deref(),
            message.tool_args_json.as_deref(),
        ) {
            let mut call = ProtobufEncoder::new();
            call.write_string(1, call_id)
                .write_string(2, name)
                .write_string(3, arguments);
            encoded.write_message(6, &call);
        }
        if let Some(reference) = message.ref_call_id.as_deref() {
            encoded.write_string(7, reference);
        }
        request.write_message(2, &encoded);
    }
    request.write_string(3, tool_definitions);
    request.into_bytes()
}

fn trim_messages(messages: &mut Vec<ChatMessage>, query: &str) -> bool {
    if messages.len() <= 4 {
        if let Some(user) = messages.get_mut(1) {
            let compact = format!(
                "Problem Statement: {query}\n\nRepo Map: (omitted to reduce payload). Use tree/rg to inspect the project."
            );
            if compact.len() < user.content.len() {
                user.content = compact;
                return true;
            }
        }
        return false;
    }
    let system = messages.remove(0);
    let mut user = messages.remove(0);
    user.content = format!(
        "Problem Statement: {query}\n\nRepo Map: (omitted to reduce payload). Use tree/rg to inspect the project."
    );
    let tail_start = messages.len().saturating_sub(3);
    let mut tail = messages.split_off(tail_start);
    for message in &mut tail {
        let limit = if message.role == 4 { 20_000 } else { 8_000 };
        if message.content.len() > limit {
            message.content.truncate(limit);
            message.content.push_str("\n...[context truncated]...");
        }
    }
    *messages = vec![
        system,
        user,
        ChatMessage::plain(
            1,
            "[Context trimmed to reduce payload size. Continue from the latest tool results.]",
        ),
    ];
    messages.extend(tail);
    true
}

fn format_search_output(
    files: &[RelevantFile],
    patterns: &[String],
    raw_response: Option<&str>,
) -> String {
    if files.is_empty() && patterns.is_empty() {
        let raw = raw_response.unwrap_or_default();
        if raw.trim().is_empty() {
            return "No relevant files found.".into();
        }
        return format!(
            "No relevant files found.\n\nRaw response:\n{}",
            raw.chars().take(500).collect::<String>()
        );
    }
    let mut lines = if files.is_empty() {
        vec!["No files found.".into()]
    } else {
        vec![
            format!("Found {} relevant files.", files.len()),
            String::new(),
        ]
    };
    for (index, file) in files.iter().enumerate() {
        let ranges = file
            .ranges
            .iter()
            .map(|(start, end)| format!("L{start}-{end}"))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  [{}/{}] {} ({ranges})",
            index + 1,
            files.len(),
            file.path.display()
        ));
    }
    if !patterns.is_empty() {
        lines.push(String::new());
        lines.push(format!("grep keywords: {}", patterns.join(", ")));
    }
    lines.join("\n")
}

fn failed_outcome(
    mut result: SearchResult,
    code: &str,
    message: String,
    duration_ms: u128,
) -> SearchOutcome {
    result.success = false;
    result.raw_stdout = format!("Error: {code}: {message}");
    SearchOutcome {
        result,
        error: Some(ErrorItem::new("yce-search", code, message)),
        duration_ms,
    }
}

fn failed_relay_outcome(
    result: SearchResult,
    error: RelayError,
    duration_ms: u128,
) -> SearchOutcome {
    let source = if error.source.is_empty() {
        "yce-search".to_string()
    } else {
        error.source.clone()
    };
    let code = error.code.clone();
    let message = error.message.clone();
    let mut outcome = failed_outcome(result, &code, message, duration_ms);
    outcome.error = Some(ErrorItem::new(source, code, error.message));
    outcome
}

fn build_tool_definitions(max_commands: u8) -> String {
    let mut properties = serde_json::Map::new();
    for index in 1..=max_commands {
        properties.insert(
            format!("command{index}"),
            json!({
                "type":"object",
                "oneOf":[
                    {
                        "properties":{
                            "type":{"type":"string","const":"rg"},
                            "pattern":{"type":"string"},
                            "path":{"type":"string"},
                            "include":{"type":"array","items":{"type":"string"}},
                            "exclude":{"type":"array","items":{"type":"string"}}
                        },
                        "required":["type","pattern","path"]
                    },
                    {
                        "properties":{
                            "type":{"type":"string","const":"readfile"},
                            "file":{"type":"string"},
                            "start_line":{"type":"integer"},
                            "end_line":{"type":"integer"}
                        },
                        "required":["type","file"]
                    },
                    {
                        "properties":{
                            "type":{"type":"string","const":"tree"},
                            "path":{"type":"string"},
                            "levels":{"type":"integer"}
                        },
                        "required":["type","path"]
                    },
                    {
                        "properties":{
                            "type":{"type":"string","const":"ls"},
                            "path":{"type":"string"},
                            "long_format":{"type":"boolean"},
                            "all":{"type":"boolean"}
                        },
                        "required":["type","path"]
                    },
                    {
                        "properties":{
                            "type":{"type":"string","const":"glob"},
                            "pattern":{"type":"string"},
                            "path":{"type":"string"},
                            "type_filter":{"type":"string","enum":["file","directory","all"]}
                        },
                        "required":["type","pattern","path"]
                    }
                ]
            }),
        );
    }
    json!([
        {
            "type":"function",
            "function":{
                "name":"restricted_exec",
                "description":"Execute restricted local codebase commands without shell access.",
                "parameters":{
                    "type":"object",
                    "properties":properties,
                    "required":["command1"]
                }
            }
        },
        {
            "type":"function",
            "function":{
                "name":"answer",
                "description":"Return the relevant files and inclusive line ranges.",
                "parameters":{
                    "type":"object",
                    "properties":{"answer":{"type":"string"}},
                    "required":["answer"]
                }
            }
        }
    ])
    .to_string()
}

fn build_system_prompt(max_turns: u8, max_commands: u8, max_results: u8) -> String {
    format!(
        r#"You are an expert software engineer responsible for locating all code context needed to solve the user's issue.

Return only relevant files and complete semantic blocks. Do not invent paths.

# Environment
- Working directory: /codebase
- Use the restricted_exec tool only.
- Allowed command types: rg, readfile, tree, ls, glob.
- Every path must stay under /codebase.
- You may issue at most {max_commands} commands in one restricted_exec call.
- You have at most {max_turns} search turns.

# Search rules
- Start narrow, then widen only when evidence requires it.
- Prefer reading a located file over repeating similar searches.
- Exclude generated, vendored, dependency and build output unless directly relevant.
- If no relevant files exist, return an empty ANSWER rather than unrelated files.
- Aim for no more than {max_results} files.

# Final answer
Call the answer tool with this exact XML structure:
<ANSWER>
  <file path="/codebase/src/example.rs">
    <range>10-80</range>
  </file>
</ANSWER>
Ranges are 1-based and inclusive."#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_contains_metadata_messages_and_tool_definitions() {
        let messages = vec![
            ChatMessage::plain(5, "system"),
            ChatMessage::plain(1, "user"),
        ];
        let request = build_request("a".repeat(32).as_str(), "eyJ.x.y", &messages, "[]");
        assert!(!request.is_empty());
        assert!(request
            .windows(b"system".len())
            .any(|window| window == b"system"));
        assert!(request
            .windows(b"eyJ.x.y".len())
            .any(|window| window == b"eyJ.x.y"));
    }

    #[test]
    fn tool_schema_has_bounded_number_of_commands() {
        let value: Value = serde_json::from_str(&build_tool_definitions(3)).unwrap();
        let properties = &value[0]["function"]["parameters"]["properties"];
        assert!(properties.get("command1").is_some());
        assert!(properties.get("command3").is_some());
        assert!(properties.get("command4").is_none());
    }
}
