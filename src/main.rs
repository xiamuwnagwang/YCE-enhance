use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use clap::Parser;

const DEFAULT_TOOL_TIMEOUT_MS: u64 = 660_000;
const MAX_TOOL_TIMEOUT_MS: u64 = 1_800_000;

#[derive(Parser)]
#[command(name = "yce-mcp", version, about = "YCE 原生 Rust stdio MCP 服务")]
struct Args {
    /// search_code / auto 未传 cwd 时使用的项目绝对路径。
    #[arg(long, env = "YCE_MCP_DEFAULT_CWD", value_name = "PATH")]
    default_cwd: Option<PathBuf>,

    /// 单次 MCP 工具调用总超时，单位毫秒。
    #[arg(
        long,
        env = "YCE_MCP_TOOL_TIMEOUT_MS",
        default_value_t = DEFAULT_TOOL_TIMEOUT_MS,
        value_parser = clap::value_parser!(u64).range(1_000..=MAX_TOOL_TIMEOUT_MS)
    )]
    tool_timeout_ms: u64,

    /// YCE MCP 运行根目录；用于读取 .env，默认从二进制位置或当前目录向上查找。
    #[arg(long, env = "YCE_MCP_RUNTIME_ROOT", value_name = "PATH")]
    runtime_root: Option<PathBuf>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = start().await {
        eprintln!("yce-mcp: {error:#}");
        std::process::exit(1);
    }
}

async fn start() -> Result<()> {
    let args = Args::parse();
    let runtime_root = match args.runtime_root {
        Some(path) => validate_runtime_root(path)?,
        None => discover_runtime_root()?,
    };
    let default_cwd = args.default_cwd.map(validate_project_dir).transpose()?;

    yce_mcp::run(yce_mcp::RunOptions {
        runtime_root,
        default_cwd,
        tool_timeout: Duration::from_millis(args.tool_timeout_ms),
    })
    .await
}

fn validate_project_dir(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(anyhow!("default-cwd 必须是绝对路径：{}", path.display()));
    }
    let canonical = path
        .canonicalize()
        .with_context(|| format!("default-cwd 不存在：{}", path.display()))?;
    if !canonical.is_dir() {
        return Err(anyhow!("default-cwd 不是目录：{}", canonical.display()));
    }
    Ok(canonical)
}

fn validate_runtime_root(path: PathBuf) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("YCE MCP 运行根目录不存在：{}", path.display()))?;
    if !canonical.is_dir() {
        return Err(anyhow!(
            "YCE MCP 运行根目录不是目录：{}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn discover_runtime_root() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    candidates.push(std::env::current_dir().context("无法读取当前目录")?);

    for start in candidates {
        if let Some(found) = find_ancestor_with_runtime_marker(&start) {
            return validate_runtime_root(found);
        }
    }
    Err(anyhow!(
        "无法定位 YCE MCP 运行根目录；请传 --runtime-root 或设置 YCE_MCP_RUNTIME_ROOT"
    ))
}

fn find_ancestor_with_runtime_marker(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| candidate.join(".yce-mcp-root").is_file())
        .map(Path::to_path_buf)
}
