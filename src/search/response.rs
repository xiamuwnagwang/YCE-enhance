use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde_json::Value;

use crate::error::YceError;

use super::protobuf::{decode_connect_frames, extract_strings};

#[derive(Debug, Clone)]
pub struct ParsedToolCall {
    pub thinking: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub enum ParsedResponse {
    ToolCall(ParsedToolCall),
    Text(String),
    RemoteError { code: String, message: String },
}

#[derive(Debug, Clone)]
pub struct RelevantFile {
    pub path: PathBuf,
    pub ranges: Vec<(usize, usize)>,
}

pub fn parse_stream_response(data: &[u8]) -> Result<ParsedResponse, YceError> {
    let frames = decode_connect_frames(data)?;
    let mut all_text = String::new();
    for frame in frames {
        if let Ok(text) = std::str::from_utf8(&frame) {
            let trimmed = text.trim();
            if trimmed.starts_with('{') {
                if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(error) = value.get("error") {
                        return Ok(ParsedResponse::RemoteError {
                            code: error
                                .get("code")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string(),
                            message: error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        });
                    }
                }
            }
            if text.contains("[TOOL_CALLS]") {
                all_text = text.replace('\u{fffd}', "");
                break;
            }
        }
        for string in extract_strings(&frame) {
            if string.chars().count() > 10 {
                all_text.push_str(&string);
            }
        }
    }
    if let Some(call) = parse_tool_call(&all_text) {
        Ok(ParsedResponse::ToolCall(call))
    } else {
        Ok(ParsedResponse::Text(all_text))
    }
}

pub fn parse_tool_call(input: &str) -> Option<ParsedToolCall> {
    let text = input.replace("</s>", "");
    let marker = Regex::new(r"(?s)\[TOOL_CALLS\](\w+)(?:\[ARGS\])?\s*(\{.*)").ok()?;
    let captures = marker.captures(&text)?;
    let entire = captures.get(0)?;
    let name = captures.get(1)?.as_str().to_string();
    let raw = captures.get(2)?.as_str().trim();
    let end = find_json_object_end(raw).unwrap_or(raw.len());
    let candidate = &raw[..end];
    let arguments = serde_json::from_str::<Value>(candidate)
        .or_else(|_| {
            let repair = Regex::new(r#"([{,]\s*)([A-Za-z_]\w*)\s*:"#)
                .expect("static regex")
                .replace_all(candidate, "$1\"$2\":");
            serde_json::from_str::<Value>(&repair)
        })
        .ok()?;
    Some(ParsedToolCall {
        thinking: text[..entire.start()].trim().to_string(),
        name,
        arguments,
    })
}

pub fn parse_answer(xml: &str, project_root: &Path, max_results: usize) -> Vec<RelevantFile> {
    let Ok(file_regex) = Regex::new(r#"(?s)<file\s+path=(?:"([^"]+)"|'([^']+)')>(.*?)</file>"#)
    else {
        return Vec::new();
    };
    let range_regex = Regex::new(r"<range>\s*(\d+)\s*-\s*(\d+)\s*</range>").expect("static regex");
    let mut files = Vec::new();
    for captures in file_regex.captures_iter(xml).take(max_results) {
        let virtual_path = captures
            .get(1)
            .or_else(|| captures.get(2))
            .map(|value| value.as_str())
            .unwrap_or_default();
        let Some(path) = safe_answer_path(project_root, virtual_path) else {
            continue;
        };
        let body = captures
            .get(3)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let mut ranges = Vec::new();
        for range in range_regex.captures_iter(body) {
            let Some(start) = range.get(1).and_then(|value| value.as_str().parse().ok()) else {
                continue;
            };
            let Some(end) = range.get(2).and_then(|value| value.as_str().parse().ok()) else {
                continue;
            };
            if start > 0 && end >= start {
                ranges.push((start, end));
            }
        }
        files.push(RelevantFile { path, ranges });
    }
    files
}

fn find_json_object_end(input: &str) -> Option<usize> {
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in input.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(index + character.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

fn safe_answer_path(root: &Path, virtual_path: &str) -> Option<PathBuf> {
    let normalized = virtual_path.replace('\\', "/");
    let relative = normalized
        .strip_prefix("/codebase/")
        .or_else(|| (normalized == "/codebase").then_some(""))
        .unwrap_or(normalized.trim_start_matches('/'));
    let relative = Path::new(relative);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    let path = root.join(relative);
    if !path.starts_with(root) {
        return None;
    }
    if path.exists() {
        let root = root.canonicalize().ok()?;
        let path = path.canonicalize().ok()?;
        path.starts_with(&root).then_some(path)
    } else {
        Some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::protobuf::{encode_connect_frame, ProtobufEncoder};
    use serde_json::json;

    #[test]
    fn tool_call_parser_handles_nested_json_and_braces_in_strings() {
        let parsed = parse_tool_call(
            r#"thinking
[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"a}b","path":"/codebase"}} trailing"#,
        )
        .unwrap();
        assert_eq!(parsed.name, "restricted_exec");
        assert_eq!(parsed.arguments["command1"]["pattern"], "a}b");
    }

    #[test]
    fn tool_call_parser_accepts_remote_variant_without_args_marker() {
        let parsed = parse_tool_call(
            r#"[TOOL_CALLS]restricted_exec {"command1":{"type":"tree","path":"/codebase"}}"#,
        )
        .unwrap();
        assert_eq!(parsed.name, "restricted_exec");
        assert_eq!(parsed.arguments["command1"]["type"], "tree");
    }

    #[test]
    fn stream_parser_extracts_tool_call_from_protobuf_string() {
        let text = r#"[TOOL_CALLS]answer[ARGS]{"answer":"<ANSWER></ANSWER>"}"#;
        let mut proto = ProtobufEncoder::new();
        proto.write_string(1, text);
        let frame = encode_connect_frame(proto.as_bytes(), true).unwrap();
        let ParsedResponse::ToolCall(call) = parse_stream_response(&frame).unwrap() else {
            panic!("expected tool call");
        };
        assert_eq!(call.name, "answer");
        assert_eq!(call.arguments, json!({"answer":"<ANSWER></ANSWER>"}));
    }

    #[test]
    fn answer_parser_rejects_traversal_and_keeps_valid_ranges() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("ok.rs"), "").unwrap();
        let xml = r#"<ANSWER>
<file path="/codebase/ok.rs"><range>1-20</range></file>
<file path="/codebase/../secret"><range>1-2</range></file>
</ANSWER>"#;
        let files = parse_answer(xml, temp.path(), 10);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].ranges, [(1, 20)]);
    }
}
