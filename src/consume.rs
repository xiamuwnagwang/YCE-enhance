use serde_json::{json, Value};

use crate::model::YceResponse;

fn stage(
    executed: bool,
    success: bool,
    result_present: bool,
    empty_result: bool,
) -> Value {
    json!({
        "executed": executed,
        "success": success,
        "result_present": result_present,
        "empty_result": empty_result
    })
}

fn required_kind(resolved_action: &str) -> &'static str {
    if resolved_action.is_empty() {
        "none"
    } else if resolved_action == "enhance" {
        "enhance"
    } else if resolved_action == "network_search" {
        "network"
    } else if resolved_action.contains("plan") {
        "plan"
    } else if resolved_action.contains("search") {
        "search"
    } else {
        "unknown"
    }
}

pub fn summary(payload: &YceResponse) -> Value {
    let search = payload.search.as_ref();
    let network = payload.network_search.as_ref();
    let plan = payload.plan.as_ref();
    let enhanced = payload.enhance.as_ref();
    let kind = required_kind(&payload.resolved_action);
    let search_present = search.map(|item| item.result_present).unwrap_or(false);
    let network_present = network.map(|item| item.result_present).unwrap_or(false);
    let plan_present = plan.map(|item| item.result_present).unwrap_or(false);
    let enhance_executed = enhanced.map(|item| item.executed).unwrap_or(false);
    let required_present = match kind {
        "search" => search_present,
        "network" => network_present,
        "plan" => plan_present,
        "enhance" => enhance_executed,
        _ => false,
    };
    let mut reasons = Vec::new();
    if payload.resolved_action.is_empty() {
        reasons.push("missing resolved-action".to_string());
    } else if kind == "unknown" {
        reasons.push(format!(
            "unsupported resolved-action: {}",
            payload.resolved_action
        ));
    } else if !required_present {
        reasons.push(format!("{kind} result-present is not true"));
    }
    json!({
        "ok": required_present && !payload.resolved_action.is_empty() && kind != "unknown",
        "complete": true,
        "parse_ok": true,
        "truncation_detected": false,
        "success": payload.success,
        "mode": payload.mode.as_str(),
        "resolved_action": payload.resolved_action,
        "required_result": kind,
        "search": stage(
            search.map(|item| item.executed).unwrap_or(false),
            search.map(|item| item.success).unwrap_or(false),
            search_present,
            search.map(|item| item.empty_result).unwrap_or(false),
        ),
        "network": {
            "executed": network.map(|item| item.executed).unwrap_or(false),
            "success": network.map(|item| item.success).unwrap_or(false),
            "result_present": network_present
        },
        "plan": {
            "executed": plan.map(|item| item.executed).unwrap_or(false),
            "success": plan.map(|item| item.success).unwrap_or(false),
            "result_present": plan_present
        },
        "enhanced": {
            "executed": enhance_executed,
            "success": enhanced.map(|item| item.success).unwrap_or(false)
        },
        "errors": payload.errors.iter().map(|error| json!({
            "source": error.source,
            "code": error.code,
            "message": error.message
        })).collect::<Vec<_>>(),
        "task_context": {
            "present": payload.task_context.is_some(),
            "created_now": payload.task_context.as_ref().map(|item| item.created_now).unwrap_or(false),
            "id": payload.task_context.as_ref().map(|item| item.card.id.clone())
        },
        "gate": {
            "may_analyze_or_edit_code": search_present,
            "may_use_network_facts": network_present,
            "may_present_plan": plan_present
        },
        "reasons": reasons
    })
}

pub fn wrap_xml(xml: &str, payload: &YceResponse) -> String {
    let mut value = summary(payload);
    if let Some(object) = value.as_object_mut() {
        object.insert("xml_bytes".to_string(), json!(xml.len()));
    }
    let body = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    format!("<yce-consume>\n{body}\n</yce-consume>\n{xml}")
}

pub const MCP_INSTRUCTIONS: &str = "代码检索可以省略 cwd；支持 roots 的客户端会自动提供唯一工作区；多个工作区必须明确传 cwd。每次工具结果顶部是 <yce-consume> JSON，其后才是 XML。必须先读 consume，并核对其 xml_bytes 与收到的 XML 字节数一致：不一致、缺 </yce>、或 truncation_detected=true 时不得声称已读完。consume.complete 只表示服务端生成完整，不能代替对收到文本的校验。只有 gate.may_analyze_or_edit_code=true（search result-present=true）才能改代码。不要只看 success。禁止把 Cookie/JWT/CSRF、config.yaml 密钥或真实凭据写入 query、日志或回复。未经明确授权不要执行真实付费或生产操作。";
