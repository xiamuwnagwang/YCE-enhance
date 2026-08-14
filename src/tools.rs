use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::YceError;
use crate::model::Mode;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    pub query: String,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub timeout_search_ms: Option<u64>,
    #[serde(default)]
    pub max_turns: Option<u8>,
    #[serde(default)]
    pub max_commands: Option<u8>,
    #[serde(default)]
    pub max_results: Option<u8>,
    #[serde(default)]
    pub tree_depth: Option<u8>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub repo_map_mode: Option<String>,
    #[serde(default)]
    pub bootstrap_enabled: Option<bool>,
    #[serde(default)]
    pub bootstrap_tree_depth: Option<u8>,
    #[serde(default)]
    pub hotspot_top_k: Option<u8>,
    #[serde(default)]
    pub hotspot_tree_depth: Option<u8>,
    #[serde(default)]
    pub hotspot_max_bytes: Option<usize>,
    #[serde(default)]
    pub bootstrap_max_turns: Option<u8>,
    #[serde(default)]
    pub bootstrap_max_commands: Option<u8>,
    #[serde(default)]
    pub with_network: bool,
    #[serde(default)]
    pub timeout_network_ms: Option<u64>,
    #[serde(default)]
    pub network_profile: Option<String>,
    #[serde(default)]
    pub library: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoArgs {
    #[serde(flatten)]
    pub search: SearchArgs,
    #[serde(default)]
    pub history: Option<String>,
    #[serde(default)]
    pub timeout_enhance_ms: Option<u64>,
    #[serde(default)]
    pub no_search: bool,
    #[serde(default)]
    pub raw_events: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnhanceArgs {
    pub query: String,
    #[serde(default)]
    pub mode: Option<String>,
    /// 可选项目目录：提供后，增强产出任务锚点时会在 <cwd>/.yce/tasks/ 自动建卡。
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub history: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub timeout_enhance_ms: Option<u64>,
    #[serde(default)]
    pub no_search: bool,
    #[serde(default)]
    pub raw_events: bool,
    #[serde(default)]
    pub with_network: bool,
    #[serde(default)]
    pub timeout_network_ms: Option<u64>,
    #[serde(default)]
    pub network_profile: Option<String>,
    #[serde(default)]
    pub library: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkArgs {
    pub query: String,
    #[serde(default)]
    pub timeout_network_ms: Option<u64>,
    #[serde(default)]
    pub network_profile: Option<String>,
    #[serde(default)]
    pub library: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanArgs {
    pub task: String,
    #[serde(default)]
    pub history: Option<String>,
    #[serde(default)]
    pub search_context: Option<String>,
    #[serde(default)]
    pub enable_web_search: Option<bool>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub timeout_plan_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskShowArgs {
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskUpdateArgs {
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub id: Option<String>,
    pub action: String,
    #[serde(default)]
    pub stage: Option<u32>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub accept: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum ToolCall {
    Search(SearchArgs),
    Auto(AutoArgs),
    Enhance(EnhanceArgs),
    Network(NetworkArgs),
    Plan(PlanArgs),
    TaskShow(TaskShowArgs),
    TaskUpdate(TaskUpdateArgs),
}

impl ToolCall {
    pub fn decode(name: &str, arguments: Value) -> Result<Self, YceError> {
        let decode_error = |error: serde_json::Error| {
            YceError::InvalidArguments(format!("工具 {name} 参数无效：{error}"))
        };
        let call = match name {
            "search_code" => Self::Search(serde_json::from_value(arguments).map_err(decode_error)?),
            "auto" => Self::Auto(serde_json::from_value(arguments).map_err(decode_error)?),
            "enhance_prompt" => {
                Self::Enhance(serde_json::from_value(arguments).map_err(decode_error)?)
            }
            "search_network" => {
                Self::Network(serde_json::from_value(arguments).map_err(decode_error)?)
            }
            "y_plan" => Self::Plan(serde_json::from_value(arguments).map_err(decode_error)?),
            "task_show" => Self::TaskShow(serde_json::from_value(arguments).map_err(decode_error)?),
            "task_update" => {
                Self::TaskUpdate(serde_json::from_value(arguments).map_err(decode_error)?)
            }
            _ => return Err(YceError::InvalidArguments(format!("未知工具：{name}"))),
        };
        call.validate()?;
        Ok(call)
    }

    pub fn mode(&self) -> Mode {
        match self {
            Self::Search(_) => Mode::Search,
            Self::Auto(_) => Mode::Auto,
            Self::Enhance(_) => Mode::Enhance,
            Self::Network(_) => Mode::Network,
            Self::Plan(_) => Mode::Plan,
            Self::TaskShow(_) | Self::TaskUpdate(_) => Mode::Task,
        }
    }

    fn validate(&self) -> Result<(), YceError> {
        match self {
            Self::Search(args) => validate_search(args),
            Self::Auto(args) => {
                validate_search(&args.search)?;
                validate_optional_text("history", args.history.as_deref())
            }
            Self::Enhance(args) => {
                validate_query(&args.query)?;
                validate_optional_text("history", args.history.as_deref())?;
                if let Some(mode) = args.mode.as_deref() {
                    if !["agent", "direct"].contains(&mode) {
                        return Err(YceError::InvalidArguments(
                            "mode 必须是 agent 或 direct。".into(),
                        ));
                    }
                }
                validate_language(args.language.as_deref())?;
                validate_network_fields(
                    args.network_profile.as_deref(),
                    args.library.as_deref(),
                    args.repo.as_deref(),
                )
            }
            Self::Network(args) => {
                validate_query(&args.query)?;
                validate_network_fields(
                    args.network_profile.as_deref(),
                    args.library.as_deref(),
                    args.repo.as_deref(),
                )
            }
            Self::Plan(args) => {
                if args.task.trim().is_empty() {
                    return Err(YceError::InvalidArguments("task 不能为空。".into()));
                }
                validate_optional_text("history", args.history.as_deref())?;
                validate_optional_text("search_context", args.search_context.as_deref())?;
                validate_optional_text("save_path", args.save_path.as_deref())?;
                // MCP 进程的工作目录不可预期，相对 save_path 会落到未知位置。
                if let Some(save_path) = args.save_path.as_deref() {
                    if !Path::new(save_path.trim()).is_absolute() {
                        return Err(YceError::InvalidArguments(
                            "save_path 必须是绝对路径（MCP 进程工作目录不可预期）。".into(),
                        ));
                    }
                }
                validate_language(args.language.as_deref())
            }
            Self::TaskShow(args) => {
                validate_optional_text("id", args.id.as_deref())?;
                if let Some(status) = args.status.as_deref() {
                    if !["active", "done", "archived"].contains(&status) {
                        return Err(YceError::InvalidArguments(
                            "status 必须是 active、done 或 archived。".into(),
                        ));
                    }
                }
                Ok(())
            }
            Self::TaskUpdate(args) => {
                validate_optional_text("id", args.id.as_deref())?;
                match args.action.as_str() {
                    "check" => {
                        if args.stage.is_none_or(|stage| stage == 0) {
                            return Err(YceError::InvalidArguments(
                                "action=check 必须传 stage（从 1 开始的阶段号）。".into(),
                            ));
                        }
                        if args
                            .evidence
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty())
                        {
                            return Err(YceError::InvalidArguments(
                                "action=check 必须传 evidence，说明验收判据如何满足。".into(),
                            ));
                        }
                        Ok(())
                    }
                    "done" => Ok(()),
                    "new" => {
                        if args
                            .goal
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty())
                        {
                            return Err(YceError::InvalidArguments(
                                "action=new 必须传 goal（一句话总目标）。".into(),
                            ));
                        }
                        Ok(())
                    }
                    other => Err(YceError::InvalidArguments(format!(
                        "action 必须是 check、done 或 new：{other}"
                    ))),
                }
            }
        }
    }
}

/// 统一的项目目录解析：工具参数 cwd 优先，回退 default-cwd / roots。
pub fn resolve_project_dir(
    cwd: Option<&Path>,
    default_cwd: Option<&Path>,
) -> Result<PathBuf, YceError> {
    let path = cwd.or(default_cwd).ok_or_else(|| {
        YceError::InvalidArguments(
            "必须传 cwd，或在启动 MCP 时设置 --default-cwd；支持 MCP roots/list 的客户端可以省略 cwd。".into(),
        )
    })?;
    if !path.is_absolute() {
        return Err(YceError::InvalidArguments(format!(
            "cwd 必须是绝对路径：{}",
            path.display()
        )));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| YceError::InvalidArguments(format!("cwd 不存在：{}", path.display())))?;
    if !canonical.is_dir() {
        return Err(YceError::InvalidArguments(format!(
            "cwd 不是目录：{}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

impl SearchArgs {
    pub fn resolve_cwd(&self, default_cwd: Option<&Path>) -> Result<PathBuf, YceError> {
        resolve_project_dir(self.cwd.as_deref(), default_cwd)
    }

    pub fn timeout_search(&self, fallback: Duration) -> Duration {
        Duration::from_millis(
            self.timeout_search_ms
                .unwrap_or(fallback.as_millis() as u64),
        )
    }
}

pub fn tool_definitions() -> Vec<Value> {
    let search_properties = search_properties();
    let network_fields = network_properties(true);
    let mut search = search_properties.clone();
    search.extend(network_fields.clone());

    let mut auto = search.clone();
    auto.extend(enhance_properties());

    let mut enhance = BTreeSetMap::new();
    enhance.insert("query", string_schema("要整理或改写的原始任务描述。"));
    enhance.insert(
        "mode",
        json!({"type":"string","enum":["agent","direct"],"description":"agent（默认，多 Agent 流水线，带技能推荐与任务锚点）或 direct（单次 JSON，最快，无推荐）。"}),
    );
    enhance.insert(
        "language",
        json!({"type":"string","enum":["zh-CN","en-US"]}),
    );
    enhance.extend(enhance_properties());
    enhance.extend(network_fields);

    let mut network = BTreeSetMap::new();
    network.insert("query", string_schema("要查询的外部事实或资料。"));
    network.extend(network_properties(false));

    let mut plan = BTreeSetMap::new();
    plan.insert(
        "task",
        string_schema("要规划的任务描述；Y-Plan 只产出结构化实施计划，不执行任何修改。"),
    );
    plan.insert("history", string_schema("User/AI 分行格式的对话上下文。"));
    plan.insert(
        "search_context",
        string_schema(
            "代码定位等上下文。建议先调用 search_code 检索目标项目，再把检索结果粘贴到这里，让计划落到真实代码位置（最多 30000 字符）。",
        ),
    );
    plan.insert(
        "enable_web_search",
        json!({"type":"boolean","description":"是否让 Y-Plan 服务端在规划前联网调研；省略时使用服务端默认值。"}),
    );
    plan.insert(
        "language",
        json!({"type":"string","enum":["zh-CN","en-US"]}),
    );
    plan.insert(
        "save_path",
        string_schema(
            "可选的本地保存位置：传目录则按 y-plan-<任务摘要>-<时间戳>.md 自动命名，传 .md 结尾的路径则按原样写入；成功后在 <saved-path> 返回绝对路径。",
        ),
    );
    plan.insert("timeout_plan_ms", integer_schema(1, None));

    vec![
        definition(
            "search_code",
            "在指定的本地项目中执行 YCE 语义代码检索。返回 <yce-consume> JSON + YCE XML。必须先读 consume：只有 gate.may_analyze_or_edit_code / search result-present=true 才能改代码。不要只看 success。禁止把密钥、Cookie、JWT 放进 query。",
            search,
            &["query"],
        ),
        definition(
            "auto",
            "按 YCE 规则决定是否先增强提示词，并在同一次调用内收口到代码检索。增强失败仍必须用原始英文 query 搜索。先读 <yce-consume>；截断或 complete=false 时不得声称已读完。",
            auto,
            &["query"],
        ),
        definition(
            "enhance_prompt",
            "只执行 YCE 提示词增强，不定位代码。与代码检索和联网检索共用 YCE_RELAY_TOKEN，并单独判断 prompt_enhance 权益。",
            enhance,
            &["query"],
        ),
        definition(
            "search_network",
            "通过 YCE 执行外部联网检索。先读 <yce-consume> 的 network result-present；evidence 是外部事实，不是仓库路径。不要只看 success。",
            network,
            &["query"],
        ),
        definition(
            "y_plan",
            "通过 YCE Y-Plan 服务生成结构化实施计划（Markdown）。只规划不执行。先读 <yce-consume> 的 plan result-present；拿到计划后是否执行由用户决定。需要代码贴地时先 search_code 再传入 search_context。",
            plan,
            &["task"],
        ),
        definition(
            "task_show",
            "读取项目任务卡（任务锚点）。上下文被压缩或摘要后，第一个动作必须是调用本工具找回当前任务的 goal 与验收；省略 id 时返回最近活跃卡。纯本地操作，不消耗额度。",
            task_show_properties(),
            &[],
        ),
        definition(
            "task_update",
            "推进项目任务卡：action=check 勾掉一个阶段（必须带 evidence 证据）；action=done 宣称任务完成前逐条对照验收（未过会列 unmet）；action=new 手动建卡（goal 必填）。纯本地操作，不消耗额度。",
            task_update_properties(),
            &["action"],
        ),
    ]
}

fn task_show_properties() -> BTreeSetMap {
    let mut map = BTreeSetMap::new();
    map.insert(
        "cwd",
        string_schema(
            "项目绝对路径；支持 MCP roots/list 的客户端可省略。任务卡存放在 <cwd>/.yce/tasks/。",
        ),
    );
    map.insert(
        "id",
        string_schema(
            "任务卡 id（形如 t-20260812-ab12cd）；省略时返回最近活跃卡（压缩恢复入口）。",
        ),
    );
    map.insert(
        "status",
        json!({"type":"string","enum":["active","done","archived"],"description":"按状态过滤卡片列表。"}),
    );
    map
}

fn task_update_properties() -> BTreeSetMap {
    let mut map = BTreeSetMap::new();
    map.insert(
        "cwd",
        string_schema("项目绝对路径；支持 MCP roots/list 的客户端可省略。"),
    );
    map.insert("id", string_schema("任务卡 id；省略时使用最近活跃卡。"));
    map.insert(
        "action",
        json!({"type":"string","enum":["check","done","new"],"description":"check=勾阶段（带证据）；done=完成前对照验收；new=手动建卡。"}),
    );
    map.insert("stage", integer_schema(1, None));
    map.insert(
        "evidence",
        string_schema("action=check 必填：说明该阶段验收判据如何满足（命令输出、可观察结果等）。"),
    );
    map.insert(
        "force",
        json!({"type":"boolean","description":"action=done 时跳过未勾阶段强制完成。"}),
    );
    map.insert("goal", string_schema("action=new 必填：一句话总目标。"));
    map.insert(
        "accept",
        json!({"type":"array","items":{"type":"string","minLength":1},"description":"action=new 可选：验收判据列表。"}),
    );
    map
}

type BTreeSetMap = std::collections::BTreeMap<&'static str, Value>;

fn definition(name: &str, description: &str, properties: BTreeSetMap, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "properties": properties,
            "required": required
        }
    })
}

fn search_properties() -> BTreeSetMap {
    let mut map = BTreeSetMap::new();
    map.insert(
        "query",
        string_schema("要检索的代码问题，建议使用准确、简洁的英文。"),
    );
    map.insert(
        "cwd",
        string_schema(
            "可选的目标项目绝对路径。省略时，支持 MCP roots/list 的客户端会自动提供当前工作区；如果客户端提供多个工作区，必须明确传入 cwd。",
        ),
    );
    map.insert("timeout_search_ms", integer_schema(1, None));
    map.insert("max_turns", integer_schema(1, Some(5)));
    map.insert("max_commands", integer_schema(1, Some(20)));
    map.insert("max_results", integer_schema(1, Some(30)));
    map.insert("tree_depth", integer_schema(0, Some(6)));
    map.insert(
        "exclude",
        json!({"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true}),
    );
    map.insert(
        "repo_map_mode",
        json!({"type":"string","enum":["classic","bootstrap_hotspot"]}),
    );
    map.insert("bootstrap_enabled", json!({"type":"boolean"}));
    map.insert("bootstrap_tree_depth", integer_schema(1, Some(3)));
    map.insert("hotspot_top_k", integer_schema(0, Some(8)));
    map.insert("hotspot_tree_depth", integer_schema(1, Some(4)));
    map.insert(
        "hotspot_max_bytes",
        integer_schema(16 * 1024, Some(250 * 1024)),
    );
    map.insert("bootstrap_max_turns", integer_schema(1, Some(5)));
    map.insert("bootstrap_max_commands", integer_schema(1, Some(20)));
    map
}

fn enhance_properties() -> BTreeSetMap {
    let mut map = BTreeSetMap::new();
    map.insert("history", string_schema("User/AI 分行格式的对话上下文。"));
    map.insert("timeout_enhance_ms", integer_schema(1, None));
    map.insert("no_search", json!({"type":"boolean"}));
    map.insert("raw_events", json!({"type":"boolean"}));
    map
}

fn network_properties(include_flag: bool) -> BTreeSetMap {
    let mut map = BTreeSetMap::new();
    if include_flag {
        map.insert("with_network", json!({"type":"boolean"}));
    }
    map.insert("timeout_network_ms", integer_schema(1, None));
    map.insert(
        "network_profile",
        json!({"type":"string","enum":["quick","balanced","exhaustive"]}),
    );
    map.insert("library", string_schema("可选的库名限制。"));
    map.insert(
        "repo",
        string_schema("可选的公开仓库限制，格式为 owner/name。"),
    );
    map
}

fn string_schema(description: &str) -> Value {
    json!({"type":"string","minLength":1,"description":description})
}

fn integer_schema(minimum: usize, maximum: Option<usize>) -> Value {
    match maximum {
        Some(maximum) => json!({"type":"integer","minimum":minimum,"maximum":maximum}),
        None => json!({"type":"integer","minimum":minimum}),
    }
}

fn validate_search(args: &SearchArgs) -> Result<(), YceError> {
    validate_query(&args.query)?;
    bounded("max_turns", args.max_turns, 1, 5)?;
    bounded("max_commands", args.max_commands, 1, 20)?;
    bounded("max_results", args.max_results, 1, 30)?;
    bounded("tree_depth", args.tree_depth, 0, 6)?;
    bounded("bootstrap_tree_depth", args.bootstrap_tree_depth, 1, 3)?;
    bounded("hotspot_top_k", args.hotspot_top_k, 0, 8)?;
    bounded("hotspot_tree_depth", args.hotspot_tree_depth, 1, 4)?;
    bounded("bootstrap_max_turns", args.bootstrap_max_turns, 1, 5)?;
    bounded("bootstrap_max_commands", args.bootstrap_max_commands, 1, 20)?;
    if let Some(bytes) = args.hotspot_max_bytes {
        if !(16 * 1024..=250 * 1024).contains(&bytes) {
            return Err(YceError::InvalidArguments(
                "hotspot_max_bytes 必须在 16384 到 256000 之间。".into(),
            ));
        }
    }
    if let Some(mode) = &args.repo_map_mode {
        if !["classic", "bootstrap_hotspot"].contains(&mode.as_str()) {
            return Err(YceError::InvalidArguments(
                "repo_map_mode 必须是 classic 或 bootstrap_hotspot。".into(),
            ));
        }
    }
    let mut seen = HashSet::new();
    for pattern in &args.exclude {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return Err(YceError::InvalidArguments(
                "exclude 不能包含空字符串。".into(),
            ));
        }
        if !seen.insert(pattern) {
            return Err(YceError::InvalidArguments(format!(
                "exclude 包含重复规则：{pattern}"
            )));
        }
    }
    validate_network_fields(
        args.network_profile.as_deref(),
        args.library.as_deref(),
        args.repo.as_deref(),
    )
}

fn validate_query(query: &str) -> Result<(), YceError> {
    if query.trim().is_empty() {
        return Err(YceError::InvalidArguments("query 不能为空。".into()));
    }
    Ok(())
}

fn validate_optional_text(name: &str, value: Option<&str>) -> Result<(), YceError> {
    if value.is_some_and(|value| value.trim().is_empty()) {
        return Err(YceError::InvalidArguments(format!(
            "{name} 不能为空字符串。"
        )));
    }
    Ok(())
}

fn validate_language(value: Option<&str>) -> Result<(), YceError> {
    if let Some(language) = value {
        if !["zh-CN", "en-US"].contains(&language) {
            return Err(YceError::InvalidArguments(
                "language 必须是 zh-CN 或 en-US。".into(),
            ));
        }
    }
    Ok(())
}

fn validate_network_fields(
    profile: Option<&str>,
    library: Option<&str>,
    repo: Option<&str>,
) -> Result<(), YceError> {
    if let Some(profile) = profile {
        if !["quick", "balanced", "exhaustive"].contains(&profile) {
            return Err(YceError::InvalidArguments(
                "network_profile 必须是 quick、balanced 或 exhaustive。".into(),
            ));
        }
    }
    validate_optional_text("library", library)?;
    validate_optional_text("repo", repo)
}

fn bounded<T>(name: &str, value: Option<T>, minimum: T, maximum: T) -> Result<(), YceError>
where
    T: PartialOrd + std::fmt::Display + Copy,
{
    if let Some(value) = value {
        if value < minimum || value > maximum {
            return Err(YceError::InvalidArguments(format!(
                "{name} 必须在 {minimum} 到 {maximum} 之间。"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_accepts_flattened_search_and_enhance_fields() {
        let call = ToolCall::decode(
            "auto",
            json!({
                "query":"locate auth handler",
                "cwd":"/tmp",
                "max_turns":3,
                "history":"User: locate it",
                "raw_events":true,
                "with_network":false
            }),
        )
        .unwrap();
        let ToolCall::Auto(arguments) = call else {
            panic!("expected auto");
        };
        assert_eq!(arguments.search.max_turns, Some(3));
        assert_eq!(arguments.history.as_deref(), Some("User: locate it"));
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let error =
            ToolCall::decode("search_code", json!({"query":"x","unexpected":true})).unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }
}
