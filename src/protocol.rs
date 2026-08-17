use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};

use crate::error::YceError;
use crate::orchestrator::{ExecuteOutput, YceService};
use crate::tools::tool_definitions;

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "yce";
const MAX_REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq)]
enum RequestId {
    Notification,
    Request(Value),
}

#[derive(Debug, PartialEq)]
struct JsonRpcRequest {
    id: RequestId,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, PartialEq)]
struct JsonRpcResponseMessage {
    id: Value,
    result: Option<Value>,
    error: Option<Value>,
}

#[derive(Debug, PartialEq)]
enum IncomingMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponseMessage),
}

#[derive(Debug, PartialEq)]
struct RpcError {
    id: Value,
    code: i32,
    message: String,
}

#[cfg(test)]
fn parse_request(frame: &str) -> Result<JsonRpcRequest, RpcError> {
    let value: Value = serde_json::from_str(frame).map_err(|error| RpcError {
        id: Value::Null,
        code: -32700,
        message: format!("Parse error: {error}"),
    })?;
    parse_request_value(value)
}

fn parse_request_value(value: Value) -> Result<JsonRpcRequest, RpcError> {
    let object = value.as_object().ok_or_else(invalid_request)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(invalid_request());
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.is_empty())
        .ok_or_else(invalid_request)?
        .to_string();
    let id = match object.get("id") {
        None => RequestId::Notification,
        Some(value) if value.is_null() || value.is_string() || value.is_number() => {
            RequestId::Request(value.clone())
        }
        Some(_) => return Err(invalid_request()),
    };
    if let Some(params) = object.get("params") {
        if !params.is_object() && !params.is_array() && !params.is_null() {
            return Err(invalid_request());
        }
    }
    Ok(JsonRpcRequest {
        id,
        method,
        params: object.get("params").cloned(),
    })
}

fn parse_message(frame: &str) -> Result<IncomingMessage, RpcError> {
    let value: Value = serde_json::from_str(frame).map_err(|error| RpcError {
        id: Value::Null,
        code: -32700,
        message: format!("Parse error: {error}"),
    })?;
    let object = value.as_object().ok_or_else(invalid_request)?;
    if object.contains_key("method") {
        return parse_request_value(value).map(IncomingMessage::Request);
    }

    let id = object.get("id").cloned().ok_or_else(invalid_request)?;
    if !id.is_null() && !id.is_string() && !id.is_number() {
        return Err(invalid_request());
    }
    if !object.contains_key("result") && !object.contains_key("error") {
        return Err(invalid_request());
    }
    Ok(IncomingMessage::Response(JsonRpcResponseMessage {
        id,
        result: object.get("result").cloned(),
        error: object.get("error").cloned(),
    }))
}

fn invalid_request() -> RpcError {
    RpcError {
        id: Value::Null,
        code: -32600,
        message: "Invalid Request".into(),
    }
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }

    fn from_rpc_error(error: RpcError) -> Self {
        Self::error(error.id, error.code, error.message)
    }
}

fn encode_response(response: JsonRpcResponse) -> serde_json::Result<String> {
    let mut frame = serde_json::to_string(&response)?;
    frame.push('\n');
    Ok(frame)
}

fn encode_server_request(id: &Value, method: &str) -> serde_json::Result<String> {
    let mut frame = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": {}
    }))?;
    frame.push('\n');
    Ok(frame)
}

#[derive(Debug)]
struct PendingTool {
    id: Value,
    name: String,
    arguments: Value,
    roots_request_id: Value,
}

pub struct McpServer {
    service: Arc<YceService>,
    default_cwd: Option<PathBuf>,
    client_supports_roots: bool,
    roots: Option<Vec<PathBuf>>,
    pending_tool: Option<PendingTool>,
    next_roots_request_id: u64,
}

impl McpServer {
    pub fn new(service: Arc<YceService>, default_cwd: Option<PathBuf>) -> Self {
        Self {
            service,
            default_cwd,
            client_supports_roots: false,
            roots: None,
            pending_tool: None,
            next_roots_request_id: 1,
        }
    }

