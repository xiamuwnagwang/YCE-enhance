use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::config::RuntimeConfig;
use crate::enhance::EnhanceClient;
use crate::error::{ErrorItem, YceError};
use crate::model::{Degradation, Durations, Mode, TaskContext, YceResponse};
use crate::network::NetworkClient;
use crate::output::{task_result_xml, to_xml, TaskResult};
use crate::plan::{save_plan_to_file, PlanClient, PlanRequest};
use crate::search::SearchEngine;
use crate::task_store;
use crate::tools::{
    resolve_project_dir, AutoArgs, EnhanceArgs, NetworkArgs, PlanArgs, SearchArgs, TaskShowArgs,
    TaskUpdateArgs, ToolCall,
};

const SEARCH_KEYWORDS: &[&str] = &[
    "搜索代码",
    "找文件",
    "定位实现",
    "在哪",
    "哪里",
    "函数",
    "类",
    "接口",
    "api",
    "组件",
    "模块",
    "provider",
    "route",
    "handler",
    "实现",
    "逻辑",
    "代码",
    "文件",
    "settings",
    "模型列表",
];
const ENHANCE_KEYWORDS: &[&str] = &[
    "优化提示词",
    "提示词增强",
    "增强",
    "改写",
    "整理需求",
    "润色",
    "补全上下文",
    "更好理解",
    "优化这个任务",
    "prompt",
];
const AMBIGUOUS_MARKERS: &[&str] = &[
    "这个",
    "这里",
    "那块",
    "相关逻辑",
    "对应地方",
    "这块",
    "那个",
    "它",
    "帮我看看",
];

pub struct ExecuteOutput {
    pub text: String,
    pub is_error: bool,
}

pub struct YceService {
    config: RuntimeConfig,
    enhance: EnhanceClient,
    network: NetworkClient,
    plan: PlanClient,
    search: SearchEngine,
    tool_timeout: Duration,
    /// 会话活跃卡（内存兜底）：同一 MCP 会话内 task_show/task_update
    /// 免传 id 也能命中最近操作的卡。
    session_active_card: Mutex<Option<(PathBuf, String)>>,
}

impl YceService {
    pub fn new(config: RuntimeConfig, tool_timeout: Duration) -> anyhow::Result<Self> {
        Ok(Self {
            enhance: EnhanceClient::new(&config)?,
            network: NetworkClient::new(&config)?,
            plan: PlanClient::new(&config)?,
            search: SearchEngine::new(&config)
                .map_err(|error| anyhow::anyhow!("无法初始化原生搜索客户端：{error}"))?,
            config,
            tool_timeout,
            session_active_card: Mutex::new(None),
        })
    }

    fn remember_session_card(&self, cwd: &Path, id: &str) {
        if let Ok(mut guard) = self.session_active_card.lock() {
            *guard = Some((cwd.to_path_buf(), id.to_string()));
        }
    }

    fn session_card_id(&self, cwd: &Path) -> Option<String> {
        self.session_active_card
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .filter(|(stored_cwd, _)| stored_cwd == cwd)
            .map(|(_, id)| id)
    }

    /// 解析卡引用：显式 id > 会话活跃卡 > 磁盘最近活跃卡。
    fn resolve_task_card(&self, cwd: &Path, id: Option<&str>) -> Option<task_store::TaskCard> {
        let explicit = id.map(str::trim).filter(|id| !id.is_empty() && *id != "-");
        if let Some(id) = explicit {
            return task_store::read_card(cwd, id);
        }
        if let Some(session_id) = self.session_card_id(cwd) {
            if let Some(card) = task_store::read_card(cwd, &session_id) {
                if card.status == "active" {
                    return Some(card);
                }
            }
        }
        task_store::latest_active_card(cwd)
    }

    /// 零配合兜底：增强产出任务锚点则自动建卡；否则复述当前活跃卡。
    fn build_task_context(
        &self,
        cwd: Option<&Path>,
        task_plan: Option<&Value>,
        original_query: &str,
    ) -> Option<TaskContext> {
        let cwd = cwd?;
        if let Some(task_plan) = task_plan {
            if let Some(card) = task_store::create_card_from_task_plan(cwd, task_plan, original_query)
            {
                self.remember_session_card(cwd, &card.id);
                return Some(TaskContext {
                    card,
                    created_now: true,
                });
            }
        }
        self.resolve_task_card(cwd, None).map(|card| TaskContext {
            card,
            created_now: false,
        })
    }

