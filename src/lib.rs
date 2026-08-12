pub mod config;
pub mod enhance;
pub mod error;
pub mod model;
pub mod network;
pub mod orchestrator;
pub mod output;
pub mod plan;
pub mod protocol;
pub mod search;
pub mod task_store;
pub mod tools;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use config::RuntimeConfig;
use orchestrator::YceService;
use protocol::McpServer;

pub struct RunOptions {
    pub runtime_root: PathBuf,
    pub default_cwd: Option<PathBuf>,
    pub tool_timeout: Duration,
}

pub async fn run(options: RunOptions) -> Result<()> {
    let config = RuntimeConfig::load(&options.runtime_root)?;
    let service = Arc::new(YceService::new(config, options.tool_timeout)?);
    let server = McpServer::new(service, options.default_cwd);
    protocol::run_stdio(server).await
}
