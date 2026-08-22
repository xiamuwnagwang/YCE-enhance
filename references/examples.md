# 调用示例

在 YCE skill 根目录执行。结果自动落盘，stdout 只回收据；不要自己重定向 stdout。看退出码，再按需读收据里的 `result_file`。

```bash
# auto
node ./scripts/yce.js "Help me find where this provider is handled" \
  --mode auto \
  --history "User: I am reviewing the provider logic\nAI: The related code spans multiple modules\nUser: Help me find where this provider is handled" \
  --cwd "/absolute/path/to/project"

# enhance（只增强，不定位代码）
node ./scripts/yce.js "优化这个任务描述" --mode enhance --history "User: ...\nAI: ..."

# 快速增强（无 YCE XML）
node ./scripts/prompt-enhance.js enhance "快速整理这个需求" --mode direct --language zh-CN

# search
node ./scripts/yce.js "Locate the provider list retrieval logic" \
  --mode search --cwd "/absolute/path/to/project" --tree-depth 0 --max-results 10

# network
node ./scripts/yce.js "What is the latest official React useEffect guidance" \
  --mode network --network-profile balanced

# search + 外部对照
node ./scripts/yce.js "Locate provider list logic and compare with latest official docs" \
  --mode search --with-network --cwd "/absolute/path/to/project"

# plan
node ./scripts/yce.js "Migrate login sessions to Redis with backward compatibility" \
  --mode plan --with-search --cwd "/absolute/path/to/project" --language zh-CN

# plan（网页搜索不是默认唯一来源；可叠加仓库代码/手工上下文）
node ./scripts/yce.js "Review this plan using the supplied context" \
  --mode plan --search-context "Existing constraints: sessions expire after 30 minutes" \
  --history "User: preserve backward compatibility" \
  --no-web-search

# plan 落盘（--save 存 Markdown 计划，--out 存 YCE XML，互不影响）
node ./scripts/yce.js "Add rate limiting middleware to the Go service" \
  --mode plan --save "./docs/plans"

# 指定 XML 落盘位置
node ./scripts/yce.js "Locate the retry policy" \
  --mode search --cwd "/absolute/path/to/project" --out "./tmp/yce-retry.xml"

# 事后复核某份结果文件
node ./scripts/validate-yce-result.mjs "/tmp/yce-results/yce-search-20260815T022728-7735.xml"

# 需要管道时才回到旧行为（此时主机可能截断，没有哨兵保护）
node ./scripts/yce.js "Locate the retry policy" \
  --mode search --cwd "/absolute/path/to/project" --stdout-xml --xml-pretty | head -40

# 任务锚点（纯本地）
node ./scripts/yce.js task show --cwd "/absolute/path/to/project"
node ./scripts/yce.js task check 1 --task t-20260812-ab12cd --evidence "已列出会话读写点" --cwd "/absolute/path/to/project"
node ./scripts/yce.js task done --task t-20260812-ab12cd --cwd "/absolute/path/to/project"

# 调试入口（不是 YCE XML）
node ./vendor/yce-engine/yce-engine.mjs --project "/absolute/path/to/project" --query "Locate the provider list retrieval logic"
node ./vendor/yce-engine/yce-engine.mjs --check-key
node ./scripts/yce.js --help
```
