# Silver Wolf 前端结构说明

当前前端采用**无构建静态前端架构**：浏览器直接加载 HTML、CSS、JavaScript 文件，由 `frontend/nginx.conf` 或后端静态服务托管。这种方式保留了项目原有部署简单的优势，同时避免继续把所有代码堆在单个 HTML 文件中。

## 目录职责

```text
public/
├── index.html                  # 主聊天页：只保留页面结构与资源引用
├── landing.html                # 展示页/着陆页
├── login.html                  # 登录页
├── config.js                   # 运行时配置注入入口
├── styles/
│   ├── chat.css                # 主聊天页基础样式
│   └── chat-redesign.css       # 主聊天页视觉重设计样式
├── scripts/
│   ├── main.js                 # 入口初始化（ES Module）
│   ├── core/
│   │   ├── api-client.js       # 统一 API 请求层
│   │   ├── store.js            # 全局状态管理（发布订阅）
│   │   ├── router.js           # SPA 路由
│   │   └── events.js           # 事件总线
│   ├── modules/
│   │   ├── session-manager.js  # 会话管理（CRUD、批量、导出）
│   │   ├── chat-stream.js      # SSE 流式对话
│   │   ├── chat-ui.js          # 聊天 UI 辅助函数
│   │   ├── auth.js             # 认证模块（登录/注册/资料/主题）
│   │   ├── model-settings.js   # 模型设置（CRUD、测试、激活）
│   │   ├── workspace.js        # 工作区面板（记忆/技能/分析）
│   │   └── file-upload.js      # 文件上传
│   └── ui/
│       ├── message-renderer.js # Markdown/代码块渲染
│       └── dialogs.js          # 弹窗/Toast/Action
├── assets/                     # 图片、图标等静态资产
└── vendor/                     # 第三方前端资源
```

## 当前架构边界

- `index.html` 负责文档结构、可访问性语义和资源加载。
- `styles/` 负责视觉系统、布局、响应式与主题适配。
- `scripts/main.js` 负责初始化 Store、Router、EventBus，绑定全局事件。
- `scripts/core/` 负责基础设施：API 层、状态管理、路由、事件总线。
- `scripts/modules/` 负责业务模块：会话、消息流、认证、模型、工作区、文件。
- `scripts/ui/` 负责 UI 组件：消息渲染、弹窗系统。

## 当前架构亮点

### 1. 状态管理（Store）
- 集中式状态，替代分散的全局 `let` 变量
- 发布订阅模式，模块间解耦
- 持久化支持（localStorage/sessionStorage）
- 状态变更自动通知订阅者

### 2. 事件总线（EventBus）
- 预定义事件名（`EventNames`），避免魔法字符串
- 同步/异步事件分发
- 支持一次性订阅（`once`）

### 3. API 层
- 统一封装 `fetch`，自动注入 Bearer Token
- GET/POST/PATCH/DELETE 快捷方法
- 统一错误处理

### 4. 模块化
- 每个模块职责单一，便于维护和测试
- ES Module 原生支持，零构建工具
- 模块间通过 Store + EventBus 通信

## 演进约束

1. **禁止新增大段内联 CSS/JS**
   - 新样式放入 `public/styles/`。
   - 新交互放入 `public/scripts/modules/`。
   - HTML 中只允许少量必要的资源引用和结构标记。

2. **保持静态部署兼容**
   - 所有新增文件都应能被浏览器直接加载。
   - 避免破坏 Docker + Nginx 的当前部署路径。

3. **后续引入框架的建议节奏**
   - 第一阶段：继续模块化原生 JS（已完成 ✅）
   - 第二阶段：引入 TypeScript 前端类型检查或 JSDoc 类型约束
   - 第三阶段：当页面复杂度继续上升时，再迁移到 Vite + React/Vue/Svelte