    pub async fn process_frame(&mut self, frame: &str) -> anyhow::Result<Vec<String>> {
        if frame.len() > MAX_REQUEST_BYTES {
            return Ok(vec![encode_response(JsonRpcResponse::error(
                Value::Null,
                -32600,
                format!("请求超过 {MAX_REQUEST_BYTES} 字节限制。"),
            ))?]);
        }
        let message = match parse_message(frame) {
            Ok(message) => message,
            Err(error) => {
                return Ok(vec![encode_response(JsonRpcResponse::from_rpc_error(
                    error,
                ))?]);
            }
        };

        match message {
            IncomingMessage::Request(request) => match request.id {
                RequestId::Notification => {
                    self.handle_notification(&request.method);
                    Ok(Vec::new())
                }
                RequestId::Request(id) => {
                    self.handle_request(id, &request.method, request.params)
                        .await
                }
            },
            IncomingMessage::Response(response) => self.handle_client_response(response).await,
        }
    }

    fn handle_notification(&mut self, method: &str) {
        if method == "notifications/roots/list_changed" {
            self.roots = None;
        }
    }

    async fn handle_request(
        &mut self,
        id: Value,
        method: &str,
        params: Option<Value>,
    ) -> anyhow::Result<Vec<String>> {
        match method {
            "initialize" => {
                self.client_supports_roots = params
                    .as_ref()
                    .and_then(|params| params.get("capabilities"))
                    .and_then(Value::as_object)
                    .and_then(|capabilities| capabilities.get("roots"))
                    .and_then(Value::as_object)
                    .is_some();
                self.roots = None;
                Ok(vec![encode_response(JsonRpcResponse::success(
                    id,
                    json!({
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {
                            "name": SERVER_NAME,
                            "version": env!("CARGO_PKG_VERSION")
                        },
                        "instructions": crate::consume::MCP_INSTRUCTIONS
                    }),
                ))?])
            }
            "ping" => Ok(vec![encode_response(JsonRpcResponse::success(
                id,
                json!({}),
            ))?]),
            "tools/list" => Ok(vec![encode_response(JsonRpcResponse::success(
                id,
                json!({"tools": tool_definitions(self.service.enable_plan())}),
            ))?]),
            "tools/call" => self.handle_tool_call(id, params).await,
            _ => Ok(vec![encode_response(JsonRpcResponse::error(
                id,
                -32601,
                format!("Method not found: {method}"),
            ))?]),
        }
    }