    pub async fn execute(
        &self,
        name: &str,
        arguments: Value,
        default_cwd: Option<&Path>,
    ) -> Result<ExecuteOutput, YceError> {
        let call = ToolCall::decode(name, arguments)?;
        let run = self.execute_call(call, default_cwd);
        match tokio::time::timeout(self.tool_timeout, run).await {
            Ok(result) => result,
            Err(_) => {
                let response = timeout_response(name, self.tool_timeout);
                Ok(ExecuteOutput {
                    text: to_xml(&response, true),
                    is_error: true,
                })
            }
        }
    }

    async fn execute_call(
        &self,
        call: ToolCall,
        default_cwd: Option<&Path>,
    ) -> Result<ExecuteOutput, YceError> {
        let response = match call {
            ToolCall::Search(arguments) => self.execute_search(arguments, default_cwd).await?,
            ToolCall::Auto(arguments) => self.execute_auto(arguments, default_cwd).await?,
            ToolCall::Enhance(arguments) => self.execute_enhance(arguments, default_cwd).await,
            ToolCall::Network(arguments) => self.execute_network(arguments).await,
            ToolCall::Plan(arguments) => self.execute_plan(arguments).await,
            ToolCall::TaskShow(arguments) => {
                return self.execute_task_show(arguments, default_cwd);
            }
            ToolCall::TaskUpdate(arguments) => {
                return self.execute_task_update(arguments, default_cwd);
            }
        };
        Ok(ExecuteOutput {
            is_error: !response.success,
            text: to_xml(&response, true),
        })
    }

    fn execute_task_show(
        &self,
        arguments: TaskShowArgs,
        default_cwd: Option<&Path>,
    ) -> Result<ExecuteOutput, YceError> {
        let cwd = resolve_project_dir(arguments.cwd.as_deref(), default_cwd)?;
        if arguments.status.is_some() || arguments.id.is_none() {
            // 无 id：先解析活跃卡（压缩恢复入口），列表随附
            let card = self.resolve_task_card(&cwd, arguments.id.as_deref());
            let cards = task_store::list_cards(&cwd, arguments.status.as_deref());
            if let Some(card) = &card {
                self.remember_session_card(&cwd, &card.id);
            }
            let success = card.is_some() || !cards.is_empty();
            let error = (!success).then(|| {
                ErrorItem::new("task", "NOT_FOUND", "当前项目没有任务卡。")
            });
            let text = task_result_xml(&TaskResult {
                success,
                action: "show",
                card: card.as_ref().map(|card| (card, false)),
                cards: Some(&cards),
                unmet: &[],
                error: error.as_ref(),
                hint: Some(if success {
                    "压缩后请以本卡 goal 与验收为准继续推进；阶段完成用 task_update action=check 记证据。"
                } else {
                    "先通过 enhance_prompt/auto 自动建卡，或 task_update action=new 手动建卡。"
                }),
            });
            return Ok(ExecuteOutput {
                is_error: !success,
                text,
            });
        }
        let id = arguments.id.as_deref().unwrap_or_default();
        let card = task_store::read_card(&cwd, id);
        let success = card.is_some();
        if let Some(card) = &card {
            self.remember_session_card(&cwd, &card.id);
        }
        let error = (!success).then(|| {
            ErrorItem::new("task", "NOT_FOUND", format!("任务卡不存在：{id}"))
        });
        let text = task_result_xml(&TaskResult {
            success,
            action: "show",
            card: card.as_ref().map(|card| (card, false)),
            cards: None,
            unmet: &[],
            error: error.as_ref(),
            hint: None,
        });
        Ok(ExecuteOutput {
            is_error: !success,
            text,
        })
    }

