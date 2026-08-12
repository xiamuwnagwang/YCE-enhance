use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use globset::{Glob, GlobMatcher};

use crate::error::YceError;

pub const DEFAULT_EXCLUDES: &[&str] = &[
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "target",
    "build",
    "coverage",
    "out",
    ".cache",
    "vendor",
    "deps",
    "third_party",
    "logs",
    "data",
    "*.min.*",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".ssh",
    "*.pem",
    "*.key",
    "id_rsa*",
    "id_ed25519*",
];

#[derive(Debug)]
pub struct IgnoreRules {
    pub source: Option<PathBuf>,
    pub patterns: Vec<String>,
    matchers: Vec<GlobMatcher>,
}

impl IgnoreRules {
    pub fn load(root: &Path, extra: &[String]) -> Result<Self, YceError> {
        let source = root.join(".yceignore");
        let mut patterns = Vec::new();
        let mut seen = HashSet::new();
        for pattern in DEFAULT_EXCLUDES
            .iter()
            .copied()
            .map(str::to_string)
            .chain(extra.iter().cloned())
            .chain(read_ignore_file(&source)?.into_iter())
        {
            let pattern = pattern.trim();
            if pattern.is_empty() || pattern.contains('\0') || !seen.insert(pattern.to_string()) {
                continue;
            }
            patterns.push(pattern.to_string());
        }
        let mut matchers = Vec::new();
        for pattern in &patterns {
            for candidate in normalized_candidates(pattern) {
                let glob = Glob::new(&candidate).map_err(|error| {
                    YceError::InvalidArguments(format!("无效的排除规则 {pattern:?}：{error}"))
                })?;
                matchers.push(glob.compile_matcher());
            }
        }
        Ok(Self {
            source: source.is_file().then_some(source),
            patterns,
            matchers,
        })
    }

    pub fn is_ignored(&self, relative: &Path, file_name: &str) -> bool {
        let relative = relative.to_string_lossy().replace('\\', "/");
        self.matchers
            .iter()
            .any(|matcher| matcher.is_match(&relative) || matcher.is_match(file_name))
    }
}

fn read_ignore_file(path: &Path) -> Result<Vec<String>, YceError> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| YceError::Internal(format!("无法读取 {}：{error}", path.display())))?;
    Ok(content
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.contains('\0'))
        .map(str::to_string)
        .collect())
}

fn normalized_candidates(pattern: &str) -> Vec<String> {
    let pattern = pattern
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    if pattern.contains('/') {
        vec![pattern]
    } else {
        vec![
            pattern.clone(),
            format!("**/{pattern}"),
            format!("**/{pattern}/**"),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_project_rules_are_combined() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join(".yceignore"),
            "\u{feff}# comment\nsecrets\n*.generated.rs\nsecrets\n",
        )
        .unwrap();
        let rules = IgnoreRules::load(temp.path(), &["custom".into()]).unwrap();
        assert!(rules.is_ignored(Path::new("src/node_modules/a.js"), "a.js"));
        assert!(rules.is_ignored(Path::new("secrets/token"), "token"));
        assert!(rules.is_ignored(Path::new("src/a.generated.rs"), "a.generated.rs"));
        assert!(rules.is_ignored(Path::new("custom/x"), "x"));
        assert!(rules.is_ignored(Path::new(".env"), ".env"));
        assert!(!rules.is_ignored(Path::new(".env.example"), ".env.example"));
        assert!(rules.source.is_some());
    }
}
