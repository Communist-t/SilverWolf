# 🐺 Silver Wolf AI Agent

基于《崩坏：星穹铁道》银狼角色打造的 AI 对话 Agent，具备自然语言交互、联网检索、长期记忆、多文档生成、多模型切换与用户认证的完整 Agent 系统。

---

## ✨ 功能特性

### 🤖 AI 对话

- 流式 SSE 实时输出，打字机效果
- 基于银狼人设的系统提示词（傲娇、骇客、游戏感）
- 多轮对话上下文连贯，支持打断与重试

### 🔍 联网检索

- 智能判断是否需要联网搜索
- 多源搜索支持：Tavily / Brave / DuckDuckGo
- 搜索结果相关性过滤与来源保留
- 搜索缓存减少重复请求

### 🧠 连续记忆

- 短期：会话内上下文保持
- 长期：PostgreSQL 持久化记忆，跨会话 Recall
- RAG 检索增强生成
- 会话摘要自动生成

### 📄 多文档技能

- **Word**：docx 文档生成（OOXML Schema + docx-js）
- **PPT**：html2pptx + pptxgenjs 幻灯片生成
- **PDF**：表单填写、字段提取、验证
- **Markdown**：结构化 Markdown 生成
- **Mermaid**：思维导图生成
- **Obsidian**：笔记库管理
- **朋友圈分析**：图文内容智能解析

### 🔄 多模型切换

- 支持 OpenAI 兼容协议的任何模型
- 内置 DeepSeek / OpenAI / 自定义 Provider 模板
- 运行时一键切换激活模型
- API Key 加密存储

### 🔐 用户认证

- 邮箱注册 + 验证码
- JWT 令牌登录
- 用户信息管理（头像、昵称）
- 可选 APP_AUTH_TOKEN 保护所有接口

### 🎨 前端页面

- 响应式设计，适配桌面与移动端
- 全屏场景切换展示页
- 左侧导航 + 右侧侧边栏布局
- 深色/浅色主题切换
- 运行时配置注入（`config.js`）

---

## 🚀 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 克隆项目
git clone https://github.com/Communist-t/SilverWolf.git
cd SilverWolf

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY 等配置

# 一键启动（PostgreSQL + 后端 + 前端）
docker compose up -d
```

启动后访问：
- 展示页：`http://localhost:8080/`
- 对话页：`http://localhost:8080/chat`
- 登录页：`http://localhost:8080/login`
- 后端 API：`http://localhost:3000`

### 方式二：本地开发

**前置条件**：Node.js ≥ 20、PostgreSQL ≥ 16

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DATABASE_URL、LLM_API_KEY 等

# 初始化数据库（首次运行）
# 确保 PostgreSQL 已启动，建表会在服务启动时自动执行

# 启动开发模式
npm run dev
```

启动后访问：
- 展示页：`http://127.0.0.1:3000/`
- 对话页：`http://127.0.0.1:3000/chat`
- 登录页：`http://127.0.0.1:3000/login`

### 开发模式（热更新）

```bash
# 使用开发模式 Docker Compose，修改代码自动生效
docker compose -f docker-compose.dev.yml up -d

# 后端：nodemon 轮询监听 src/ 和 skills/，文件变更自动重启
# 前端：public/ 目录通过 volume 挂载，刷新浏览器即可
```

---

## 📁 项目结构

