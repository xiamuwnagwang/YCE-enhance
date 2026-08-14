# 联网检索

联网是**外部事实依据与调研**，不是代码定位。CLI 不按关键词自动触发；必须由调用方显式传 `--mode network` 或 `--with-network`。

## 应当联网

- 当前 / 实时外部信息（版本、发布说明、新闻、政策）
- 官方库 / API 文档、公开规范、上游 changelog
- 多源核对、竞品对照、行业最佳实践
- 公开 GitHub 仓库架构等项目外资料
- 代码任务要和外部权威资料对照：在 `search` / `auto` / `enhance` 上加 `--with-network`

## 不要联网

- 纯仓库内定位、改代码、读本仓文档
- 用户已给出可直接使用的 URL / 粘贴正文
- 没有 `YCE_RELAY_TOKEN` 时不要假装已联网

## 链路

```text
POST {YCE_RELAY_URL}/yce/network-search
Authorization: Bearer {YCE_RELAY_TOKEN}
body: { request_id, query, profile, library?, repo? }
```

结果在 `<network-search result-present="true">` 的 evidence / summaries。写结论时保留来源 URL；多源冲突要标明，不要硬合并。联网失败不会抹掉已成功的代码 search。

常见错误（source 多为 `network-search`）：`AUTH_ERROR`、`QUOTA_EXCEEDED`、`DISABLED`、`TIMEOUT`、`EMPTY_RESULT`、`EXEC_ERROR`。
