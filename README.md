银狼 Agent App (src/)
├── app.ts          → Hono 应用入口，路由挂载
├── config.ts       → 环境配置（LLM、Server、Search、SMTP…）
├── index.ts        → 启动入口
├── logger.ts       → 日志模块
├── cli.ts          → CLI 入口
├── routes/
│   ├── chat.ts     → 聊天流式 SSE 端点
│   ├── settings.ts → **模型配置 CRUD API** (GET/POST/PATCH/DELETE /settings/models)
│   ├── auth.ts     → 登录/注册/验证码
│   ├── history.ts  → 会话历史管理
│   └── memory.ts   → 长期记忆
├── llm/
│   ├── model-configs.ts  → **核心模型配置管理** (SQLite 表 CRUD + 验证)
│   └── client.ts         → LLM 客户端适配层（读取 active model）
├── agent/          → Agent 逻辑（聊天、RAG、记忆、system prompt…）
├── db/             → SQLite 存储（会话、消息、摘要、工具运行记录）
└── tools/          → 工具（网络搜索、安全过滤等）

前端 (public/)
├── index.html     → **主聊天页面（含模型配置对话框）**
├── landing.html   → 首页/展示页
└── login.html     → 登录页