    fn execute_task_update(
        &self,
        arguments: TaskUpdateArgs,
        default_cwd: Option<&Path>,
    ) -> Result<ExecuteOutput, YceError> {
        let cwd = resolve_project_dir(arguments.cwd.as_deref(), default_cwd)?;
        let outcome: Result<(bool, task_store::TaskCard, Vec<task_store::TaskStage>, bool), String> =
            match arguments.action.as_str() {
                "new" => {
                    // 与 CLI task new 对齐：没给验收判据就不造空阶段。
                    let stages = if arguments.accept.is_empty() {
                        Vec::new()
                    } else {
                        vec![task_store::TaskStage {
                            n: 1,
                            title: "验收".into(),
                            accept: arguments.accept.clone(),
                            done: false,
                            evidence: None,
                            checked_at: None,
                        }]
                    };
                    task_store::create_card(
                        &cwd,
                        arguments.goal.as_deref().unwrap_or_default(),
                        stages,
                        arguments.goal.as_deref().unwrap_or_default(),
                        "manual",
                    )
                    .map(|card| (true, card, Vec::new(), true))
                }
                "check" => {
                    let resolved = self
                        .resolve_task_card(&cwd, arguments.id.as_deref())
                        .ok_or_else(|| "找不到任务卡：请传 id 或先建卡。".to_string());
                    resolved.and_then(|card| {
                        task_store::check_stage(
                            &cwd,
                            &card.id,
                            arguments.stage.unwrap_or(0),
                            arguments.evidence.as_deref().unwrap_or_default(),
                        )
                        .map(|card| (true, card, Vec::new(), false))
                    })
                }
                "done" => {
                    let resolved = self
                        .resolve_task_card(&cwd, arguments.id.as_deref())
                        .ok_or_else(|| "找不到任务卡：请传 id 或先建卡。".to_string());
                    resolved.and_then(|card| {
                        task_store::complete_card(&cwd, &card.id, arguments.force)
                            .map(|outcome| (outcome.ok, outcome.card, outcome.unmet, false))
                    })
                }
                other => Err(format!("未知 action：{other}")),
            };

        match outcome {
            Ok((ok, card, unmet, created_now)) => {
                self.remember_session_card(&cwd, &card.id);
                let error = (!ok).then(|| {
                    ErrorItem::new(
                        "task",
                        "ACCEPTANCE_UNMET",
                        format!(
                            "还有 {} 个阶段未通过验收；逐条补齐证据后重试，或 force=true 强制完成。",
                            unmet.len()
                        ),
                    )
                });
                let text = task_result_xml(&TaskResult {
                    success: ok,
                    action: &arguments.action,
                    card: Some((&card, created_now)),
                    cards: None,
                    unmet: &unmet,
                    error: error.as_ref(),
                    hint: None,
                });
                Ok(ExecuteOutput {
                    is_error: !ok,
                    text,
                })
            }
            Err(message) => {
                let error = ErrorItem::new("task", "EXEC_ERROR", message);
                let text = task_result_xml(&TaskResult {
                    success: false,
                    action: &arguments.action,
                    card: None,
                    cards: None,
                    unmet: &[],
                    error: Some(&error),
                    hint: None,
                });
                Ok(ExecuteOutput {
                    is_error: true,
                    text,
                })
            }
        }
    }

    async fn execute_search(
        &self,
        arguments: SearchArgs,
        default_cwd: Option<&Path>,
    ) -> Result<YceResponse, YceError> {
        let started = Instant::now();
        let cwd = arguments.resolve_cwd(default_cwd)?;
        let search = self
            .search
            .search(&arguments, &cwd, self.config.timeout_search)
            .await;
        let mut errors = search.error.into_iter().collect::<Vec<_>>();
        let network = if arguments.with_network {
            let outcome = self
                .network
                .search(
                    &arguments.query,
                    arguments.network_profile.as_deref().unwrap_or("balanced"),
                    arguments.library.as_deref(),
                    arguments.repo.as_deref(),
                    Duration::from_millis(
                        arguments
                            .timeout_network_ms
                            .unwrap_or(self.config.timeout_network.as_millis() as u64),
                    ),
                )
                .await;
            if let Some(error) = outcome.error {
                errors.push(error);
            }
            Some((outcome.result, outcome.duration_ms))
        } else {
            None
        };
        let network_ms = network.as_ref().map(|(_, duration)| *duration).unwrap_or(0);
        let network_result = network.map(|(result, _)| result);
        let success = search.result.result_present
            || network_result
                .as_ref()
                .is_some_and(|result| result.result_present);
        if !success && errors.is_empty() {
            errors.push(ErrorItem::new(
                "orchestrator",
                "EMPTY_RESULT",
                "YCE 已执行，但没有找到可用结果。",
            ));
        }
        let task_context = self.build_task_context(Some(&cwd), None, &arguments.query);
        Ok(YceResponse {
            success,
            mode: Mode::Search,
            resolved_action: if arguments.with_network {
                "search_with_network".into()
            } else {
                "search".into()
            },
            original_query: arguments.query,
            cwd: Some(cwd.display().to_string()),
            enhance: None,
            search: Some(search.result),
            network_search: network_result,
            plan: None,
            task_context,
            errors,
            durations: Durations {
                search_ms: search.duration_ms,
                network_ms,
                total_ms: started.elapsed().as_millis(),
                ..Durations::default()
            },
            degradation: Degradation::default(),
            timestamp: timestamp(),
        })
    }

