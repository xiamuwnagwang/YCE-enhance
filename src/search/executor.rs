use std::cmp::min;
use std::fs;
use std::path::{Component, Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::Value;

use crate::error::YceError;

use super::ignore::IgnoreRules;

const RESULT_MAX_LINES: usize = 50;
const LINE_MAX_CHARS: usize = 250;
const RG_MAX_RESULTS: usize = 50;
const GLOB_MAX_RESULTS: usize = 100;
const MAX_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_READ_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TREE_BYTES: usize = 256 * 1024;
const MAX_TREE_ENTRIES: usize = 12_000;

#[derive(Debug)]
pub struct ToolExecutor {
    root: PathBuf,
    rules: IgnoreRules,
    collected_rg_patterns: Vec<String>,
}

impl ToolExecutor {
    pub fn new(root: &Path, extra_excludes: &[String]) -> Result<Self, YceError> {
        let root = root.canonicalize().map_err(|error| {
            YceError::InvalidArguments(format!("项目目录无法解析：{}：{error}", root.display()))
        })?;
        if !root.is_dir() {
            return Err(YceError::InvalidArguments(format!(
                "项目路径不是目录：{}",
                root.display()
            )));
        }
        let rules = IgnoreRules::load(&root, extra_excludes)?;
        Ok(Self {
            root,
            rules,
            collected_rg_patterns: Vec::new(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn ignore_rules(&self) -> &IgnoreRules {
        &self.rules
    }

    pub fn collected_rg_patterns(&self) -> Vec<String> {
        let mut out = Vec::new();
        for pattern in &self.collected_rg_patterns {
            if pattern.chars().count() >= 3 && !out.contains(pattern) {
                out.push(pattern.clone());
            }
        }
        out
    }

    pub fn execute_tool_call(&mut self, arguments: &Value, max_commands: usize) -> String {
        let Some(object) = arguments.as_object() else {
            return "Error: missing or invalid tool args".into();
        };
        let mut keys = object
            .keys()
            .filter(|key| key.starts_with("command"))
            .collect::<Vec<_>>();
        keys.sort();
        if keys.is_empty() {
            return "Error: no commandN entries were provided".into();
        }
        let mut parts = Vec::new();
        for key in keys.into_iter().take(max_commands) {
            let output = self.execute_command(&object[key]);
            parts.push(format!("<{key}_result>\n{output}\n</{key}_result>"));
        }
        parts.join("")
    }

    pub fn valid_command_count(arguments: &Value, max_commands: usize) -> usize {
        arguments
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .filter(|(key, value)| {
                        key.starts_with("command")
                            && value.get("type").and_then(Value::as_str).is_some()
                    })
                    .take(max_commands)
                    .count()
            })
            .unwrap_or(0)
    }

    fn execute_command(&mut self, command: &Value) -> String {
        let Some(command) = command.as_object() else {
            return "Error: missing or invalid command".into();
        };
        match command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "rg" => self.rg(
                command.get("pattern").and_then(Value::as_str),
                command.get("path").and_then(Value::as_str),
                command.get("include").and_then(Value::as_array),
                command.get("exclude").and_then(Value::as_array),
            ),
            "readfile" => self.readfile(
                command.get("file").and_then(Value::as_str),
                command.get("start_line").and_then(Value::as_u64),
                command.get("end_line").and_then(Value::as_u64),
            ),
            "tree" => self.tree(
                command.get("path").and_then(Value::as_str),
                command.get("levels").and_then(Value::as_u64),
            ),
            "ls" => self.ls(
                command.get("path").and_then(Value::as_str),
                command
                    .get("long_format")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                command.get("all").and_then(Value::as_bool).unwrap_or(false),
            ),
            "glob" => self.glob(
                command.get("pattern").and_then(Value::as_str),
                command.get("path").and_then(Value::as_str),
                command
                    .get("type_filter")
                    .and_then(Value::as_str)
                    .unwrap_or("all"),
            ),
            other => format!("Error: unknown command type '{other}'"),
        }
    }

    fn rg(
        &mut self,
        pattern: Option<&str>,
        path: Option<&str>,
        includes: Option<&Vec<Value>>,
        excludes: Option<&Vec<Value>>,
    ) -> String {
        let Some(pattern) = pattern.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid pattern".into();
        };
        let Some(path) = path.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid path".into();
        };
        let regex = match Regex::new(pattern) {
            Ok(regex) => regex,
            Err(error) => return format!("Error: invalid regex: {error}"),
        };
        self.collected_rg_patterns.push(pattern.to_string());
        let root = match self.resolve_virtual(path, true) {
            Ok(path) if path.exists() => path,
            Ok(_) => return format!("Error: path does not exist: {path}"),
            Err(error) => return format!("Error: {error}"),
        };
        let includes = match value_glob_set(includes, false) {
            Ok(set) => set,
            Err(error) => return format!("Error: {error}"),
        };
        let excludes = match value_glob_set(excludes, false) {
            Ok(set) => set,
            Err(error) => return format!("Error: {error}"),
        };
        let mut lines = Vec::new();
        let mut builder = WalkBuilder::new(&root);
        builder
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false)
            .max_filesize(Some(MAX_SEARCH_FILE_BYTES));
        for entry in builder.build().flatten() {
            if lines.len() >= RG_MAX_RESULTS {
                break;
            }
            let file_path = entry.path();
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(relative) = file_path.strip_prefix(&self.root) else {
                continue;
            };
            let name = file_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if self.rules.is_ignored(relative, name)
                || includes
                    .as_ref()
                    .is_some_and(|set| !set.is_match(relative) && !set.is_match(name))
                || excludes
                    .as_ref()
                    .is_some_and(|set| set.is_match(relative) || set.is_match(name))
            {
                continue;
            }
            let Ok(metadata) = fs::metadata(file_path) else {
                continue;
            };
            if metadata.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            let Ok(content) = fs::read_to_string(file_path) else {
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                if regex.is_match(line) {
                    lines.push(format!(
                        "{}:{}:{}",
                        self.virtualize(file_path),
                        index + 1,
                        truncate_line(line)
                    ));
                    if lines.len() >= RG_MAX_RESULTS {
                        break;
                    }
                }
            }
        }
        if lines.is_empty() {
            "(no matches)".into()
        } else {
            truncate_output(&lines.join("\n"))
        }
    }

    fn readfile(
        &self,
        file: Option<&str>,
        start_line: Option<u64>,
        end_line: Option<u64>,
    ) -> String {
        let Some(file) = file.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid file path".into();
        };
        let path = match self.resolve_virtual(file, true) {
            Ok(path) if path.is_file() => path,
            Ok(_) => return format!("Error: file not found: {file}"),
            Err(error) => return format!("Error: {error}"),
        };
        let Ok(metadata) = fs::metadata(&path) else {
            return format!("Error: file not found: {file}");
        };
        if metadata.len() > MAX_READ_FILE_BYTES {
            return format!(
                "Error: file is too large to read safely: {} bytes",
                metadata.len()
            );
        }
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) => return format!("Error: {error}"),
        };
        let lines = content.lines().collect::<Vec<_>>();
        let start = start_line.unwrap_or(1).max(1) as usize;
        let end = end_line.unwrap_or(lines.len() as u64) as usize;
        if end < start {
            return "Error: end_line must be greater than or equal to start_line".into();
        }
        if start > lines.len().saturating_add(1) {
            return "(no lines in requested range)".into();
        }
        let mut selected = Vec::new();
        for (index, line) in lines
            .iter()
            .enumerate()
            .skip(start.saturating_sub(1))
            .take(end.saturating_sub(start).saturating_add(1))
        {
            selected.push(format!("{}:{}", index + 1, truncate_line(line)));
        }
        truncate_output(&selected.join("\n"))
    }

    fn tree(&self, path: Option<&str>, levels: Option<u64>) -> String {
        let Some(path) = path.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid path".into();
        };
        let root = match self.resolve_virtual(path, true) {
            Ok(path) if path.is_dir() => path,
            Ok(_) => return format!("Error: dir not found: {path}"),
            Err(error) => return format!("Error: {error}"),
        };
        let depth = levels.unwrap_or(3).clamp(1, 8) as usize;
        truncate_output(&build_tree(
            &root,
            &self.virtualize(&root),
            depth,
            &self.root,
            &self.rules,
            MAX_TREE_BYTES,
        ))
    }

    fn ls(&self, path: Option<&str>, long: bool, all: bool) -> String {
        let Some(path) = path.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid path".into();
        };
        let root = match self.resolve_virtual(path, true) {
            Ok(path) if path.is_dir() => path,
            Ok(_) => return format!("Error: not a directory: {path}"),
            Err(error) => return format!("Error: {error}"),
        };
        let mut entries = match fs::read_dir(&root) {
            Ok(entries) => entries.flatten().collect::<Vec<_>>(),
            Err(error) => return format!("Error: {error}"),
        };
        entries.sort_by_key(|entry| entry.file_name());
        let mut lines = Vec::new();
        if long {
            lines.push(format!("total {}", entries.len()));
        }
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !all && name.starts_with('.') {
                continue;
            }
            let Ok(relative) = entry.path().strip_prefix(&self.root).map(Path::to_path_buf) else {
                continue;
            };
            if self.rules.is_ignored(&relative, &name) {
                continue;
            }
            if long {
                let metadata = entry.metadata().ok();
                let kind = metadata
                    .as_ref()
                    .map(|meta| if meta.is_dir() { 'd' } else { '-' })
                    .unwrap_or('?');
                let size = metadata.map(|meta| meta.len()).unwrap_or(0);
                lines.push(format!("{kind} {size:>10} {name}"));
            } else {
                lines.push(name);
            }
        }
        truncate_output(&lines.join("\n"))
    }

    fn glob(&self, pattern: Option<&str>, path: Option<&str>, type_filter: &str) -> String {
        let Some(pattern) = pattern.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid pattern".into();
        };
        let Some(path) = path.filter(|value| !value.is_empty()) else {
            return "Error: missing or invalid path".into();
        };
        if !["file", "directory", "all"].contains(&type_filter) {
            return "Error: type_filter must be file, directory, or all".into();
        }
        let root = match self.resolve_virtual(path, true) {
            Ok(path) if path.is_dir() => path,
            Ok(_) => return format!("Error: dir not found: {path}"),
            Err(error) => return format!("Error: {error}"),
        };
        let matcher = match Glob::new(pattern) {
            Ok(glob) => glob.compile_matcher(),
            Err(error) => return format!("Error: invalid glob: {error}"),
        };
        let mut matches = Vec::new();
        for entry in WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .follow_links(false)
            .build()
            .flatten()
        {
            if matches.len() >= GLOB_MAX_RESULTS {
                break;
            }
            let path = entry.path();
            if path == root {
                continue;
            }
            let Some(kind) = entry.file_type() else {
                continue;
            };
            if (type_filter == "file" && !kind.is_file())
                || (type_filter == "directory" && !kind.is_dir())
            {
                continue;
            }
            let Ok(relative_to_project) = path.strip_prefix(&self.root) else {
                continue;
            };
            let Ok(relative_to_search) = path.strip_prefix(&root) else {
                continue;
            };
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if self.rules.is_ignored(relative_to_project, name) {
                continue;
            }
            if matcher.is_match(relative_to_search) || matcher.is_match(name) {
                matches.push(self.virtualize(path));
            }
        }
        matches.sort();
        if matches.is_empty() {
            "(no matches)".into()
        } else {
            truncate_output(&matches.join("\n"))
        }
    }

    fn resolve_virtual(&self, virtual_path: &str, existing: bool) -> Result<PathBuf, String> {
        let normalized = virtual_path.replace('\\', "/");
        if is_windows_absolute(&normalized)
            || normalized.starts_with("//")
            || (normalized.starts_with('/')
                && normalized != "/codebase"
                && !normalized.starts_with("/codebase/"))
        {
            return Err(format!("path is outside project root: {virtual_path}"));
        }
        let relative = if normalized == "/codebase" {
            ""
        } else if let Some(relative) = normalized.strip_prefix("/codebase/") {
            relative
        } else {
            &normalized
        };
        let relative_path = Path::new(relative);
        if relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(format!("path is outside project root: {virtual_path}"));
        }
        if !relative_path.as_os_str().is_empty() {
            let file_name = relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if self.rules.is_ignored(relative_path, file_name) {
                return Err(format!("path is excluded from code search: {virtual_path}"));
            }
        }
        let candidate = self.root.join(relative_path);
        assert_lexically_within(&self.root, &candidate, virtual_path)?;
        if existing && candidate.exists() {
            let canonical = candidate
                .canonicalize()
                .map_err(|error| format!("failed to resolve path {virtual_path}: {error}"))?;
            assert_lexically_within(&self.root, &canonical, virtual_path)?;
            if let Ok(relative) = canonical.strip_prefix(&self.root) {
                let file_name = canonical
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                if self.rules.is_ignored(relative, file_name) {
                    return Err(format!("path is excluded from code search: {virtual_path}"));
                }
            }
            Ok(canonical)
        } else {
            Ok(candidate)
        }
    }

    fn virtualize(&self, path: &Path) -> String {
        match path.strip_prefix(&self.root) {
            Ok(relative) if relative.as_os_str().is_empty() => "/codebase".into(),
            Ok(relative) => format!(
                "/codebase/{}",
                relative.to_string_lossy().replace('\\', "/")
            ),
            Err(_) => "/codebase".into(),
        }
    }
}

