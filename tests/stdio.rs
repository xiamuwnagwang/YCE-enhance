//! 以编辑器实际使用 MCP 的方式驱动编译后的二进制。
//! initialize、ping、tools/list 和参数拒绝都不访问网络。

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;

fn run_binary(requests: &str) -> (String, String) {
    run_binary_with_env(requests, &[])
}

fn run_binary_with_env(requests: &str, env: &[(&str, &str)]) -> (String, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_yce-mcp"));
    command
        .arg("--runtime-root")
        .arg(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("yce-mcp starts");
    child
        .stdin
        .as_mut()
        .expect("stdin is piped")
        .write_all(requests.as_bytes())
        .expect("requests are written");
    let output = child.wait_with_output().expect("yce-mcp exits");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn initialize_request() -> String {
    concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"#,
        r#""protocolVersion":"2024-11-05","capabilities":{},"#,
        r#""clientInfo":{"name":"integration","version":"1"}}}"#,
        "\n"
    )
    .to_string()
}

fn initialize_request_with_roots() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"roots": {"listChanged": true}},
            "clientInfo": {"name": "roots-integration", "version": "1"}
        }
    })
    .to_string()
        + "\n"
}

#[test]
fn stdout_contains_only_json_rpc_frames() {
    let (stdout, stderr) = run_binary(&initialize_request());
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let message: Value = serde_json::from_str(line)
            .unwrap_or_else(|_| panic!("stdout line is not JSON: {line}"));
        assert_eq!(message["jsonrpc"], "2.0");
    }
}

#[test]
fn initialize_ping_and_tools_list_follow_mcp_contract() {
    let requests = format!(
        "{}{}\n{}\n",
        initialize_request(),
        r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#
    );
    let (stdout, _) = run_binary(&requests);
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(messages[0]["result"]["serverInfo"]["name"], "yce");
    assert_eq!(
        messages[0]["result"]["capabilities"]["tools"]["listChanged"],
        false
    );
    assert_eq!(messages[1]["id"], "p");
    assert_eq!(messages[1]["result"], serde_json::json!({}));
    let tools = messages[2]["result"]["tools"].as_array().unwrap();
    let names = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "search_code",
            "auto",
            "enhance_prompt",
            "search_network",
            "y_plan",
            "task_show",
            "task_update"
        ]
    );
    assert!(tools.iter().all(|tool| {
        tool["inputSchema"]["type"] == "object"
            && tool["inputSchema"]["additionalProperties"] == false
    }));
}

#[test]
fn malformed_input_is_answered_without_killing_session() {
    let requests = format!(
        "{}not json\n{}\n",
        initialize_request(),
        r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#
    );
    let (stdout, _) = run_binary(&requests);
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["error"]["code"], -32700);
    assert_eq!(messages[2]["id"], 3);
    assert_eq!(messages[2]["result"], serde_json::json!({}));
}

#[test]
fn notifications_do_not_emit_responses() {
    let requests = concat!(
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#,
        "\n"
    );
    let (stdout, _) = run_binary(requests);
    let messages = stdout.lines().collect::<Vec<_>>();
    assert_eq!(messages.len(), 1);
    let response: Value = serde_json::from_str(messages[0]).unwrap();
    assert_eq!(response["id"], 9);
}

#[test]
fn unknown_tools_and_bad_arguments_use_invalid_params_without_network() {
    let requests = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"missing","arguments":{},"_meta":{"progressToken":"codex-1"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"","cwd":"/tmp"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#,
        "\n"
    );
    let (stdout, _) = run_binary(requests);
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["error"]["code"], -32602);
    assert!(messages[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Unknown tool: missing"));
    assert_eq!(messages[1]["error"]["code"], -32602);
    assert_eq!(messages[2]["result"], serde_json::json!({}));
}

#[test]
fn oversized_frame_is_rejected_and_the_session_continues() {
    let oversized = format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"padding\":\"{}\"}}\n",
        "x".repeat(1024 * 1024)
    );
    let requests = format!(
        "{}{}\n",
        oversized, r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#
    );
    let (stdout, _) = run_binary(&requests);
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["error"]["code"], -32600);
    assert_eq!(messages[1]["id"], 2);
}

#[test]
fn asks_roots_capable_client_for_workspace_when_cwd_is_omitted() {
    let requests = format!(
        "{}{}\n{}\n",
        initialize_request_with_roots(),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"Locate the MCP protocol handler"}}}"#
    );
    let (stdout, stderr) = run_binary(&requests);
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], 1);
    assert_eq!(messages[1]["id"], "yce-roots-1");
    assert_eq!(messages[1]["method"], "roots/list");
    assert_eq!(messages[1]["params"], serde_json::json!({}));
}

