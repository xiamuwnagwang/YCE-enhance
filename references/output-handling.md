# 输出处理规范

## 成功时

stdout 输出使用 XML 标签格式（LLM 解析准确率最高）：

```xml
<enhanced>
增强后的提示词内容...
</enhanced>
<auto-skills>
<skill name="ace" reason="推荐使用 ace 辅助完成任务" command="bash ..." />
<skill name="pplx" reason="联网搜索实时信息" />
</auto-skills>
```

标签说明：
- `<enhanced>`: 增强后的提示词（Agent4 输出）
- `<auto-skills>`: 推荐 Skill 列表（最多 5 个）
  - `name`: Skill 名称
  - `reason`: 推荐理由（从 Skill 描述中提取）
  - `command`: 调用命令（如有）

处理步骤：
1. 读取 `<enhanced>` 标签内容作为增强提示词展示给用户
2. 解析 `<auto-skills>` 中的 `<skill>` 标签，按需调用推荐的工具
3. 基于增强提示词继续回答用户

## 失败时（exit code 非 0）

直接使用用户原始提示词回答，不要报错或中断对话。

## 常见失败原因

- 后端服务未启动
- 网络不可达
- 兑换码无效或已过期