fn value_glob_set(values: Option<&Vec<Value>>, negate: bool) -> Result<Option<GlobSet>, String> {
    let Some(values) = values else {
        return Ok(None);
    };
    let mut builder = GlobSetBuilder::new();
    let mut count = 0;
    for value in values {
        let Some(pattern) = value.as_str() else {
            return Err("glob arrays must contain strings".into());
        };
        let pattern = if negate {
            pattern.strip_prefix('!').unwrap_or(pattern)
        } else {
            pattern
        };
        builder
            .add(Glob::new(pattern).map_err(|error| format!("invalid glob {pattern:?}: {error}"))?);
        count += 1;
    }
    if count == 0 {
        Ok(None)
    } else {
        builder
            .build()
            .map(Some)
            .map_err(|error| format!("failed to build glob set: {error}"))
    }
}

fn assert_lexically_within(root: &Path, candidate: &Path, original: &str) -> Result<(), String> {
    if candidate == root || candidate.starts_with(root) {
        Ok(())
    } else {
        Err(format!("path is outside project root: {original}"))
    }
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn truncate_output(text: &str) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    let mut output = lines
        .iter()
        .take(RESULT_MAX_LINES)
        .map(|line| truncate_line(line))
        .collect::<Vec<_>>()
        .join("\n");
    if lines.len() > RESULT_MAX_LINES {
        output.push_str("\n... (lines truncated) ...");
    }
    output
}