    async fn execute_auto(
        &self,
        arguments: AutoArgs,
        default_cwd: Option<&Path>,
    ) -> Result<YceResponse, YceError> {
        let started = Instant::now();
        let cwd = arguments.search.resolve_cwd(default_cwd)?;
        let original_query = arguments.search.query.clone();
        let should_enhance = resolve_auto_action(&original_query) == "enhance_then_search";
        let mut errors = Vec::new();
        let mut enhance_result = None;
        let mut enhance_ms = 0;
        let can_enhance = self.enhance.has_token();
        let mut search_query = original_query.clone();
        let mut resolved_action = "search".to_string();

        if should_enhance && can_enhance {
            let outcome = self
                .enhance
                .enhance(
                    &original_query,
                    arguments.history.as_deref(),
                    None,
                    arguments.no_search,
                    arguments.raw_events,
                    Duration::from_millis(
                        arguments
                            .timeout_enhance_ms
                            .unwrap_or(self.config.timeout_auto_enhance.as_millis() as u64),
                    ),
                )
                .await;
            enhance_ms = outcome.duration_ms;
            if let Some(prompt) = outcome
                .result
                .success
                .then(|| outcome.result.prompt.clone())
                .flatten()
            {
                search_query = normalize_search_query(&prompt);
            }
            if let Some(error) = outcome.error {
                errors.push(error);
            }
            enhance_result = Some(outcome.result);
            resolved_action = "enhance_then_search".into();
        }

        let mut search_arguments = arguments.search.clone();
        search_arguments.query = search_query;
        let search = self
            .search
            .search(&search_arguments, &cwd, self.config.timeout_search)
            .await;
        if let Some(error) = search.error {
            errors.push(error);
        }
        let network = if search_arguments.with_network {
            let network_query = enhance_result
                .as_ref()
                .and_then(|result| result.prompt.as_deref())
                .filter(|_| enhance_result.as_ref().is_some_and(|result| result.success))
                .unwrap_or(&original_query);
            let outcome = self
                .network
                .search(
                    network_query,
                    search_arguments
                        .network_profile
                        .as_deref()
                        .unwrap_or("balanced"),
                    search_arguments.library.as_deref(),
                    search_arguments.repo.as_deref(),
                    Duration::from_millis(
                        search_arguments
                            .timeout_network_ms
                            .unwrap_or(self.config.timeout_network.as_millis() as u64),
                    ),
                )
                .await;
            if let Some(error) = outcome.error {
                errors.push(error);
            }
            Some((outcome.result, outcome.duration_ms))
        } else {
            None
        };
        if search_arguments.with_network {
            resolved_action = if resolved_action == "enhance_then_search" {
                "enhance_then_search_with_network".into()
            } else {
                "search_with_network".into()
            };
        }
        let network_ms = network.as_ref().map(|(_, duration)| *duration).unwrap_or(0);
        let network_result = network.map(|(result, _)| result);
        let has_search = search.result.result_present;
        let has_network = network_result
            .as_ref()
            .is_some_and(|result| result.result_present);
        let has_enhance = enhance_result
            .as_ref()
            .is_some_and(|result| result.success && result.prompt.is_some());
        let degradation = if should_enhance
            && enhance_result
                .as_ref()
                .is_some_and(|result| result.executed && !result.success)
            && has_search
        {
            let enhancement_error = errors
                .iter()
                .find(|error| error.source == "prompt-enhance")
                .cloned();
            Degradation {
                active: true,
                summary: Some("增强阶段失败，已自动改用原始 query 检索。".into()),
                failed_stage: Some("enhance".into()),
                search_query_source: Some("original-query".into()),
                fallback_query: Some(original_query.clone()),
                error: enhancement_error,
            }
        } else {
            Degradation::default()
        };
        let success = has_search || has_network || has_enhance;
        if !success && errors.is_empty() {
            errors.push(ErrorItem::new(
                "orchestrator",
                "EMPTY_RESULT",
                "YCE 已执行，但没有产生可用结果。",
            ));
        }
        let task_context = self.build_task_context(
            Some(&cwd),
            enhance_result
                .as_ref()
                .and_then(|result| result.task_plan.as_ref()),
            &original_query,
        );
        Ok(YceResponse {
            success,
            mode: Mode::Auto,
            resolved_action,
            original_query,
            cwd: Some(cwd.display().to_string()),
            enhance: enhance_result,
            search: Some(search.result),
            network_search: network_result,
            plan: None,
            task_context,
            errors,
            durations: Durations {
                enhance_ms,
                search_ms: search.duration_ms,
                network_ms,
                total_ms: started.elapsed().as_millis(),
                ..Durations::default()
            },
            degradation,
            timestamp: timestamp(),
        })
    }

