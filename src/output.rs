use serde_json::Value;

use crate::error::ErrorItem;
use crate::model::{
    Degradation, EnhanceResult, NetworkResult, PlanResult, SearchDiagnostics, SearchResult,
    TaskContext, YceResponse,
};
use crate::task_store::{TaskCard, TaskStage};

pub fn to_tool_text(payload: &YceResponse, pretty: bool) -> String {
    crate::consume::wrap_xml(&to_xml(payload, pretty), payload)
}

pub fn to_xml(payload: &YceResponse, pretty: bool) -> String {
    let mut xml = XmlWriter::new(pretty);
    xml.raw(0, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    xml.raw(0, "<yce>");
    xml.text(1, "success", if payload.success { "true" } else { "false" });
    xml.text(1, "mode", payload.mode.as_str());
    xml.text(1, "resolved-action", &payload.resolved_action);
    xml.cdata(1, "original-query", &payload.original_query);
    xml.cdata_optional(1, "cwd", payload.cwd.as_deref());
    write_degradation(&mut xml, &payload.degradation);
    write_enhance(&mut xml, payload.enhance.as_ref());
    write_search(&mut xml, payload.search.as_ref());
    write_network(&mut xml, payload.network_search.as_ref());
    write_task_context(&mut xml, payload.task_context.as_ref());
    write_plan(&mut xml, payload.plan.as_ref());
    write_errors(&mut xml, &payload.errors);
    xml.raw(1, "<meta>");
    xml.raw(2, "<durations-ms>");
    xml.text(3, "enhance", &payload.durations.enhance_ms.to_string());
    xml.text(3, "search", &payload.durations.search_ms.to_string());
    xml.text(3, "network", &payload.durations.network_ms.to_string());
    xml.text(3, "plan", &payload.durations.plan_ms.to_string());
    xml.text(3, "total", &payload.durations.total_ms.to_string());
    xml.raw(2, "</durations-ms>");
    xml.raw(2, "<dependency-paths>");
    xml.cdata(3, "runtime", "native-rust");
    xml.raw(2, "</dependency-paths>");
    xml.text(2, "timestamp", &payload.timestamp);
    xml.raw(1, "</meta>");
    xml.raw(0, "</yce>");
    xml.finish()
}

fn write_degradation(xml: &mut XmlWriter, degradation: &Degradation) {
    if !degradation.active {
        xml.raw(1, "<degraded active=\"false\"/>");
        return;
    }
    xml.raw(1, "<degraded active=\"true\">");
    xml.cdata_optional(2, "summary", degradation.summary.as_deref());
    xml.text_optional(2, "failed-stage", degradation.failed_stage.as_deref());
    xml.text_optional(
        2,
        "search-query-source",
        degradation.search_query_source.as_deref(),
    );
    xml.cdata_optional(2, "fallback-query", degradation.fallback_query.as_deref());
    if let Some(error) = &degradation.error {
        xml.error(2, error);
    }
    xml.raw(1, "</degraded>");
}

fn write_enhance(xml: &mut XmlWriter, result: Option<&EnhanceResult>) {
    let Some(result) = result else {
        xml.raw(1, "<enhanced/>");
        return;
    };
    xml.raw(
        1,
        &format!(
            "<enhanced executed=\"{}\" success=\"{}\" used-history=\"{}\">",
            result.executed, result.success, result.used_history
        ),
    );
    xml.cdata_optional(2, "prompt", result.prompt.as_deref());
    xml.string_list(2, "recommended-skills", "skill", &result.recommended_skills);
    if let Some(task_plan) = &result.task_plan {
        xml.cdata(2, "task-plan", &task_plan.to_string());
    }
    xml.cdata_optional(2, "raw-stdout", result.raw_stdout.as_deref());
    xml.string_list(2, "stderr-summary", "line", &result.stderr_summary);
    if let Some(raw) = &result.raw_events {
        xml.raw(
            2,
            &format!(
                "<raw-events captured=\"{}\" event-count=\"{}\">",
                raw.captured, raw.event_count
            ),
        );
        xml.cdata_optional(3, "error", raw.error.as_deref());
        xml.string_list(3, "event-types", "event-type", &raw.event_types);
        xml.raw(2, "</raw-events>");
    }
    xml.raw(1, "</enhanced>");
}

fn write_search(xml: &mut XmlWriter, result: Option<&SearchResult>) {
    let Some(result) = result else {
        xml.raw(1, "<search/>");
        return;
    };
    xml.raw(
        1,
        &format!(
            "<search executed=\"{}\" success=\"{}\" result-present=\"{}\" empty-result=\"{}\" exit-code=\"{}\">",
            result.executed,
            result.success,
            result.result_present,
            result.empty_result,
            if result.success { 0 } else { 1 }
        ),
    );
    xml.cdata(2, "query", &result.query);
    xml.cdata(2, "result", &result.raw_stdout);
    write_search_diagnostics(xml, &result.diagnostics);
    xml.string_list(2, "stderr-summary", "line", &result.stderr_summary);
    xml.raw(1, "</search>");
}

fn write_search_diagnostics(xml: &mut XmlWriter, diagnostics: &SearchDiagnostics) {
    xml.raw(2, "<diagnostics>");
    macro_rules! scalar {
        ($tag:literal, $value:expr) => {
            if let Some(value) = $value {
                xml.text(3, $tag, &value.to_string());
            }
        };
    }
    scalar!("tree-depth", diagnostics.tree_depth);
    scalar!("requested-tree-depth", diagnostics.requested_tree_depth);
    scalar!("tree-size-kb", diagnostics.tree_size_kb);
    scalar!("fell-back", diagnostics.fell_back);
    scalar!("auto-depth", diagnostics.auto_depth);
    scalar!("context-trimmed", diagnostics.context_trimmed);
    xml.text_optional(
        3,
        "repo-map-strategy",
        diagnostics.repo_map_strategy.as_deref(),
    );
    scalar!("max-turns", diagnostics.max_turns);
    scalar!("max-commands", diagnostics.max_commands);
    scalar!("max-results", diagnostics.max_results);
    scalar!("timeout-ms", diagnostics.timeout_ms);
    scalar!("bootstrap-enabled", diagnostics.bootstrap_enabled);
    scalar!("bootstrap-tree-depth", diagnostics.bootstrap_tree_depth);
    scalar!("hotspot-top-k", diagnostics.hotspot_top_k);
    scalar!("hotspot-tree-depth", diagnostics.hotspot_tree_depth);
    scalar!("hotspot-max-bytes", diagnostics.hotspot_max_bytes);
    scalar!("bootstrap-max-turns", diagnostics.bootstrap_max_turns);
    scalar!("bootstrap-max-commands", diagnostics.bootstrap_max_commands);
    scalar!("turns-used", diagnostics.turns_used);
    xml.text_optional(3, "error-type", diagnostics.error_type.as_deref());
    xml.text_optional(3, "project-path", diagnostics.project_path.as_deref());
    xml.text_optional(3, "ignore-file", diagnostics.ignore_file.as_deref());
    xml.string_list(3, "hot-dirs", "hot-dir", &diagnostics.hot_dirs);
    xml.string_list(
        3,
        "exclude-paths",
        "exclude-path",
        &diagnostics.exclude_paths,
    );
    xml.string_list(
        3,
        "ignore-patterns",
        "ignore-pattern",
        &diagnostics.ignore_patterns,
    );
    xml.raw(2, "</diagnostics>");
}

fn write_network(xml: &mut XmlWriter, result: Option<&NetworkResult>) {
    let Some(result) = result else {
        // Keep the XML element stable while distinguishing a skipped network
        // stage from a completed request with no usable evidence.
        xml.raw(
            1,
            "<network-search executed=\"false\" success=\"false\" result-present=\"false\"/>",
        );
        return;
    };
    xml.raw(
        1,
        &format!(
            "<network-search executed=\"{}\" success=\"{}\" result-present=\"{}\">",
            result.executed, result.success, result.result_present
        ),
    );
    xml.text(2, "request-id", &result.request_id);
    xml.cdata(2, "query", &result.query);
    xml.text(2, "profile", &result.profile);
    xml.text_optional(2, "status", result.status.as_deref());
    if let Some(value) = &result.classification {
        xml.cdata(2, "classification", &value.to_string());
    }
    xml.object_list(2, "evidence", "source", &result.evidence);
    xml.object_list(2, "summaries", "summary", &result.summaries);
    xml.object_list(2, "provider-runs", "provider-run", &result.provider_runs);
    xml.object_list(2, "failures", "failure", &result.failures);
    if let Some(usage) = &result.usage {
        xml.raw(2, "<usage>");
        for (key, value) in usage {
            let tag = key.replace('_', "-");
            xml.text(3, &tag, &json_scalar(value));
        }
        xml.raw(2, "</usage>");
    }
    xml.raw(1, "</network-search>");
}

fn write_plan(xml: &mut XmlWriter, result: Option<&PlanResult>) {
    let Some(result) = result else {
        // 与 network-search 一致：区分「未执行」与「执行了但没有可用结果」。
        xml.raw(
            1,
            "<y-plan executed=\"false\" success=\"false\" result-present=\"false\"/>",
        );
        return;
    };
    xml.raw(
        1,
        &format!(
            "<y-plan executed=\"{}\" success=\"{}\" result-present=\"{}\">",
            result.executed, result.success, result.result_present
        ),
    );
    xml.text(2, "request-id", &result.request_id);
    xml.cdata(2, "task", &result.task);
    xml.cdata_optional(2, "plan", result.plan.as_deref());
    if let Some(saved_path) = result.saved_path.as_deref() {
        xml.cdata(2, "saved-path", saved_path);
    }
    xml.text(2, "search-used", &result.search_used.to_string());
    xml.text(2, "custom-model", &result.custom_model.to_string());
    xml.text_optional(2, "status", result.status.as_deref());
    xml.raw(1, "</y-plan>");
}

fn write_task_context(xml: &mut XmlWriter, context: Option<&TaskContext>) {
    let Some(context) = context else {
        xml.raw(1, "<task-context present=\"false\"/>");
        return;
    };
    let card = &context.card;
    xml.raw(
        1,
        &format!(
            "<task-context present=\"true\" created-now=\"{}\">",
            context.created_now
        ),
    );
    xml.text(2, "id", &card.id);
    xml.cdata(2, "goal", &card.goal);
    xml.text(2, "status", &card.status);
    write_task_stages(xml, 2, &card.stages, false);
    let recite = if context.created_now {
        format!(
            "已自动建卡 {}。请把 goal 与阶段验收记入你的计划/todo；压缩后第一步调用 task_show 找回锚点。",
            card.id
        )
    } else {
        format!(
            "当前活跃任务卡 {}。上下文若被压缩过，以本卡 goal 与验收为准；完成前调用 task_update action=done 对照验收。",
            card.id
        )
    };
    xml.cdata(2, "recite", &recite);
    xml.raw(1, "</task-context>");
}

fn write_task_stages(xml: &mut XmlWriter, level: usize, stages: &[TaskStage], detailed: bool) {
    if stages.is_empty() {
        xml.raw(level, "<stages/>");
        return;
    }
    xml.raw(level, "<stages>");
    for stage in stages {
        xml.raw(
            level + 1,
            &format!("<stage n=\"{}\" done=\"{}\">", stage.n, stage.done),
        );
        xml.cdata(level + 2, "title", &stage.title);
        if !stage.accept.is_empty() {
            xml.string_list(level + 2, "accept", "item", &stage.accept);
        }
        if detailed {
            if let Some(evidence) = stage.evidence.as_deref() {
                xml.cdata(level + 2, "evidence", evidence);
            }
            if let Some(checked_at) = stage.checked_at.as_deref() {
                xml.text(level + 2, "checked-at", checked_at);
            }
        }
        xml.raw(level + 1, "</stage>");
    }
    xml.raw(level, "</stages>");
}

fn write_task_card(xml: &mut XmlWriter, card: &TaskCard, created_now: bool) {
    xml.raw(
        1,
        &format!("<card present=\"true\" created-now=\"{created_now}\">"),
    );
    xml.text(2, "id", &card.id);
    xml.cdata(2, "goal", &card.goal);
    if !card.task.is_empty() {
        xml.cdata(2, "task", &card.task);
    }
    xml.text(2, "status", &card.status);
    xml.text(2, "source", &card.source);
    xml.text(2, "created-at", &card.created_at);
    xml.text(2, "updated-at", &card.updated_at);
    write_task_stages(xml, 2, &card.stages, true);
    xml.raw(1, "</card>");
}

/// task_show / task_update 的独立输出（<yce-task> 根，与 CLI task 子命令对齐）。
pub struct TaskResult<'a> {
    pub success: bool,
    pub action: &'a str,
    pub card: Option<(&'a TaskCard, bool)>,
    pub cards: Option<&'a [TaskCard]>,
    pub unmet: &'a [TaskStage],
    pub error: Option<&'a ErrorItem>,
    pub hint: Option<&'a str>,
}

pub fn task_result_xml(result: &TaskResult<'_>) -> String {
    let mut xml = XmlWriter::new(true);
    xml.raw(0, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    xml.raw(0, "<yce-task>");
    xml.text(1, "success", if result.success { "true" } else { "false" });
    xml.text(1, "action", result.action);
    match result.card {
        Some((card, created_now)) => write_task_card(&mut xml, card, created_now),
        None => xml.raw(1, "<card present=\"false\"/>"),
    }
    if let Some(cards) = result.cards {
        xml.raw(1, &format!("<cards count=\"{}\">", cards.len()));
        for card in cards {
            let done_stages = card.stages.iter().filter(|stage| stage.done).count();
            xml.raw(
                2,
                &format!(
                    "<card-summary id=\"{}\" status=\"{}\" stages-done=\"{}/{}\" updated-at=\"{}\"><![CDATA[{}]]></card-summary>",
                    escape_attr(&card.id),
                    escape_attr(&card.status),
                    done_stages,
                    card.stages.len(),
                    escape_attr(&card.updated_at),
                    cdata_escape(&card.goal)
                ),
            );
        }
        xml.raw(1, "</cards>");
    }
    if !result.unmet.is_empty() {
        xml.raw(1, &format!("<unmet count=\"{}\">", result.unmet.len()));
        for stage in result.unmet {
            xml.raw(
                2,
                &format!(
                    "<stage n=\"{}\"><![CDATA[{}]]></stage>",
                    stage.n,
                    cdata_escape(&stage.title)
                ),
            );
        }
        xml.raw(1, "</unmet>");
    }
    match result.error {
        Some(error) => {
            xml.raw(1, "<errors>");
            xml.error(2, error);
            xml.raw(1, "</errors>");
        }
        None => xml.raw(1, "<errors/>"),
    }
    if let Some(hint) = result.hint {
        xml.cdata(1, "hint", hint);
    }
    xml.raw(0, "</yce-task>");
    xml.finish()
}

fn write_errors(xml: &mut XmlWriter, errors: &[ErrorItem]) {
    if errors.is_empty() {
        xml.raw(1, "<errors/>");
        return;
    }
    xml.raw(1, "<errors>");
    for error in errors {
        xml.error(2, error);
    }
    xml.raw(1, "</errors>");
}

fn json_scalar(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

struct XmlWriter {
    pretty: bool,
    lines: Vec<String>,
}

impl XmlWriter {
    fn new(pretty: bool) -> Self {
        Self {
            pretty,
            lines: Vec::new(),
        }
    }

    fn raw(&mut self, level: usize, value: &str) {
        let indent = if self.pretty {
            "  ".repeat(level)
        } else {
            String::new()
        };
        self.lines.push(format!("{indent}{value}"));
    }

    fn text(&mut self, level: usize, tag: &str, value: &str) {
        self.raw(level, &format!("<{tag}>{}</{tag}>", escape_text(value)));
    }

    fn text_optional(&mut self, level: usize, tag: &str, value: Option<&str>) {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            self.text(level, tag, value);
        }
    }

    fn cdata(&mut self, level: usize, tag: &str, value: &str) {
        self.raw(
            level,
            &format!("<{tag}><![CDATA[{}]]></{tag}>", cdata_escape(value)),
        );
    }

    fn cdata_optional(&mut self, level: usize, tag: &str, value: Option<&str>) {
        match value {
            Some(value) if !value.is_empty() => self.cdata(level, tag, value),
            _ => self.raw(level, &format!("<{tag}/>")),
        }
    }

    fn string_list(&mut self, level: usize, wrapper: &str, item_tag: &str, items: &[String]) {
        if items.is_empty() {
            return;
        }
        self.raw(level, &format!("<{wrapper}>"));
        for item in items {
            self.cdata(level + 1, item_tag, item);
        }
        self.raw(level, &format!("</{wrapper}>"));
    }

    fn object_list(&mut self, level: usize, wrapper: &str, item_tag: &str, items: &[Value]) {
        if items.is_empty() {
            return;
        }
        self.raw(level, &format!("<{wrapper}>"));
        for item in items {
            self.cdata(level + 1, item_tag, &item.to_string());
        }
        self.raw(level, &format!("</{wrapper}>"));
    }

    fn error(&mut self, level: usize, error: &ErrorItem) {
        self.raw(
            level,
            &format!(
                "<error source=\"{}\" code=\"{}\"><![CDATA[{}]]></error>",
                escape_attr(&error.source),
                escape_attr(&error.code),
                cdata_escape(&error.message)
            ),
        );
    }

    fn finish(self) -> String {
        self.lines.join(if self.pretty { "\n" } else { "" })
    }
}

fn escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(value: &str) -> String {
    escape_text(value).replace('"', "&quot;")
}

fn cdata_escape(value: &str) -> String {
    value.replace("]]>", "]]]]><![CDATA[>")
}
