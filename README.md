# Silver Wolf AI Agent 🐺

基于《崩坏：星穹铁道》银狼角色打造的 AI 对话 Agent。

具备自然语言交互、联网检索、连续记忆、多模型切换与用户认证的完整 Agent 系统。

---

## 快速开始

```bash
# 克隆项目
git clone https://github.com/Communist-t/SilverWolf.git
cd SilverWolf

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY 等配置

# 启动开发模式
npm run dev
```

启动后访问：
- 展示页：`http://127.0.0.1:3000/`
- 对话页：`http://127.0.0.1:3000/chat`
- 登录页：`http://127.0.0.1:3000/login`

---

## 功能特性

### 🤖 AI 对话

- 流式 SSE 实时输出，打字机效果
- 基于银狼人设的系统提示词（傲娇、骇客、游戏感）
- 多轮对话上下文连贯
- 支持打断停止与重试

### 🔍 联网检索

- 智能判断是否需要联网搜索
- 多源搜索支持：Tavily / Brave / DuckDuckGo
- 搜索结果相关性过滤与来源保留
- 搜索缓存减少重复请求

### 🧠 连续记忆

- 短期：会话内上下文保持
- 长期：持久化 SQLite 记忆，跨会话 Recall
- RAG 检索增强生成
- 会话摘要自动生成

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

---

## 项目结构

```
SilverWolf/
├── public/                       # 前端静态页面
│   ├── index.html                # 主聊天页（SPA）
│   ├── landing.html              # 展示页/着陆页
│   ├── login.html                # 登录页
│   ├── assets/                   # 图片、图标资源
│   └── vendor/                   # 第三方前端库
│
├── src/                          # 后端 TypeScript 源码
│   ├── index.ts                  # 服务入口
│   ├── app.ts                    # Hono 应用 + 路由注册
│   ├── config.ts                 # 环境变量配置
│   ├── logger.ts                 # 日志模块
│   ├── cli.ts                    # CLI 对话模式
│   │
│   ├── routes/                   # API 路由
│   │   ├── chat.ts               # POST /chat/stream（SSE 流式对话）
│   │   ├── auth.ts               # 登录/注册/验证码
│   │   ├── history.ts            # 会话历史 CRUD
│   │   ├── settings.ts           # 模型配置 API
│   │   └── memory.ts             # 长期记忆 API
│   │
│   ├── llm/                      # 大模型适配层
│   │   ├── client.ts             # OpenAI 兼容客户端
│   │   └── model-configs.ts      # 模型配置管理（SQLite CRUD）
│   │
│   ├── agent/                    # Agent 核心逻辑
│   │   ├── system-prompt.ts      # 银狼人设提示词
│   │   ├── chat-agent.ts         # 聊天编排引擎
│   │   ├── conversation-context.ts # 上下文组装
│   │   ├── few-shots.ts          # Few-shot 示例
│   │   ├── long-term-memory.ts   # 长期记忆读写
│   │   ├── memory.ts             # 记忆类型定义
│   │   └── rag.ts                # RAG 检索
│   │
│   ├── tools/                    # 工具层
│   │   ├── tool-router.ts        # 意图判断 + 搜索触发
│   │   ├── web-search.ts         # 联网搜索集成
│   │   ├── network-safety.ts     # URL 安全校验
│   │   └── result-relevance.ts   # 搜索结果相关性过滤
│   │
│   └── utils/                    # 工具模块
│       ├── auth.ts               # Bearer Token 鉴权
│       ├── password.ts           # 密码哈希/JWT/验证码
│       ├── email.ts              # SMTP 邮件发送
│       ├── config-validation.ts  # 配置校验
│       ├── numbers.ts            # 数字处理
│       ├── prompt-data.ts        # 提示词数据序列化
│       └── air-quality.ts        # AQI 文本转换
│
├── scripts/                      # 辅助脚本
│   └── check-tool-router.ts      # 意图识别测试
│
├── tests/                        # 测试
│   └── regression.test.ts        # 回归测试套件
│
├── docunment/                    # 项目文档
│   ├── 银狼Agent技术实现框架.md
│   ├── 银狼角色分析与Agent搭建框架.md
│   ├── 项目总结与变更记录.md
│   ├── 提交规范指南.md
│   └── design-audit-2026-06-13/  # 设计审查
│
├── .env.example                  # 环境变量模板
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## API 概览

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
| `/settings/models` | GET | 模型配置列表 |
| `/settings/models` | POST | 新增模型 |
| `/settings/models/:id` | PATCH/DELETE | 更新/删除模型 |
| `/settings/models/:id/activate` | POST | 切换激活模型 |
| `/memory` | GET/POST | 长期记忆读写 |
| `/health` | GET | 健康检查 |

---

## 环境变量

核心配置项（详见 `.env.example`）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | 大模型 API Key | — |
| `LLM_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型 ID | `gpt-4o` |
| `PORT` | 服务端口 | `3000` |
| `APP_AUTH_TOKEN` | 接口访问令牌（可选） | — |
| `JWT_SECRET` | JWT 签名密钥 | — |
| `SMTP_HOST` | SMTP 服务器（注册需用） | — |

---

## 命令

```bash
npm run dev          # 开发模式
npm run dev:watch    # 热重载开发
npm run build        # 编译 TypeScript
npm start            # 生产启动
npm test             # 运行测试
npm run chat         # CLI 对话模式
npm run typecheck    # 类型检查
```

---

## 技术栈

| 层 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript |
| Web 框架 | Hono |
| 数据库 | SQLite（better-sqlite3） |
| LLM 适配 | OpenAI 兼容协议 |
| 前端 | 纯 HTML/CSS/JS |
| 邮件 | nodemailer |
| 搜索 | Tavily / Brave / DuckDuckGo |
| 安全 | Bearer Token / JWT / CSP |