#[test]
fn explains_the_fallback_when_client_does_not_support_roots() {
    let requests = format!(
        "{}{}\n",
        initialize_request(),
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"Locate the MCP protocol handler"}}}"#
    );
    let (stdout, stderr) = run_binary(&requests);
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["id"], 3);
    assert_eq!(messages[1]["error"]["code"], -32602);
    assert!(messages[1]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("YCE_MCP_DEFAULT_CWD"));
}

#[test]
fn reports_multiple_roots_on_the_original_tool_request_without_guessing() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let roots_response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "yce-roots-1",
        "result": {
            "roots": [
                {"uri": format!("file://{}", first.path().display())},
                {"uri": format!("file://{}", second.path().display())}
            ]
        }
    });
    let requests = format!(
        "{}{}\n{}\n{}\n",
        initialize_request_with_roots(),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"Locate the MCP protocol handler"}}}"#,
        roots_response
    );
    let (stdout, stderr) = run_binary(&requests);
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2]["id"], 3);
    assert_eq!(messages[2]["error"]["code"], -32602);
    assert!(messages[2]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("多个工作区"));
}

/// 极简单次请求 HTTP fixture：收下 POST /yce/y-plan 后返回 SSE 计划流。
fn spawn_y_plan_fixture_relay() -> (String, std::thread::JoinHandle<String>) {
    use std::io::{BufRead, BufReader, Read, Write as IoWrite};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture relay binds");
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("fixture relay accepts");
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let trimmed = line.trim();
            if trimmed.is_empty() {
                break;
            }
            if let Some(value) = trimmed
                .to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
            {
                content_length = value;
            }
        }
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body).unwrap();
        let body = String::from_utf8_lossy(&body).into_owned();

        let mut stream = reader.into_inner();
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream; charset=utf-8\r\n",
            "Cache-Control: no-cache\r\n",
            "Connection: close\r\n",
            "\r\n",
            "event: search_complete\ndata: {\"results\":2}\n\n",
            "event: chunk\ndata: {\"chunk\":\"## Plan\\n\"}\n\n",
            "event: complete\ndata: {\"plan\":\"## Plan\\n1. fixture step\"}\n\n",
        );
        stream.write_all(response.as_bytes()).unwrap();
        stream.flush().unwrap();
        body
    });
    (base_url, handle)
}

#[test]
fn y_plan_tool_streams_a_plan_from_the_relay() {
    let (base_url, relay) = spawn_y_plan_fixture_relay();
    let save_dir = tempfile::tempdir().expect("save dir");
    let requests = format!(
        "{}{}\n{}\n",
        initialize_request(),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "y_plan",
                "arguments": {
                    "task": "Plan the fixture refactor",
                    "history": "User: fixture context",
                    "search_context": "Path: src/fixture.rs (L1-5)",
                    "language": "zh-CN",
                    "save_path": save_dir.path().to_string_lossy()
                }
            }
        })
    );
    let (stdout, stderr) = run_binary_with_env(
        &requests,
        &[
            ("YCE_RELAY_URL", base_url.as_str()),
            ("YCE_RELAY_TOKEN", "fixture-yce-key"),
        ],
    );
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let request_body = relay.join().expect("fixture relay finishes");
    let request: Value = serde_json::from_str(&request_body).expect("relay receives JSON");
    assert_eq!(request["task"], "Plan the fixture refactor");
    assert_eq!(request["conversation_history"], "User: fixture context");
    assert_eq!(request["search_context"], "Path: src/fixture.rs (L1-5)");
    assert_eq!(request["language"], "zh-CN");

    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    let text = messages[1]["result"]["content"][0]["text"]
        .as_str()
        .expect("tool call returns text");
    assert!(messages[1]["result"]["isError"] != serde_json::json!(true));
    assert!(text.contains("<mode>plan</mode>"), "unexpected XML: {text}");
    assert!(
        text.contains("<y-plan executed=\"true\" success=\"true\" result-present=\"true\">"),
        "unexpected XML: {text}"
    );
    assert!(text.contains("fixture step"), "unexpected XML: {text}");
    assert!(
        text.contains("<search-used>true</search-used>"),
        "unexpected XML: {text}"
    );

    // save_path：计划应按契约文件名落盘，并在 <saved-path> 返回
    assert!(text.contains("<saved-path>"), "unexpected XML: {text}");
    let saved = std::fs::read_dir(save_dir.path())
        .expect("save dir readable")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(saved.len(), 1, "expected one saved plan: {saved:?}");
    assert!(
        saved[0].starts_with("y-plan-plan-the-fixture-ref") && saved[0].ends_with(".md"),
        "unexpected filename: {}",
        saved[0]
    );
    let content =
        std::fs::read_to_string(save_dir.path().join(&saved[0])).expect("saved plan readable");
    assert!(content.starts_with("---\ntask: \"Plan the fixture refactor\""));
    assert!(content.contains("fixture step"));
}