    async fn handle_tool_call(
        &mut self,
        id: Value,
        params: Option<Value>,
    ) -> anyhow::Result<Vec<String>> {
        let Some(params) = params else {
            return Ok(vec![encode_response(JsonRpcResponse::error(
                id,
                -32602,
                "Missing tools/call params",
            ))?]);
        };
        let call: ToolCallParams = match serde_json::from_value(params) {
            Ok(call) => call,
            Err(error) => {
                return Ok(vec![encode_response(JsonRpcResponse::error(
                    id,
                    -32602,
                    format!("Invalid tools/call params: {error}"),
                ))?]);
            }
        };
        let mut known_tools = vec![
            "search_code",
            "auto",
            "enhance_prompt",
            "search_network",
            "task_show",
            "task_update",
        ];
        if self.service.enable_plan() {
            known_tools.insert(4, "y_plan");
        }
        if !known_tools.contains(&call.name.as_str()) {
            return Ok(vec![encode_response(JsonRpcResponse::error(
                id,
                -32602,
                format!("Unknown tool: {}", call.name),
            ))?]);
        }

        if let Err(YceError::InvalidArguments(message)) =
            crate::tools::ToolCall::decode(&call.name, call.arguments.clone())
        {
            return Ok(vec![encode_response(JsonRpcResponse::error(
                id, -32602, message,
            ))?]);
        }

        let needs_project = matches!(
            call.name.as_str(),
            "search_code" | "auto" | "task_show" | "task_update"
        ) && call.arguments.get("cwd").is_none_or(Value::is_null)
            && self.default_cwd.is_none();

        if needs_project {
            if let Some(root) = self.selected_root().cloned() {
                let response = self
                    .execute_tool(id, call.name, call.arguments, Some(&root))
                    .await;
                return Ok(vec![encode_response(response)?]);
            }
            if !self.client_supports_roots {
                return Ok(vec![encode_response(JsonRpcResponse::error(
                    id,
                    -32602,
                    "代码检索需要项目目录；请配置 YCE_MCP_DEFAULT_CWD，或让客户端声明 MCP roots。",
                ))?]);
            }
            if self.pending_tool.is_some() {
                return Ok(vec![encode_response(JsonRpcResponse::error(
                    id,
                    -32000,
                    "正在等待客户端提供工作区目录，请稍后重试。",
                ))?]);
            }

            let roots_request_id =
                Value::String(format!("yce-roots-{}", self.next_roots_request_id));
            self.next_roots_request_id = self.next_roots_request_id.saturating_add(1);
            self.pending_tool = Some(PendingTool {
                id,
                name: call.name,
                arguments: call.arguments,
                roots_request_id: roots_request_id.clone(),
            });
            return Ok(vec![encode_server_request(
                &roots_request_id,
                "roots/list",
            )?]);
        }

        // enhance_prompt 等 cwd 可选的工具：客户端此前已通过 roots/list 提供过
        // 唯一工作区时，用它作为回退目录（任务卡建卡需要项目目录）。
        let fallback_cwd = self
            .default_cwd
            .clone()
            .or_else(|| self.selected_root().cloned());
        let response = self
            .execute_tool(id, call.name, call.arguments, fallback_cwd.as_deref())
            .await;
        Ok(vec![encode_response(response)?])
    }

    fn selected_root(&self) -> Option<&PathBuf> {
        self.roots.as_deref().and_then(select_single_root)
    }

    async fn handle_client_response(
        &mut self,
        response: JsonRpcResponseMessage,
    ) -> anyhow::Result<Vec<String>> {
        let Some(pending) = self.pending_tool.take() else {
            return Ok(Vec::new());
        };
        if response.id != pending.roots_request_id {
            self.pending_tool = Some(pending);
            return Ok(Vec::new());
        }

        let roots = match response.error {
            Some(error) => {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("客户端拒绝提供工作区目录");
                return Ok(vec![encode_response(JsonRpcResponse::error(
                    pending.id,
                    -32602,
                    format!("无法从 MCP 客户端获取工作区：{message}"),
                ))?]);
            }
            None => match parse_roots(response.result.as_ref()) {
                Ok(roots) => roots,
                Err(message) => {
                    return Ok(vec![encode_response(JsonRpcResponse::error(
                        pending.id,
                        -32602,
                        format!("客户端 roots/list 响应无效：{message}"),
                    ))?]);
                }
            },
        };
        self.roots = Some(roots);
        let Some(root) = self.selected_root().cloned() else {
            let message = self
                .roots
                .as_ref()
                .map(|roots| {
                    if roots.is_empty() {
                        "客户端没有提供可用工作区目录".to_string()
                    } else {
                        format!(
                            "客户端提供了多个工作区，请在工具参数中明确传 cwd：{}",
                            roots
                                .iter()
                                .map(|root| root.display().to_string())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    }
                })
                .unwrap_or_else(|| "客户端没有提供可用工作区目录".to_string());
            return Ok(vec![encode_response(JsonRpcResponse::error(
                pending.id, -32602, message,
            ))?]);
        };

        let response = self
            .execute_tool(pending.id, pending.name, pending.arguments, Some(&root))
            .await;
        Ok(vec![encode_response(response)?])
    }

    async fn execute_tool(
        &self,
        id: Value,
        name: String,
        arguments: Value,
        default_cwd: Option<&Path>,
    ) -> JsonRpcResponse {
        match self.service.execute(&name, arguments, default_cwd).await {
            Ok(output) => JsonRpcResponse::success(id, tool_result(output)),
            Err(YceError::InvalidArguments(message)) => JsonRpcResponse::error(id, -32602, message),
            Err(YceError::Tool(error)) => JsonRpcResponse::success(
                id,
                tool_result(ExecuteOutput {
                    text: format!("{}: {}", error.code, error.message),
                    is_error: true,
                }),
            ),
            Err(YceError::Configuration(message)) => JsonRpcResponse::success(
                id,
                tool_result(ExecuteOutput {
                    text: message,
                    is_error: true,
                }),
            ),
            Err(YceError::Internal(message)) => {
                JsonRpcResponse::error(id, -32603, format!("Internal error: {message}"))
            }
        }
    }
}

fn parse_roots(result: Option<&Value>) -> Result<Vec<PathBuf>, String> {
    let roots = result
        .and_then(|result| result.get("roots"))
        .and_then(Value::as_array)
        .ok_or_else(|| "响应缺少 roots 数组".to_string())?;
    let mut paths = Vec::with_capacity(roots.len());
    for root in roots {
        let uri = root
            .get("uri")
            .and_then(Value::as_str)
            .ok_or_else(|| "roots 项缺少 uri 字段".to_string())?;
        let path = file_uri_to_path(uri)?;
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("工作区不存在或无法访问 {}：{error}", path.display()))?;
        if !canonical.is_dir() {
            return Err(format!("工作区不是目录：{}", canonical.display()));
        }
        paths.push(canonical);
    }
    Ok(paths)
}