```
SilverWolf/
├── public/                       # 前端静态页面
│   ├── index.html                # 主聊天页（SPA）
│   ├── landing.html              # 展示页/着陆页
│   ├── login.html                # 登录页
│   ├── config.js                 # 运行时配置（API_BASE/FRONTEND_BASE）
│   ├── assets/                   # 图片、图标资源
│   └── vendor/                   # 第三方前端库（Phosphor Icons 等）
│
├── src/                          # 后端 TypeScript 源码
│   ├── index.ts                  # 服务入口（初始化数据库 + 启动 HTTP）
│   ├── app.ts                    # Hono 应用 + 路由注册
│   ├── cli.ts                    # CLI 对话模式
│   ├── config.ts                 # 环境变量配置
│   ├── logger.ts                 # 日志模块
│   │
│   ├── db/                       # 数据库层
│   │   ├── pool.ts               # PostgreSQL 连接池（pg.Pool）
│   │   └── conversation-store.ts # 全异步存储（会话/消息/摘要/记忆）
│   │
│   ├── agent/                    # Agent 核心逻辑
│   │   ├── chat-agent.ts         # 聊天编排引擎
│   │   ├── system-prompt.ts      # 银狼人设提示词
│   │   ├── conversation-context.ts # 上下文组装
│   │   ├── long-term-memory.ts   # 长期记忆读写
│   │   ├── few-shots.ts          # Few-shot 示例
│   │   ├── memory.ts             # 记忆类型定义
│   │   └── rag.ts                # RAG 检索
│   │
│   ├── llm/                      # 大模型适配层
│   │   ├── client.ts             # OpenAI 兼容客户端（异步）
│   │   └── model-configs.ts      # 模型配置管理（PostgreSQL CRUD）
│   │
│   ├── routes/                   # API 路由（全异步）
│   │   ├── chat.ts               # POST /chat/stream（SSE 流式对话）
│   │   ├── auth.ts               # 登录/注册/验证码
│   │   ├── history.ts            # 会话历史 CRUD
│   │   ├── settings.ts           # 模型配置 API
│   │   ├── memory.ts             # 长期记忆 API
│   │   └── fitness.ts            # 健康追踪 API
│   │
│   ├── tools/                    # 工具层
│   │   ├── tool-router.ts        # 意图判断 + 工具路由
│   │   ├── skill-manager.ts      # 技能管理器
│   │   ├── web-search.ts         # 联网搜索集成
│   │   ├── network-safety.ts     # URL 安全校验
│   │   └── result-relevance.ts   # 搜索结果相关性过滤
│   │
│   └── utils/                    # 工具模块
│       ├── auth.ts               # Bearer Token 鉴权
│       ├── password.ts           # 密码哈希/JWT/验证码
│       ├── email.ts              # SMTP 邮件发送
│       └── ...                   # 其他工具
│
├── skills/                       # Agent 技能模块
│   ├── docx/                     # Word 文档生成
│   ├── pptx/                     # PPT 幻灯片生成
│   ├── pdf/                      # PDF 表单处理
│   ├── markdown-generator/       # Markdown 生成
│   ├── mermaid-mindmap/          # Mermaid 思维导图
│   ├── obsidian-vault-manager/   # Obsidian 笔记管理
│   ├── universal-pyq-analyzer/   # 朋友圈分析
│   ├── technology-news-search/   # 科技资讯搜索
│   ├── weather/                  # 天气查询
│   └── web-search/               # 联网搜索
│
├── db/                           # 数据库初始化
│   └── init.sql                  # PostgreSQL 建表脚本（幂等）
│
├── frontend/                     # 前端容器化
│   ├── Dockerfile                # Nginx 镜像
│   ├── nginx.conf                # SPA 路由 + 静态资源配置
│   └── docker-entrypoint.sh      # 环境变量注入 config.js
│
├── tests/                        # 测试
│   └── regression.test.ts        # 回归测试套件
│
├── docunment/                    # 项目文档
│   ├── 01-design/               # 设计文档
│   ├── 02-changelog/            # 变更记录
│   ├── 03-guides/               # 使用指南
│   └── 04-design-audit/         # 设计审查
│
├── Dockerfile                    # 生产模式多阶段构建
├── Dockerfile.dev                # 开发模式（nodemon 热更新）
├── docker-compose.yml            # 生产编排
├── docker-compose.dev.yml        # 开发编排（volume 挂载热更新）
├── .env.example                  # 环境变量模板
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## 🌐 API 概览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat/stream` | POST | 流式对话（SSE） |
| `/chat` | POST | 普通对话 |
| `/auth/login` | POST | 邮箱登录 |
| `/auth/register` | POST | 邮箱注册 |
| `/auth/send-code` | POST | 发送验证码 |
| `/auth/user` | GET/PATCH | 用户信息 |
| `/auth/logout` | POST | 退出登录 |
| `/history/sessions` | GET | 会话列表 |
| `/history/sessions/:id` | GET/DELETE | 会话详情/删除 |
| `/history/sessions/:id/messages` | GET/DELETE | 消息列表/清空 |
| `/settings/models` | GET/POST | 模型配置列表/新增 |
| `/settings/models/:id` | PATCH/DELETE | 更新/删除模型 |
| `/settings/models/:id/activate` | POST | 切换激活模型 |
| `/memory` | GET/POST | 长期记忆读写 |
| `/health` | GET | 健康检查 |

---

## ⚙️ 环境变量

核心配置项（详见 `.env.example`）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | 大模型 API Key | — |
| `LLM_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型 ID | `gpt-4o` |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgres://silverwolf:...@127.0.0.1:5432/silver_wolf_agent` |
| `PORT` | 服务端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `APP_AUTH_TOKEN` | 接口访问令牌（可选） | — |
| `JWT_SECRET` | JWT 签名密钥 | — |
| `SMTP_HOST` | SMTP 服务器 | — |
| `WEB_SEARCH_PROVIDER` | 搜索引擎 | `auto` |

---

## 🛠 命令

```bash
# 开发
npm run dev            # 开发模式（tsx 直接运行）
npm run dev:watch      # 热重载开发（tsx --watch）

# 构建 & 生产
npm run build          # 编译 TypeScript → dist/
npm start              # 生产启动（node dist/src/index.js）

# 测试
npm test               # 运行回归测试

# 其他
npm run chat           # CLI 对话模式
npm run typecheck      # 类型检查
```

---

## 🐳 Docker 部署

### 生产模式

```bash
docker compose up -d
```

包含三个服务：
- **postgres**：PostgreSQL 16 数据库，数据持久化到 `pg_data` 卷
- **backend**：Node.js API 服务，多阶段构建（编译 + 生产依赖）
- **frontend**：Nginx 静态文件服务，启动时注入环境变量

### 开发模式

```bash
docker compose -f docker-compose.dev.yml up -d
```

- 后端通过 **nodemon + tsx** 实现热更新（轮询模式，兼容 Windows Docker）
- 前端 `public/` 目录通过 volume 挂载，修改即生效
- 数据库与生产模式共享同一 `pg_data` 卷

---

## 🏗 技术栈

| 层 | 技术 |
|------|------|
| 运行时 | Node.js 20 + TypeScript 5.7 |
| Web 框架 | Hono |
| 数据库 | PostgreSQL 16（pg 连接池） |
| LLM 适配 | OpenAI 兼容协议 |
| 前端 | 纯 HTML/CSS/JS + Phosphor Icons |
| 容器化 | Docker + Docker Compose + Nginx |
| 邮件 | nodemailer |
| 搜索 | Tavily / Brave / DuckDuckGo |
| 安全 | Bearer Token / JWT / CSP |

---

## 📄 License

MIT
