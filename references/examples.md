# 调用示例

在 YCE skill 根目录执行。每次调用后把 stdout 写入文件并用 `node ./scripts/validate-yce-result.mjs` 校验。

```bash
# auto
node ./scripts/yce.js "Help me find where this provider is handled" \
  --mode auto \
  --history "User: I am reviewing the provider logic\nAI: The related code spans multiple modules\nUser: Help me find where this provider is handled" \
  --cwd "/absolute/path/to/project" \
  --xml-pretty

# enhance（只增强，不定位代码）
node ./scripts/yce.js "优化这个任务描述" --mode enhance --history "User: ...\nAI: ..." --xml-pretty

# 快速增强（无 YCE XML）
node ./scripts/prompt-enhance.js enhance "快速整理这个需求" --mode direct --language zh-CN

# search
node ./scripts/yce.js "Locate the provider list retrieval logic" \
  --mode search --cwd "/absolute/path/to/project" --tree-depth 0 --max-results 10 --xml-pretty

# network
node ./scripts/yce.js "What is the latest official React useEffect guidance" \
  --mode network --network-profile balanced --xml-pretty

# search + 外部对照
node ./scripts/yce.js "Locate provider list logic and compare with latest official docs" \
  --mode search --with-network --cwd "/absolute/path/to/project" --xml-pretty

# plan
node ./scripts/yce.js "Migrate login sessions to Redis with backward compatibility" \
  --mode plan --with-search --cwd "/absolute/path/to/project" --language zh-CN --xml-pretty

# plan 落盘
node ./scripts/yce.js "Add rate limiting middleware to the Go service" \
  --mode plan --save "./docs/plans" --xml-pretty

# 任务锚点（纯本地）
node ./scripts/yce.js task show --cwd "/absolute/path/to/project"
node ./scripts/yce.js task check 1 --task t-20260812-ab12cd --evidence "已列出会话读写点" --cwd "/absolute/path/to/project"
node ./scripts/yce.js task done --task t-20260812-ab12cd --cwd "/absolute/path/to/project"

# 调试入口（不是 YCE XML）
node ./vendor/yce-engine/yce-engine.mjs --project "/absolute/path/to/project" --query "Locate the provider list retrieval logic"
node ./vendor/yce-engine/yce-engine.mjs --check-key
node ./scripts/yce.js --help
```