fn select_single_root(roots: &[PathBuf]) -> Option<&PathBuf> {
    (roots.len() == 1).then(|| &roots[0])
}

fn file_uri_to_path(uri: &str) -> Result<PathBuf, String> {
    let raw = uri
        .strip_prefix("file://localhost")
        .or_else(|| uri.strip_prefix("file://"))
        .ok_or_else(|| format!("只支持 file:// 工作区 URI：{uri}"))?;
    let decoded = percent_decode(raw)?;
    #[cfg(windows)]
    let decoded = decoded
        .strip_prefix('/')
        .filter(|path| path.as_bytes().get(1) == Some(&b':'))
        .unwrap_or(&decoded)
        .to_string();
    let path = PathBuf::from(decoded);
    if !path.is_absolute() {
        return Err(format!("工作区 URI 必须指向绝对路径：{uri}"));
    }
    Ok(path)
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(format!("URI 百分号编码不完整：{value}"));
            }
            let high = hex_digit(bytes[index + 1])
                .ok_or_else(|| format!("URI 百分号编码无效：{value}"))?;
            let low = hex_digit(bytes[index + 2])
                .ok_or_else(|| format!("URI 百分号编码无效：{value}"))?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| format!("URI 不是有效 UTF-8：{value}"))
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCallParams {
    name: String,
    #[serde(default = "empty_arguments")]
    arguments: Value,
    // MCP clients such as Codex may attach protocol metadata here. It is not
    // part of the tool arguments and must not make an otherwise valid call
    // fail validation.
    #[serde(rename = "_meta", default)]
    _meta: Option<Value>,
}

fn empty_arguments() -> Value {
    json!({})
}

fn tool_result(output: ExecuteOutput) -> Value {
    if output.is_error {
        json!({
            "content": [{"type":"text","text":output.text}],
            "isError": true
        })
    } else {
        json!({"content":[{"type":"text","text":output.text}]})
    }
}

