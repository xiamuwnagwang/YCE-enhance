use std::fs;
use std::path::{Path, PathBuf};

use super::executor::build_tree;
use super::ignore::IgnoreRules;

const MAX_TREE_BYTES: usize = 250 * 1024;

#[derive(Debug, Clone)]
pub struct RepoMap {
    pub tree: String,
    pub depth: u8,
    pub requested_depth: u8,
    pub size_bytes: usize,
    pub fell_back: bool,
    pub auto_depth: bool,
    pub strategy: String,
    pub hot_dirs: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RepoMapOptions<'a> {
    pub query: &'a str,
    pub requested_depth: u8,
    pub mode: &'a str,
    pub bootstrap_tree_depth: u8,
    pub hotspot_top_k: u8,
    pub hotspot_tree_depth: u8,
    pub hotspot_max_bytes: usize,
    pub bootstrap_patterns: &'a [String],
    pub bootstrap_hot_dirs: &'a [String],
}

pub fn build_repo_map(root: &Path, rules: &IgnoreRules, options: &RepoMapOptions<'_>) -> RepoMap {
    if options.mode == "classic" {
        let base = adaptive_tree(root, rules, options.requested_depth, MAX_TREE_BYTES);
        return RepoMap {
            strategy: "classic".into(),
            hot_dirs: Vec::new(),
            ..base
        };
    }

    let bootstrap_depth = options.bootstrap_tree_depth.clamp(1, 3);
    let mut base = adaptive_tree(
        root,
        rules,
        bootstrap_depth,
        options.hotspot_max_bytes.clamp(16 * 1024, MAX_TREE_BYTES),
    );
    let hot_dirs = choose_hot_dirs(
        root,
        rules,
        options.query,
        options.bootstrap_patterns,
        options.bootstrap_hot_dirs,
        options.hotspot_top_k.clamp(0, 8) as usize,
    );
    let mut sections = Vec::new();
    for directory in &hot_dirs {
        let path = root.join(directory);
        let subtree = build_tree(
            &path,
            &format!("/codebase/{directory}"),
            options.hotspot_tree_depth.clamp(1, 4) as usize,
            root,
            rules,
            64 * 1024,
        );
        sections.push(subtree);
    }
    if !sections.is_empty() {
        let budget = options.hotspot_max_bytes.clamp(16 * 1024, MAX_TREE_BYTES);
        while !sections.is_empty() {
            let candidate = format!(
                "{}\n\n# Hotspot Subtrees\n{}",
                base.tree,
                sections.join("\n\n")
            );
            if candidate.len() <= budget {
                base.tree = candidate;
                break;
            }
            sections.pop();
        }
    }
    base.size_bytes = base.tree.len();
    base.strategy = "bootstrap_hotspot".into();
    base.hot_dirs = hot_dirs;
    base.requested_depth = options.requested_depth;
    base
}

fn adaptive_tree(
    root: &Path,
    rules: &IgnoreRules,
    requested_depth: u8,
    max_bytes: usize,
) -> RepoMap {
    let auto_depth = requested_depth == 0;
    let target_depth = if auto_depth {
        suggest_depth(root)
    } else {
        requested_depth.clamp(1, 6)
    };
    for depth in (1..=target_depth).rev() {
        let tree = build_tree(
            root,
            "/codebase",
            depth as usize,
            root,
            rules,
            max_bytes.saturating_add(8192),
        );
        let size_bytes = tree.len();
        if size_bytes <= max_bytes && !tree.ends_with("... (tree truncated)") {
            return RepoMap {
                tree,
                depth,
                requested_depth,
                size_bytes,
                fell_back: depth < target_depth,
                auto_depth,
                strategy: String::new(),
                hot_dirs: Vec::new(),
            };
        }
    }

    let mut entries = top_level_directories(root, rules)
        .into_iter()
        .map(|(_, name)| format!("├── {name}"))
        .take(1000)
        .collect::<Vec<_>>();
    entries.insert(0, "/codebase".into());
    let tree = entries.join("\n");
    RepoMap {
        size_bytes: tree.len(),
        tree,
        depth: 0,
        requested_depth,
        fell_back: true,
        auto_depth,
        strategy: String::new(),
        hot_dirs: Vec::new(),
    }
}

fn suggest_depth(root: &Path) -> u8 {
    let count = fs::read_dir(root)
        .map(|entries| entries.count())
        .unwrap_or(0);
    if count < 500 {
        4
    } else if count <= 5000 {
        3
    } else {
        2
    }
}

fn choose_hot_dirs(
    root: &Path,
    rules: &IgnoreRules,
    query: &str,
    bootstrap_patterns: &[String],
    bootstrap_hot_dirs: &[String],
    top_k: usize,
) -> Vec<String> {
    if top_k == 0 {
        return Vec::new();
    }
    let mut tokens = tokenize(query);
    for pattern in bootstrap_patterns {
        for token in tokenize(pattern) {
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
    }
    let common = [
        "src", "app", "lib", "packages", "services", "server", "backend", "frontend", "api",
    ];
    let mut scored = top_level_directories(root, rules)
        .into_iter()
        .map(|(_, name)| {
            let lower = name.to_ascii_lowercase();
            let mut score = usize::from(common.contains(&lower.as_str())) * 2;
            for token in &tokens {
                if lower.contains(token) || token.contains(&lower) {
                    score += 4;
                }
            }
            (score, name)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let mut selected = Vec::new();
    for hinted in bootstrap_hot_dirs {
        if scored.iter().any(|(_, name)| name == hinted) && !selected.contains(hinted) {
            selected.push(hinted.clone());
        }
    }
    for name in scored.into_iter().map(|(_, name)| name) {
        if selected.len() >= top_k {
            break;
        }
        if !selected.contains(&name) {
            selected.push(name);
        }
    }
    selected.truncate(top_k);
    selected
}

fn top_level_directories(root: &Path, rules: &IgnoreRules) -> Vec<(PathBuf, String)> {
    let mut output = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if rules.is_ignored(Path::new(&name), &name) {
                return None;
            }
            Some((path, name))
        })
        .collect::<Vec<_>>();
    output.sort_by(|left, right| left.1.cmp(&right.1));
    output
}

fn tokenize(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in query
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .filter(|token| token.len() >= 3)
    {
        if !tokens.iter().any(|existing| existing == token) {
            tokens.push(token.to_string());
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::ignore::IgnoreRules;

    #[test]
    fn repo_map_is_deterministic_and_excludes_noise() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("src/search")).unwrap();
        fs::create_dir_all(temp.path().join("node_modules/pkg")).unwrap();
        fs::write(temp.path().join("src/search/mod.rs"), "").unwrap();
        let rules = IgnoreRules::load(temp.path(), &[]).unwrap();
        let options = RepoMapOptions {
            query: "search engine",
            requested_depth: 3,
            mode: "bootstrap_hotspot",
            bootstrap_tree_depth: 1,
            hotspot_top_k: 2,
            hotspot_tree_depth: 2,
            hotspot_max_bytes: 64 * 1024,
            bootstrap_patterns: &[],
            bootstrap_hot_dirs: &[],
        };
        let map = build_repo_map(temp.path(), &rules, &options);
        assert!(map.tree.contains("/codebase"));
        assert!(map.tree.contains("src"));
        assert!(!map.tree.contains("node_modules"));
        assert_eq!(map.strategy, "bootstrap_hotspot");
    }
}