    async fn execute_enhance(
        &self,
        arguments: EnhanceArgs,
        default_cwd: Option<&Path>,
    ) -> YceResponse {
        let started = Instant::now();
        // 任务卡目录是可选的：拿不到项目目录时只是不建卡，不影响增强本身。
        let task_cwd = resolve_project_dir(arguments.cwd.as_deref(), default_cwd).ok();
        let timeout = Duration::from_millis(
            arguments
                .timeout_enhance_ms
                .unwrap_or(self.config.timeout_enhance.as_millis() as u64),
        );
        let outcome = if arguments.mode.as_deref() == Some("direct") {
            self.enhance
                .enhance_direct(
                    &arguments.query,
                    arguments.history.as_deref(),
                    arguments.language.as_deref(),
                    timeout,
                )
                .await
        } else {
            self.enhance
                .enhance(
                    &arguments.query,
                    arguments.history.as_deref(),
                    arguments.language.as_deref(),
                    arguments.no_search,
                    arguments.raw_events,
                    timeout,
                )
                .await
        };
        let mut errors = outcome.error.into_iter().collect::<Vec<_>>();
        let network = if arguments.with_network {
            let query = outcome
                .result
                .prompt
                .as_deref()
                .filter(|_| outcome.result.success)
                .unwrap_or(&arguments.query);
            let network = self
                .network
                .search(
                    query,
                    arguments.network_profile.as_deref().unwrap_or("balanced"),
                    arguments.library.as_deref(),
                    arguments.repo.as_deref(),
                    Duration::from_millis(
                        arguments
                            .timeout_network_ms
                            .unwrap_or(self.config.timeout_network.as_millis() as u64),
                    ),
                )
                .await;
            if let Some(error) = network.error {
                errors.push(error);
            }
            Some((network.result, network.duration_ms))
        } else {
            None
        };
        let network_ms = network.as_ref().map(|(_, duration)| *duration).unwrap_or(0);
        let network_result = network.map(|(result, _)| result);
        let success = outcome.result.success
            || network_result
                .as_ref()
                .is_some_and(|result| result.result_present);
        let task_context = self.build_task_context(
            task_cwd.as_deref(),
            outcome.result.task_plan.as_ref(),
            &arguments.query,
        );
        YceResponse {
            success,
            mode: Mode::Enhance,
            resolved_action: if arguments.with_network {
                "enhance_with_network".into()
            } else {
                "enhance".into()
            },
            original_query: arguments.query,
            cwd: task_cwd.map(|path| path.display().to_string()),
            enhance: Some(outcome.result),
            search: None,
            network_search: network_result,
            plan: None,
            task_context,
            errors,
            durations: Durations {
                enhance_ms: outcome.duration_ms,
                network_ms,
                total_ms: started.elapsed().as_millis(),
                ..Durations::default()
            },
            degradation: Degradation::default(),
            timestamp: timestamp(),
        }
    }

    async fn execute_network(&self, arguments: NetworkArgs) -> YceResponse {
        let started = Instant::now();
        let outcome = self
            .network
            .search(
                &arguments.query,
                arguments.network_profile.as_deref().unwrap_or("balanced"),
                arguments.library.as_deref(),
                arguments.repo.as_deref(),
                Duration::from_millis(
                    arguments
                        .timeout_network_ms
                        .unwrap_or(self.config.timeout_network.as_millis() as u64),
                ),
            )
            .await;
        let success = outcome.result.result_present;
        YceResponse {
            success,
            mode: Mode::Network,
            resolved_action: "network_search".into(),
            original_query: arguments.query,
            cwd: None,
            enhance: None,
            search: None,
            network_search: Some(outcome.result),
            plan: None,
            task_context: None,
            errors: outcome.error.into_iter().collect(),
            durations: Durations {
                network_ms: outcome.duration_ms,
                total_ms: started.elapsed().as_millis(),
                ..Durations::default()
            },
            degradation: Degradation::default(),
            timestamp: timestamp(),
        }
    }