pub async fn run_stdio(mut server: McpServer) -> anyhow::Result<()> {
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = BufWriter::new(tokio::io::stdout());
    while let Some(frame) = input
        .next_line()
        .await
        .context("读取 stdin JSON-RPC 帧失败")?
    {
        if frame.trim().is_empty() {
            continue;
        }
        match server.process_frame(&frame).await {
            Ok(responses) => {
                for response in responses {
                    output
                        .write_all(response.as_bytes())
                        .await
                        .context("写入 stdout JSON-RPC 帧失败")?;
                }
                output.flush().await.context("刷新 stdout 失败")?;
            }
            Err(error) => {
                let response = encode_response(JsonRpcResponse::error(
                    Value::Null,
                    -32603,
                    format!("Internal error: {error}"),
                ))?;
                output.write_all(response.as_bytes()).await?;
                output.flush().await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_without_losing_string_id() {
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":"request-7","method":"tools/list","params":{}}"#,
        )
        .unwrap();
        assert_eq!(request.id, RequestId::Request(json!("request-7")));
        assert_eq!(request.method, "tools/list");
    }

    #[test]
    fn malformed_and_invalid_requests_use_standard_codes() {
        assert_eq!(parse_request("{").unwrap_err().code, -32700);
        assert_eq!(
            parse_request(r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#)
                .unwrap_err()
                .code,
            -32600
        );
    }

    #[test]
    fn response_is_exactly_one_json_line() {
        let frame =
            encode_response(JsonRpcResponse::success(json!(1), json!({"ok":true}))).unwrap();
        assert!(frame.ends_with('\n'));
        assert_eq!(frame.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(frame.trim()).unwrap()["result"]["ok"],
            true
        );
    }

    #[test]
    fn parses_client_response_without_treating_it_as_a_request() {
        let message =
            parse_message(r#"{"jsonrpc":"2.0","id":"yce-roots-1","result":{"roots":[]}}"#).unwrap();
        assert_eq!(
            message,
            IncomingMessage::Response(JsonRpcResponseMessage {
                id: json!("yce-roots-1"),
                result: Some(json!({"roots": []})),
                error: None,
            })
        );
    }

    #[test]
    fn rejects_response_ids_that_are_not_json_rpc_scalars() {
        let error =
            parse_message(r#"{"jsonrpc":"2.0","id":{"not":"allowed"},"result":{}}"#).unwrap_err();
        assert_eq!(error.code, -32600);
    }

    #[test]
    fn decodes_file_uri_and_percent_encoded_path() {
        let path = file_uri_to_path("file:///tmp/yce%20workspace").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/yce workspace"));
        let localhost = file_uri_to_path("file://localhost/tmp/project").unwrap();
        assert_eq!(localhost, PathBuf::from("/tmp/project"));
    }

    #[test]
    fn rejects_relative_file_uri() {
        let error = file_uri_to_path("file://project").unwrap_err();
        assert!(error.contains("绝对路径"));
    }

    #[test]
    fn roots_parser_requires_existing_directories_and_preserves_multiple_roots() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_uri = format!("file://{}", first.path().display());
        let second_uri = format!("file://{}", second.path().display());
        let roots = parse_roots(Some(&json!({
            "roots": [
                {"uri": first_uri},
                {"uri": second_uri}
            ]
        })))
        .unwrap();
        assert_eq!(roots.len(), 2);
        assert!(select_single_root(&roots).is_none());
    }

    #[test]
    fn roots_parser_reports_malformed_response() {
        let error =
            parse_roots(Some(&json!({"roots": [{"uri": "https://example.com"}]}))).unwrap_err();
        assert!(error.contains("只支持 file://"));
    }

    #[test]
    fn oversized_request_is_rejected_before_json_parsing() {
        let frame = " ".repeat(MAX_REQUEST_BYTES + 1);
        assert!(frame.len() > MAX_REQUEST_BYTES);
    }

    #[test]
    fn tools_call_params_accepts_and_ignores_meta() {
        let params = serde_json::from_value::<ToolCallParams>(json!({
            "name": "search_code",
            "arguments": {"query": "find the handler"},
            "_meta": {"progressToken": "codex-1"}
        }))
        .unwrap();
        assert_eq!(params.name, "search_code");
        assert_eq!(params.arguments["query"], "find the handler");
        assert!(params._meta.is_some());
    }
}
