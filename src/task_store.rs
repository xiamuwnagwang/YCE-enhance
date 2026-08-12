//! 任务卡存储（任务锚点 C 线）。
//!
//! 与 skill CLI 的 `scripts/lib/taskCard.js` 共享同一目录（`<项目>/.yce/tasks/`）
//! 与 JSON schema，两种部署形态可互操作。
//!
//! 红线：goal 一经建卡不可变；卡上只有 goal + 阶段验收，不做完整 todo；
//! active 卡超过 7 天未更新自动归档。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const TASK_PREVIEW_MAX_CHARS: usize = 500;
const ARCHIVE_AFTER_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStage {
    pub n: u32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub accept: Vec<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCard {
    pub id: String,
    pub goal: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub stages: Vec<TaskStage>,
    pub status: String,
    #[serde(default)]
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub done_at: Option<String>,
}

pub fn tasks_dir(cwd: &Path) -> PathBuf {
    cwd.join(".yce").join("tasks")
}

fn card_path(cwd: &Path, id: &str) -> PathBuf {
    tasks_dir(cwd).join(format!("{id}.json"))
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn generate_card_id() -> String {
    let now = OffsetDateTime::now_utc();
    let day = format!(
        "{:04}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    );
    let suffix: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    format!("t-{day}-{suffix}")
}

pub fn is_valid_card_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 3
        && parts[0] == "t"
        && parts[1].len() == 8
        && parts[1].chars().all(|ch| ch.is_ascii_digit())
        && parts[2].len() == 6
        && parts[2]
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

/// 原子写：先写临时文件再 rename，避免 CLI 与 MCP 并发写坏卡。
fn write_card(cwd: &Path, card: &TaskCard) -> Result<(), String> {
    let dir = tasks_dir(cwd);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建任务卡目录失败：{error}"))?;
    let target = card_path(cwd, &card.id);
    let temp = dir.join(format!(
        "{}.{}.tmp",
        card.id,
        uuid::Uuid::new_v4().simple()
    ));
    let payload = serde_json::to_string_pretty(card)
        .map_err(|error| format!("序列化任务卡失败：{error}"))?;
    std::fs::write(&temp, format!("{payload}\n"))
        .map_err(|error| format!("写任务卡失败：{error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| format!("落盘任务卡失败：{error}"))?;
    Ok(())
}

pub fn read_card(cwd: &Path, id: &str) -> Option<TaskCard> {
    if !is_valid_card_id(id) {
        return None;
    }
    let raw = std::fs::read_to_string(card_path(cwd, id)).ok()?;
    let card: TaskCard = serde_json::from_str(&raw).ok()?;
    (!card.goal.trim().is_empty()).then_some(card)
}

pub fn list_cards(cwd: &Path, status: Option<&str>) -> Vec<TaskCard> {
    let Ok(entries) = std::fs::read_dir(tasks_dir(cwd)) else {
        return Vec::new();
    };
    let mut cards = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let Some(card) = read_card(cwd, id) else {
            continue;
        };
        if status.is_some_and(|wanted| card.status != wanted) {
            continue;
        }
        cards.push(card);
    }
    cards.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    cards
}

/// active 卡超过 7 天未更新自动归档。
pub fn archive_stale_cards(cwd: &Path) {
    let now = OffsetDateTime::now_utc();
    for mut card in list_cards(cwd, Some("active")) {
        let Ok(updated) = OffsetDateTime::parse(&card.updated_at, &Rfc3339) else {
            continue;
        };
        if (now - updated).whole_seconds() > ARCHIVE_AFTER_SECONDS {
            card.status = "archived".into();
            card.updated_at = now_iso();
            let _ = write_card(cwd, &card);
        }
    }
}

/// 最近活跃卡（压缩恢复的零配合入口）；顺带执行 7 天归档。
pub fn latest_active_card(cwd: &Path) -> Option<TaskCard> {
    archive_stale_cards(cwd);
    list_cards(cwd, Some("active")).into_iter().next()
}

/// 解析卡引用：显式 id 优先，省略或 "-" 时回退最近活跃卡。
pub fn resolve_card(cwd: &Path, id: Option<&str>) -> Option<TaskCard> {
    match id.map(str::trim).filter(|id| !id.is_empty() && *id != "-") {
        Some(id) => read_card(cwd, id),
        None => latest_active_card(cwd),
    }
}

pub fn create_card(
    cwd: &Path,
    goal: &str,
    stages: Vec<TaskStage>,
    task: &str,
    source: &str,
) -> Result<TaskCard, String> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("goal 不能为空：任务卡必须有一句话总目标。".into());
    }
    let now = now_iso();
    let mut normalized = Vec::new();
    for stage in stages {
        let title = stage.title.trim().to_string();
        let accept: Vec<String> = stage
            .accept
            .iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
        if title.is_empty() && accept.is_empty() {
            continue;
        }
        normalized.push(TaskStage {
            n: normalized.len() as u32 + 1,
            title,
            accept,
            done: false,
            evidence: None,
            checked_at: None,
        });
    }
    let card = TaskCard {
        id: generate_card_id(),
        goal: goal.to_string(),
        task: task.chars().take(TASK_PREVIEW_MAX_CHARS).collect(),
        stages: normalized,
        status: "active".into(),
        source: if source == "manual" { "manual" } else { "enhance" }.into(),
        created_at: now.clone(),
        updated_at: now,
        done_at: None,
    };
    write_card(cwd, &card)?;
    Ok(card)
}

/// 从增强返回的任务锚点（{"goal","stages":[{"n","title","accept"}]}）建卡。
pub fn create_card_from_task_plan(cwd: &Path, task_plan: &Value, task: &str) -> Option<TaskCard> {
    let goal = task_plan.get("goal").and_then(Value::as_str)?.trim();
    if goal.is_empty() {
        return None;
    }
    let stages = task_plan
        .get("stages")
        .and_then(Value::as_array)
        .map(|stages| {
            stages
                .iter()
                .map(|stage| TaskStage {
                    n: stage.get("n").and_then(Value::as_u64).unwrap_or(0) as u32,
                    title: stage
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    accept: stage
                        .get("accept")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(ToOwned::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    done: false,
                    evidence: None,
                    checked_at: None,
                })
                .collect()
        })
        .unwrap_or_default();
    create_card(cwd, goal, stages, task, "enhance").ok()
}

pub fn check_stage(
    cwd: &Path,
    id: &str,
    stage_n: u32,
    evidence: &str,
) -> Result<TaskCard, String> {
    let mut card = read_card(cwd, id).ok_or_else(|| format!("任务卡不存在：{id}"))?;
    if card.status != "active" {
        return Err(format!("任务卡状态为 {}，不能勾阶段。", card.status));
    }
    let evidence = evidence.trim();
    if evidence.is_empty() {
        return Err("勾掉阶段必须附证据（evidence），说明验收判据如何满足。".into());
    }
    let total = card.stages.len();
    let stage = card
        .stages
        .iter_mut()
        .find(|stage| stage.n == stage_n)
        .ok_or_else(|| format!("阶段 {stage_n} 不存在（共 {total} 个阶段）。"))?;
    stage.done = true;
    stage.evidence = Some(evidence.to_string());
    stage.checked_at = Some(now_iso());
    card.updated_at = now_iso();
    write_card(cwd, &card)?;
    Ok(card)
}

pub struct CompleteOutcome {
    pub ok: bool,
    pub card: TaskCard,
    pub unmet: Vec<TaskStage>,
}

/// 完成任务卡：逐条对照验收；存在未勾阶段且未 force 时不落状态。
pub fn complete_card(cwd: &Path, id: &str, force: bool) -> Result<CompleteOutcome, String> {
    let mut card = read_card(cwd, id).ok_or_else(|| format!("任务卡不存在：{id}"))?;
    if card.status == "done" {
        return Ok(CompleteOutcome {
            ok: true,
            card,
            unmet: Vec::new(),
        });
    }
    let unmet: Vec<TaskStage> = card
        .stages
        .iter()
        .filter(|stage| !stage.done)
        .cloned()
        .collect();
    if !unmet.is_empty() && !force {
        return Ok(CompleteOutcome {
            ok: false,
            card,
            unmet,
        });
    }
    let now = now_iso();
    card.status = "done".into();
    card.done_at = Some(now.clone());
    card.updated_at = now;
    write_card(cwd, &card)?;
    Ok(CompleteOutcome {
        ok: true,
        card,
        unmet: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn create_read_roundtrip_preserves_special_characters() {
        let dir = tempfile::tempdir().expect("tempdir");
        let goal = "带 \"引号\" 的目标\n以及换行 && <标签>";
        let card = create_card(
            dir.path(),
            goal,
            vec![TaskStage {
                n: 1,
                title: "梳理 \"现状\"".into(),
                accept: vec!["判据一\n（含行号）".into()],
                done: false,
                evidence: None,
                checked_at: None,
            }],
            "原始任务",
            "manual",
        )
        .expect("card created");
        assert!(is_valid_card_id(&card.id), "{}", card.id);
        let reread = read_card(dir.path(), &card.id).expect("readable");
        assert_eq!(reread.goal, goal);
        assert_eq!(reread.stages[0].accept[0], "判据一\n（含行号）");
    }

    #[test]
    fn complete_lists_unmet_stages_until_checked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let card = create_card_from_task_plan(
            dir.path(),
            &json!({"goal":"锚点目标","stages":[
                {"n":1,"title":"一","accept":["A"]},
                {"n":2,"title":"二","accept":["B"]}
            ]}),
            "query",
        )
        .expect("card");
        assert!(check_stage(dir.path(), &card.id, 1, "  ").is_err());
        check_stage(dir.path(), &card.id, 1, "证据 1").expect("checked");
        let blocked = complete_card(dir.path(), &card.id, false).expect("outcome");
        assert!(!blocked.ok);
        assert_eq!(blocked.unmet.len(), 1);
        check_stage(dir.path(), &card.id, 2, "证据 2").expect("checked");
        let done = complete_card(dir.path(), &card.id, false).expect("outcome");
        assert!(done.ok);
        assert_eq!(read_card(dir.path(), &card.id).unwrap().status, "done");
    }

    #[test]
    fn resolve_falls_back_to_latest_active_card_and_rejects_bad_ids() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(resolve_card(dir.path(), None).is_none());
        let card = create_card(dir.path(), "最近活跃", Vec::new(), "", "enhance").expect("card");
        assert_eq!(resolve_card(dir.path(), None).unwrap().id, card.id);
        assert_eq!(resolve_card(dir.path(), Some("-")).unwrap().id, card.id);
        assert!(read_card(dir.path(), "../../etc/passwd").is_none());
    }
}