#[test]
fn task_tools_manage_cards_end_to_end_without_network() {
    let project = tempfile::tempdir().expect("project dir");
    let cwd = project.path().to_string_lossy().into_owned();
    let goal = "带 \"引号\" 的目标\n以及换行 && <标签>";
    let requests = format!(
        "{}{}\n{}\n{}\n{}\n{}\n{}\n",
        initialize_request(),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        serde_json::json!({
            "jsonrpc":"2.0","id":10,"method":"tools/call",
            "params":{"name":"task_update","arguments":{
                "cwd": cwd, "action":"new", "goal": goal,
                "accept": ["判据含 \"引号\"", "第二条\n换行判据"]
            }}
        }),
        // 同会话免传 id：show 应命中刚建的卡
        serde_json::json!({
            "jsonrpc":"2.0","id":11,"method":"tools/call",
            "params":{"name":"task_show","arguments":{"cwd": cwd}}
        }),
        // done 未过验收：应报 unmet
        serde_json::json!({
            "jsonrpc":"2.0","id":12,"method":"tools/call",
            "params":{"name":"task_update","arguments":{"cwd": cwd, "action":"done"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":13,"method":"tools/call",
            "params":{"name":"task_update","arguments":{
                "cwd": cwd, "action":"check", "stage": 1,
                "evidence": "输出含 \"引号\" 的证据"
            }}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":14,"method":"tools/call",
            "params":{"name":"task_update","arguments":{"cwd": cwd, "action":"done"}}
        }),
    );
    let (stdout, stderr) = run_binary(&requests);
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 6);

    let text_of = |message: &Value| -> String {
        message["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };

    // 建卡：创建成功且原文保留特殊字符
    let created = text_of(&messages[1]);
    assert!(created.contains("created-now=\"true\""), "{created}");
    assert!(created.contains("带 \"引号\" 的目标"), "{created}");
    let card_id = created
        .split("<id>")
        .nth(1)
        .and_then(|rest| rest.split("</id>").next())
        .expect("card id in xml")
        .to_string();

    // 免传 id 的 show 命中同一张卡（会话活跃卡）
    let shown = text_of(&messages[2]);
    assert!(shown.contains(&card_id), "{shown}");
    assert!(shown.contains("以及换行 && <标签>"), "{shown}");

    // done 未过验收 → unmet
    let blocked = text_of(&messages[3]);
    assert!(messages[3]["result"]["isError"] == serde_json::json!(true));
    assert!(blocked.contains("<unmet count=\"1\">"), "{blocked}");

    // check 后 done 成功
    let checked = text_of(&messages[4]);
    assert!(checked.contains("done=\"true\""), "{checked}");
    let done = text_of(&messages[5]);
    assert!(done.contains("<status>done</status>"), "{done}");
}

#[test]
fn y_plan_rejects_blank_tasks_without_network() {
    let requests = format!(
        "{}{}\n",
        initialize_request(),
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"y_plan","arguments":{"task":"  "}}}"#
    );
    let (stdout, stderr) = run_binary(&requests);
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["error"]["code"], -32602);
    assert!(messages[1]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("task"));
}

#[test]
fn reports_invalid_roots_response_on_the_original_tool_request() {
    let requests = format!(
        "{}{}\n{}\n{}\n",
        initialize_request_with_roots(),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"Locate the MCP protocol handler"}}}"#,
        r#"{"jsonrpc":"2.0","id":"yce-roots-1","result":{"roots":[{"uri":"https://example.com"}]}}"#
    );
    let (stdout, stderr) = run_binary(&requests);
    assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2]["id"], 3);
    assert_eq!(messages[2]["error"]["code"], -32602);
    assert!(messages[2]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("roots/list 响应无效"));
}
