# 银狼 Agent 技术实现框架

## 一、项目概览

| 项 | 值 |
|---|-----|
| 语言 | TypeScript（strict mode） |
| 运行时 | Node.js 20+ / Bun |
| Web 框架 | Hono（轻量、高性能、TypeScript 原生） |
| 大模型 SDK | OpenAI SDK（兼容协议，换模型只需改 baseURL） |
| 模块系统 | ESM |

---

## 二、目录结构

```
silver-wolf-agent/
├── package.json            # 依赖与脚本
├── tsconfig.json           # TypeScript 配置
├── .env.example            # 环境变量模板（复制为 .env 后填入真实凭据）
└── src/
    ├── index.ts            # 服务入口
    ├── config.ts           # 配置加载与校验
    ├── agent/
    │   ├── system-prompt.ts # 【核心】银狼人设 System Prompt
    │   ├── few-shots.ts    # 【核心】对话示例库（Few-shot Examples）
    │   ├── rag.ts          # 知识检索（世界观/角色设定/示例匹配）
    │   └── memory.ts       # 对话记忆（滑动窗口，后续可升级为摘要记忆）
    ├── llm/
    │   └── client.ts       # 大模型 API 适配层（OpenAI 兼容协议）
    └── routes/
        └── chat.ts         # POST /chat 接口
```

---

## 三、核心模块说明

### 3.1 System Prompt（`src/agent/system-prompt.ts`）

整个 Agent 的"灵魂"。按模块组织：

| 模块 | 作用 |
|------|------|
| 身份 | 我是谁，来自哪里 |
| 世界观 | 宇宙是一场游戏 |
| 性格 | 散漫、吐槽、傲娇、护犊子 |
| 说话规则 | 硬约束（游戏术语、简短、禁止客服腔、禁用词汇列表） |
| 同伴关系 | 对其他角色的态度（卡芙卡、流萤、刃、艾利欧、螺丝咕姆、开拓者） |
| 特殊触发 | 特定问题的预设回复（你是谁、写代码、哲学、表白） |

**调校要点**：修改此文件直接影响角色行为。建议用"禁止列表"而非"建议列表"，因为大模型对否定指令遵守力更强。

### 3.2 Few-shot 示例库（`src/agent/few-shots.ts`）

12 条高质量对话示例，覆盖常见场景：

- 自我介绍 / 问候 / 日常闲聊
- 工作请求 / 哲学 / 情感安慰
- 编程能力 / 同伴询问 / 挑衅 / 表白 / 游戏推荐 / 感谢

每条示例带 `tags` 标签，RAG 检索时根据用户输入动态匹配最相关的 2 条注入上下文。这个库需要持续扩充——把测试中发现的好案例加进去，坏案例作为反面教材排除。

### 3.3 RAG 知识检索（`src/agent/rag.ts`）

当前版本使用**内存关键词匹配**，包含两个数据集：

**世界观知识库**（5 条）：
- 朋克洛德设定
- 星核猎手组织
- 银狼个人经历
- 命途与星神
- 螺丝咕姆

**Few-shot 检索**：根据用户输入中的标签关键词匹配示例。

**升级路径**：替换为向量数据库（LanceDB 纯 JS 无需额外服务 / Qdrant 高性能），实现语义级别的检索，在用户输入与知识条目之间做 embedding 相似度匹配。

### 3.4 对话记忆（`src/agent/memory.ts`）

**当前方案**：滑动窗口，保留最近 20 轮对话，超出自动裁剪。

**升级路径**：摘要记忆（Summary Memory）——旧消息自动压缩为摘要保留关键信息（用户偏好、玩家 ID、互动风格等），新消息保持原文。这样既不会丢失长期信息，也不会让 token 消耗爆炸。

### 3.5 LLM 适配层（`src/llm/client.ts`）

基于 OpenAI 兼容协议的薄封装。**换模型只需修改 `.env` 三个字段**：

```env
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.openai.com/v1    # 改为目标服务的 baseURL
LLM_MODEL=gpt-4o                            # 改为目标模型名
```

支持的模型示例：

| 服务 | baseURL | 推荐模型 |
|------|---------|----------|
| OpenAI | `https://api.openai.com/v1` | gpt-4o |
| DeepSeek | `https://api.deepseek.com/v1` | deepseek-chat |
| Claude (via proxy) | 自建代理 | claude-3.5-sonnet |
| 其他兼容服务 | 对应 baseURL | 对应模型 |

### 3.6 聊天路由（`src/routes/chat.ts`）

**接口**：`POST /chat`

**请求体**：
```json
{
  "message": "你好，你是谁？",
  "sessionId": "user-abc-123"
}
```

**响应体**：
```json
{
  "reply": "银狼，星核猎手的骇客。没见过？那你该补补通缉令了。",
  "sessionId": "user-abc-123"
}
```

**处理流程**：

```
请求进入
  → 1. RAG 检索（知识库 + Few-shot 匹配）
  → 2. 加载会话记忆
  → 3. 组装消息链：[System Prompt] [知识] [Few-shot] [历史] [当前消息]
  → 4. 调用大模型
  → 5. 保存本轮对话到记忆
  → 返回回复
```

---

## 四、快速启动

```bash
# 1. 进入项目目录
cd silver-wolf-agent

# 2. 安装依赖
npm install

# 3. 配置模型
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL

# 4. 启动
npm run dev
```

服务启动后，测试：

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "这次能让我玩得开心点吗？", "sessionId": "test001"}'
```

---

## 五、迭代路线图

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **Phase 1** | 调校 System Prompt 语气，确保角色一致性 | 最高 |
| **Phase 2** | 扩充 Few-shot 示例库至 30+ 条，覆盖更多边缘场景 | 高 |
| **Phase 3** | RAG 升级为向量检索（LanceDB），语义匹配 | 中 |
| **Phase 4** | 记忆升级为摘要记忆，支持长期对话 | 中 |
| **Phase 5** | 多会话管理（Redis / 数据库持久化） | 低 |
| **Phase 6** | 前端聊天 UI（银狼主题：像素风 / 霓虹色） | 低 |

---

## 六、关键设计原则

1. **System Prompt 是核心资产**：代码是骨架，Prompt 是灵魂。花 80% 的时间调 Prompt，20% 的时间写代码。
2. **禁止列表 > 建议列表**：大模型对"不要说 X"的遵守力远高于"请以 Y 风格说话"。
3. **Few-shot 是最强调校工具**：一个高质量示例胜过十行 Prompt 描述。
4. **温度值 0.8**：银狼需要一点随机感，不能太死板，但也不能太高导致胡说。
5. **max_tokens 512**：银狼说话短，不需要长输出。限制 token 也能防止模型"话痨化"。
