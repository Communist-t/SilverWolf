# 银狼 Agent — 后端 API 接口文档

> 本文档基于当前源码整理（`src/routes/*.ts` + `src/app.ts`），供前端联调与独立启动后端排查问题使用。
> 基路径：后端默认监听 `http://127.0.0.1:3000`。

---

## 目录

1. [通用约定](#通用约定)
2. [鉴权方式](#鉴权方式)
3. [健康检查 / 状态](#健康检查--状态)
4. [聊天 / 对话（chat）](#聊天--对话chat)
5. [会话历史（history）](#会话历史history)
6. [用户认证（auth）](#用户认证auth)
7. [长期记忆（memory）](#长期记忆memory)
8. [模型与技能设置（settings）](#模型与技能设置settings)
9. [SSE 事件契约](#sse-事件契约)
10. [页面与静态资源路由](#页面与静态资源路由)

---

## 通用约定

- 请求体一律为 `application/json`。
- 成功响应返回对应 JSON；失败统一返回 `{ "error": "<中文错误信息>" }` + 对应 HTTP 状态码。
- 错误码约定：
  - `400` 参数错误 / 校验失败
  - `401` 未登录 / 令牌失效
  - `403` 无权限
  - `404` 资源不存在
  - `409` 冲突（会话已存在、正在生成、验证码已用等）
  - `413` 请求体超限（16MB，详见 `app.ts` bodyLimit）
  - `429` 频率限制（验证码 60s 一次）
  - `500` 服务器内部错误

---

## 鉴权方式

| Header | 用途 | 来源 |
|--------|------|------|
| `Authorization: Bearer <token>` | 可选的 **应用级访问令牌**（`APP_AUTH_TOKEN`） | `.env` |
| `X-User-Token: <token>` | **用户登录令牌**，标识"记忆归属人 ownerId" | 登录/注册时返回的 `token` |

- 应用级令牌（`APP_AUTH_TOKEN`）由 `app.ts` 中间件统一拦截 `/chat/*`（非 GET）、`/history/*`、`/memory/*`、`/settings/*`；`/auth/*` 与 GET 请求不拦截。
- 用户表 `user_tokens.token` 用于把请求归属到某个用户；未登录（无 `X-User-Token`）时默认 `ownerId = "local-default"`。
- 浏览器访问 `/chat`、`/history`、`/memory`、`/settings` 时，如服务处于免认证模式，无需携带任何令牌。

---

## 健康检查 / 状态

### `GET /health`

健康检查，返回服务状态与缓存统计。

```json
{
  "status": "ok",
  "character": "Silver Wolf",
  "service": "silver-wolf-agent",
  "caches": {
    "conversations": { "entries": 0, "maxEntries": 100 },
    "search": 0
  }
}
```

### `GET /auth/status`

查询应用是否开启了应用级认证（无需令牌）。

```json
{ "required": false, "authenticated": true }
```

---

## 聊天 / 对话（chat）

### `POST /chat`

非流式对话，等待完整回复后返回 JSON。

请求：

```json
{ "message": "你好，今天武汉天气怎么样？", "sessionId": "default" }
```

响应（`SendMessageResult`）：

```json
{
  "reply": "银狼的回复文本……",
  "sessionId": "default",
  "webSearch": {
    "used": true,
    "query": "武汉 今日 天气",
    "queries": ["武汉 今日天气", "武汉 2026-08-13 今日天气"],
    "intent": "weather",
    "reason": "weather-signal",
    "results": [{ "title": "", "url": "", "snippet": "", "sourceType": "", "score": 0 }],
    "provider": "weather",
    "fetchedAt": "2026-08-13T00:00:00.000Z",
    "fromCache": false,
    "status": "success"
  },
  "newsSearch": { "used": false },
  "memory": { "recalled": 0, "activated": 0, "candidates": 0, "deleted": 0 }
}
```

字段说明：
- `message`：必填，≤ 12000 字符；`sessionId`：可选，默认 `"default"`。
- `webSearch`：仅在判定需要联网时返回；`results[].url` 供前端渲染来源卡片。
- `newsSearch`：命中新闻查询时返回。
- `memory`：永久记忆统计（召回数 / 激活数 / 候选数 / 遗忘数）。

校验错误：`400`（message 缺失）、`413`（消息过长）、`409`（requestId 冲突或该会话正在生成回复）、`500`（生成失败）。

### `POST /chat/stream`（SSE 流式）

请求：

```json
{
  "message": "给我讲讲银狼的同人作品",
  "sessionId": "default",
  "requestId": "req-...",
  "attachments": [
    { "name": "a.png", "type": "image/png", "size": 1024, "data": "<base64>" }
  ]
}
```

- `requestId`：可选，缺省自动生成；用于 `/chat/cancel/:requestId`。
- `attachments`：可选。图片走 `image_url` 多模态；`.txt/.md/.csv/.json/.xml/.html/.css/.js/.ts/.py/.java/.c/.cpp/.go/.rs` 会解码为文本预览；其余仅记录文件名与大小。
- 响应为 `text/event-stream`，事件名 = 事件类型（详见 [SSE 事件契约](#sse-事件契约)）。
- 单会话并发互斥：同一 `sessionId` 同时只能有一个生成请求（返回 409）。
- 请求超时默认 90s（`REQUEST_TIMEOUT_MS`）。

### `POST /chat/cancel/:requestId`

中断正在进行的生成请求。

```json
{ "ok": true, "requestId": "req-..." }
```

若请求不存在返回 `{ "error": "请求不存在或已结束" }` + 404。

---

## 会话历史（history）

### `GET /history/info`

```json
{ "storage": "postgresql", "persistent": true }
```

### `GET /history/sessions?limit=50`

列出会话（按 `updated_at` 倒序）。

```json
{
  "sessions": [
    {
      "id": "web-xxxx",
      "ownerId": "local-default",
      "title": "新对话",
      "createdAt": "2026-08-13T00:00:00.000Z",
      "updatedAt": "2026-08-13T01:00:00.000Z",
      "messageCount": 2,
      "hasSummary": false
    }
  ]
}
```

### `POST /history/sessions`

创建会话（可选指定 `id`，否则后端生成 `web-uuid`）。

```json
{ "title": "新对话", "id": "web-abc" }
```

201 响应：`{ "session": { ... } }`；已存在返回 409。

### `POST /history/sessions/batch-delete`

```json
{ "ids": ["web-1", "web-2"] }
```

响应：`{ "ok": true, "deleted": ["web-1"] }`。单次 ≤ 200 个；有会话正在生成时返回 409。

### `PATCH /history/sessions/:sessionId`

重命名会话。请求：`{ "title": "新标题" }`。响应：`{ "session": { ... } }`。

### `GET /history/sessions/:sessionId/messages?limit=200`

获取会话消息（按 id 正序）。

```json
{
  "sessionId": "web-abc",
  "messages": [
    { "id": 1, "sessionId": "web-abc", "role": "user", "content": "...", "createdAt": "..." },
    { "id": 2, "sessionId": "web-abc", "role": "assistant", "content": "...", "createdAt": "..." }
  ]
}
```

### `GET /history/sessions/:sessionId/export`

导出整段对话为 Markdown 文件（`Content-Type: text/markdown`，`Content-Disposition` 附带下载文件名）。

### `GET /history/sessions/:sessionId/summary`

```json
{ "sessionId": "web-abc", "summary": { "sessionId": "web-abc", "content": "...", "summarizedThroughMessageId": 100, "updatedAt": "..." } }
```

无摘要时 `summary` 为 `null`。

### `GET /history/sessions/:sessionId/tools?limit=20`

最近工具运行记录。

```json
{
  "sessionId": "web-abc",
  "toolRuns": [
    {
      "id": 1,
      "sessionId": "web-abc",
      "toolType": "web_search",
      "intent": "weather",
      "query": "武汉 今日 天气",
      "queries": ["..."],
      "provider": "weather",
      "results": [],
      "status": "success",
      "error": null,
      "fetchedAt": "...",
      "expiresAt": "...",
      "expired": false
    }
  ]
}
```

### `DELETE /history/sessions/:sessionId/messages`

清空某会话的消息（保留会话）。响应：`{ "ok": true, "sessionId": "..." }`。会话正生成时返回 409。

### `DELETE /history/sessions/:sessionId`

删除整个会话。响应：`{ "ok": true, "sessionId": "..." }`。

> 所有 history 接口都会校验会话归属（`ownerId`），不归属当前用户时返回 404（防越权）。

---

## 用户认证（auth）

### `POST /auth/send-code`

发送邮箱注册验证码（60 秒内同一邮箱限发一次）。

```json
{ "email": "user@example.com" }
```

响应：`{ "message": "验证码已发送" }`（**注意：无 `success` 字段**）。该邮箱已注册返回 409。

### `POST /auth/register`

```json
{ "email": "user@example.com", "code": "123456", "password": "123456", "confirmPassword": "123456" }
```

响应：`{ "token": "<uuid>", "user": { "id", "email", "displayName", "avatarUrl", "role", "createdAt" } }`。

### `POST /auth/login`

```json
{ "account": "user@example.com", "password": "123456" }
```

`account` 支持邮箱或 `display_name`。成功响应同上 `{ token, user }`；失败 401。

### `GET /auth/user`

需 `X-User-Token`。返回 `{ "user": { id, email, displayName, avatarUrl, role, createdAt } }`。

### `PATCH /auth/user`

更新昵称/头像。请求头需 `X-User-Token`。

```json
{ "displayName": "新昵称", "avatarUrl": "data:image/jpeg;base64,..." }
```

- `displayName`：1-24 字符，管理员不可改。
- `avatarUrl`：仅允许 `data:image/(png|jpeg|webp);base64,` 前缀，≤ 48KB。

响应：`{ "user": { ... } }`。

### `POST /auth/logout`

需 `X-User-Token`，撤销该令牌。响应：`{ "message": "已退出登录" }`。

---

## 长期记忆（memory）

> 认证：`X-User-Token` 缺失或失效 → 401。

### `GET /memory?candidates=1`

列出长期记忆（默认仅 active；`candidates=1` 时含候选），并附带统计。

```json
{
  "memories": [
    {
      "id": 1,
      "ownerId": "local-default",
      "memoryKey": "profile:name",
      "category": "profile",
      "content": "玩家的称呼是小美",
      "keywords": ["小美"],
      "status": "active",
      "evidenceCount": 1,
      "confidence": 0.98,
      "explicit": true,
      "sourceSessionId": "web-abc",
      "createdAt": "...",
      "updatedAt": "...",
      "lastRecalledAt": null
    }
  ],
  "stats": { "active": 1, "candidates": 0 }
}
```

`stats` 仅含 `active` / `candidates` 两个字段。

### `GET /memory/stats`

```json
{ "stats": { "active": 1, "candidates": 0 } }
```

### `DELETE /memory/:memoryId`

遗忘单条记忆。响应：`{ "ok": true, "memory": { "deleted": 1, "memoryId": 1 } }`；不存在 404。

### `DELETE /memory`

清空当前用户所有长期记忆。响应：`{ "ok": true, "deleted": 12 }`。

---

## 模型与技能设置（settings）

> 认证：受 `APP_AUTH_TOKEN` 保护（若启用）。

### `GET /settings/models`

```json
{
  "activeModel": { "id", "label", "provider", "baseURL", "model", "hasApiKey": true, "active": true, "builtIn": true, "createdAt", "updatedAt" },
  "models": [ ...同上，不含 apiKey... ],
  "templates": { "deepseek": { "label": "DeepSeek", "provider": "DeepSeek", "baseURL": "https://api.deepseek.com/v1", "model": "deepseek-chat" } }
}
```

`models[].apiKey` 永远不会返回，只给 `hasApiKey` 布尔值。

### `GET /settings/skills`

```json
{
  "skills": [
    { "name": "web-search", "description": "通用联网搜索，多引擎自动降级", "version": "1.0.0", "status": "online", "builtIn": true }
  ]
}
```

当前技能：`web-search`、`weather`、`technology-news-search`。

### `POST /settings/models/test`

在线测试模型连通性（15 秒超时）。请求（可直接填新配置，或传 `modelId` 复用已存 Key）：

```json
{ "label": "DeepSeek", "provider": "DeepSeek", "baseURL": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "sk-...", "modelId": "可选" }
```

成功：`{ "ok": true, "model": "...", "replyPreview": "..." }`；失败 400 + `{ "error": "测试失败：..." }`（自动脱敏 apiKey）。

### `POST /settings/models`

新增模型配置。请求：`{ label, baseURL, model, apiKey, provider? }`。

- `apiKey` 为空时：若 `baseURL+model` 兼容 OpenAI，回退用环境变量 `LLM_API_KEY`。
- 首个配置会自动激活。

201 返回 `{ "model": { ...公有字段... } }`。校验失败 400。

### `PATCH /settings/models/:modelId`

部分更新（label / provider / baseURL / model / apiKey 任一）。内置配置（`builtIn`）不可改 → 404。响应 `{ "model": { ... } }`。

### `POST /settings/models/:modelId/activate`

切换为当前激活模型（已有 active 会被解除，数据库唯一索引保证同时只有一个 active）。响应 `{ "activeModel": { ... } }`。

### `DELETE /settings/models/:modelId`

删除配置；当前激活的或内置默认可删除需特别注意 —— 不可删除或正在使用时返回 400。响应 `{ "ok": true }`。

---

## SSE 事件契约

`POST /chat/stream` 返回 `text/event-stream`，每个事件格式为：

```
event: <type>
data: <JSON>

```

| event | data 重要字段 | 说明 |
|-------|---------------|------|
| `delta` | `{ type, content: "<增量文本>" }` | 回复正文增量（前端需累积拼接） |
| `step` | `{ type, name, content }` | 过程步骤：`input` / `rag` / `tool_decision` / `web_search` / `memory` / `permanent_memory` / `llm` / `database` / `compression` / `news_search` |
| `source` | `{ type, content: { index, title, url, snippet, sourceType, score } }` | 联网来源卡片（`index` 从 1 开始） |
| `done` | `{ type, content: SendMessageResult }` | 对话完成（唯一结束信号） |
| `error` | `{ type, content: "<错误信息>" }` | 出错（不视为正常结束） |

前端解析时应以 `done`/`error` 终止流，`delta` 只累积到正文，`step`/`source` 渲染到过程区。

---

## 页面与静态资源路由

后端同时托管前端静态资源（`root = ./public`）：

| 路径 | 行为 |
|------|------|
| `GET /` | 302 → `/landing` |
| `GET /landing` | `landing.html` |
| `GET /login` | `login.html`（独立内联脚本身份认证） |
| `GET /chat` | `index.html`（SPA 主聊天页，`<script type="module" src="/scripts/main.js">`） |
| `/*` | `serveStatic(root=./public)`，提供 `assets/`、`styles/`、`scripts/`、`vendor/`、`config.js` |
| 其它非 API 404 | 回退返回 `index.html`（支持前端路由） |