    async fn execute_plan(&self, arguments: PlanArgs) -> YceResponse {
        let started = Instant::now();
        let outcome = self
            .plan
            .plan(
                PlanRequest {
                    task: arguments.task.clone(),
                    history: arguments.history.clone(),
                    search_context: arguments.search_context.clone(),
                    enable_web_search: arguments.enable_web_search,
                    language: arguments.language.clone(),
                },
                Duration::from_millis(
                    arguments
                        .timeout_plan_ms
                        .unwrap_or(self.config.timeout_plan.as_millis() as u64),
                ),
            )
            .await;
        let mut plan_result = outcome.result;
        let mut errors: Vec<ErrorItem> = outcome.error.into_iter().collect();

        // save_path：规划成功后落盘；写失败不取消已成功的计划结果。
        if plan_result.result_present {
            if let (Some(save_path), Some(plan_text)) =
                (arguments.save_path.as_deref(), plan_result.plan.as_deref())
            {
                match save_plan_to_file(plan_text, &arguments.task, save_path) {
                    Ok(saved) => plan_result.saved_path = Some(saved.display().to_string()),
                    Err(message) => errors.push(ErrorItem::new(
                        "y-plan",
                        "SAVE_FAILED",
                        format!("计划落盘失败：{message}"),
                    )),
                }
            }
        }

        let success = plan_result.result_present;
        YceResponse {
            success,
            mode: Mode::Plan,
            resolved_action: "plan".into(),
            original_query: arguments.task,
            cwd: None,
            enhance: None,
            search: None,
            network_search: None,
            plan: Some(plan_result),
            task_context: None,
            errors,
            durations: Durations {
                plan_ms: outcome.duration_ms,
                total_ms: started.elapsed().as_millis(),
                ..Durations::default()
            },
            degradation: Degradation::default(),
            timestamp: timestamp(),
        }
    }
}

fn resolve_auto_action(query: &str) -> &'static str {
    let lower = query.to_lowercase();
    let ambiguous = AMBIGUOUS_MARKERS
        .iter()
        .any(|keyword| lower.contains(&keyword.to_lowercase()));
    let enhance = ENHANCE_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(&keyword.to_lowercase()));
    if ambiguous || enhance {
        "enhance_then_search"
    } else {
        let _search_intent = SEARCH_KEYWORDS
            .iter()
            .any(|keyword| lower.contains(&keyword.to_lowercase()));
        "search"
    }
}

fn normalize_search_query(query: &str) -> String {
    query
        .trim()
        .trim_start_matches("<enhanced>")
        .trim_end_matches("</enhanced>")
        .trim()
        .to_string()
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn timeout_response(tool_name: &str, timeout: Duration) -> YceResponse {
    let mode = match tool_name {
        "search_code" => Mode::Search,
        "enhance_prompt" => Mode::Enhance,
        "search_network" => Mode::Network,
        "y_plan" => Mode::Plan,
        _ => Mode::Auto,
    };
    let error = ErrorItem::new(
        "mcp",
        "TIMEOUT",
        format!("工具调用超过总时限 {}ms。", timeout.as_millis()),
    );
    YceResponse {
        success: false,
        mode,
        resolved_action: mode.as_str().into(),
        original_query: String::new(),
        cwd: None,
        enhance: None,
        search: None,
        network_search: None,
        plan: None,
        task_context: None,
        errors: vec![error],
        durations: Durations {
            total_ms: timeout.as_millis(),
            ..Durations::default()
        },
        degradation: Degradation::default(),
        timestamp: timestamp(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_only_enhances_ambiguous_or_explicit_enhance_requests() {
        assert_eq!(resolve_auto_action("Locate SearchEngine::search"), "search");
        assert_eq!(
            resolve_auto_action("帮我看看这个逻辑"),
            "enhance_then_search"
        );
        assert_eq!(
            resolve_auto_action("优化提示词：实现登录"),
            "enhance_then_search"
        );
    }

    #[test]
    fn normalized_search_query_strips_legacy_wrapper() {
        assert_eq!(
            normalize_search_query("<enhanced>\nfind auth handler\n</enhanced>"),
            "find auth handler"
        );
    }
}
