# 上下文传入规范

## 格式

```
User: 用户的第一条消息
AI: 助手的回复
User: 用户的第二条消息
AI: 助手的回复
```

## 策略

| 对话长度 | 做法 |
|---------|------|
| < 2000 字 | 完整传入 |
| > 2000 字 | 最近 3-5 轮 + 摘要 |
| 涉及代码 | 关键代码片段包含在 history 中 |
| 首轮对话 | history 留空或传入项目背景信息 |

## 示例

```bash
# 多轮对话
node <skill-dir>/scripts/youwen.js enhance "帮我优化这个组件" \
  --history "User: 我在用 React + TypeScript 开发后台\nAI: 好的，需要什么帮助\nUser: 表格性能很差" \
  --auto-confirm --auto-skills

# 首轮对话（无历史）
node <skill-dir>/scripts/youwen.js enhance "React useEffect 怎么处理异步请求" \
  --auto-confirm --auto-skills
```