fn truncate_line(line: &str) -> String {
    line.chars().take(LINE_MAX_CHARS).collect()
}

pub fn build_tree(
    scan_root: &Path,
    virtual_root: &str,
    max_depth: usize,
    project_root: &Path,
    rules: &IgnoreRules,
    max_bytes: usize,
) -> String {
    let mut state = TreeState {
        lines: vec![virtual_root.to_string()],
        bytes: virtual_root.len() + 1,
        entries: 0,
        max_bytes: min(max_bytes, MAX_TREE_BYTES),
        truncated: false,
    };
    walk_tree(
        scan_root,
        "",
        "",
        max_depth.clamp(1, 8),
        project_root,
        rules,
        &mut state,
    );
    state.lines.join("\n")
}

struct TreeEntry {
    name: String,
    path: PathBuf,
    is_dir: bool,
    is_symlink: bool,
}

struct TreeState {
    lines: Vec<String>,
    bytes: usize,
    entries: usize,
    max_bytes: usize,
    truncated: bool,
}

fn walk_tree(
    directory: &Path,
    relative_directory: &str,
    prefix: &str,
    depth: usize,
    project_root: &Path,
    rules: &IgnoreRules,
    state: &mut TreeState,
) {
    if depth == 0 || state.truncated {
        return;
    }
    let mut entries = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let relative = path.strip_prefix(project_root).ok()?;
            if rules.is_ignored(relative, &name) {
                return None;
            }
            let metadata = fs::symlink_metadata(&path).ok()?;
            Some(TreeEntry {
                name,
                path,
                is_dir: metadata.is_dir(),
                is_symlink: metadata.file_type().is_symlink(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.cmp(&right.name))
    });

    let entry_count = entries.len();
    for (index, entry) in entries.into_iter().enumerate() {
        let is_last = index + 1 == entry_count;
        let connector = if is_last { "└── " } else { "├── " };
        let line = format!("{prefix}{connector}{}", entry.name);
        let next_bytes = state.bytes + line.len() + 1;
        if state.entries >= MAX_TREE_ENTRIES || next_bytes > state.max_bytes {
            state.lines.push("... (tree truncated)".into());
            state.truncated = true;
            return;
        }
        state.lines.push(line);
        state.entries += 1;
        state.bytes = next_bytes;
        if entry.is_dir && !entry.is_symlink {
            let child_prefix = format!("{prefix}{}", if is_last { "    " } else { "│   " });
            let child_relative = if relative_directory.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative_directory}/{}", entry.name)
            };
            walk_tree(
                &entry.path,
                &child_relative,
                &child_prefix,
                depth - 1,
                project_root,
                rules,
                state,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use serde_json::json;

    use super::*;

    fn fixture() -> (tempfile::TempDir, ToolExecutor) {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("src")).unwrap();
        fs::write(
            temp.path().join("src/lib.rs"),
            "pub fn alpha() {}\npub fn beta() { alpha(); }\n",
        )
        .unwrap();
        fs::write(temp.path().join(".env"), "YCE_RELAY_TOKEN=secret").unwrap();
        fs::create_dir_all(temp.path().join("node_modules/pkg")).unwrap();
        fs::write(temp.path().join("node_modules/pkg/index.js"), "alpha").unwrap();
        let executor = ToolExecutor::new(temp.path(), &[]).unwrap();
        (temp, executor)
    }

    #[test]
    fn rejects_parent_absolute_windows_and_symlink_escapes() {
        let (temp, executor) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        symlink(outside.path(), temp.path().join("outside")).unwrap();

        for path in ["../secret", "/etc/passwd", "C:/Windows/System32"] {
            assert!(executor.resolve_virtual(path, true).is_err(), "{path}");
        }
        assert!(executor
            .resolve_virtual("/codebase/outside/secret", true)
            .is_err());
        assert!(executor.resolve_virtual("/codebase/.env", true).is_err());
    }

    #[test]
    fn restricted_commands_search_read_and_ignore_noise() {
        let (_temp, mut executor) = fixture();
        let output = executor.execute_tool_call(
            &json!({
                "command1":{"type":"rg","pattern":"alpha","path":"/codebase"},
                "command2":{"type":"readfile","file":"/codebase/src/lib.rs","start_line":2,"end_line":2},
                "command3":{"type":"tree","path":"/codebase","levels":2}
            }),
            8,
        );
        assert!(output.contains("/codebase/src/lib.rs:1:"));
        assert!(output.contains("2:pub fn beta"));
        assert!(!output.contains("node_modules"));
        assert_eq!(executor.collected_rg_patterns(), ["alpha"]);
    }
}
