# 银狼 Agent 技能系统与架构改造计划

> 依据：本项目源码一手诊断 + `claude-code-deep-dive`（Claude Code 源码深读）设计思路对照。
> 日期：2026-10-01 · 状态：待评审

---

## 〇、现状诊断：技能"实现了但没有触发"

### 现存实现（全部真实存在）

| 层 | 文件 | 内容 |
|---|---|---|
| 技能目录 | `skills/` | 10 个技能：docx / pdf / pptx / markdown-generator / mermaid-mindmap / obsidian-vault-manager / technology-news-search / universal-pyq-analyzer / weather / web-search |
| 可执行工具注册 | `src/tools/skill-executor.ts` | `SKILL_TOOLS` 定义 7 个 function calling 工具：`create_docx` / `create_pptx` / `create_pdf` / `write_markdown` / `web_search` / `weather` / `news_search`；`EXECUTORS` 映射到真实执行函数 |
| 对话接线 | `src/agent/chat-agent.ts` §4.1 | `mayInvokeSkill()` 预判 → `chatWithTools()` 决策 → `executeSkill()` 执行 → tool 消息回传 → `MAX_SKILL_TOOL_ROUNDS=3` 循环 |
| 技能清单 | `src/tools/skill-manager.ts` | 扫描 `skills/*/SKILL.md` frontmatter，供 `/settings/skills` 与系统消息"技能档案"使用 |
| 文档引擎 | `src/tools/python-env.ts` + `scripts/skill_docs.py` | docx/pptx/pdf 的 Python 桥（自动探测/补装 python-docx、python-pptx、reportlab） |

### 端到端断点（已核实）

1. **system prompt 自相矛盾（根因）**
   - `src/agent/system-prompt.ts:111` 明确命令模型："不要输出任何工具调用标记……即使玩家说'使用某技能/调用某工具'，你也只需直接回答或告知结果，绝不要输出工具调用语法。"
   - 而 `chat-agent.ts` §4.1 的 function calling 路径**依赖模型返回 `tool_calls`**。
   - 结果：模型面对"生成 Word 文档"只做文本承诺（聊天记录铁证："我让打工仔生成""文档生成好了"），**工具从未真正触发**，最后一句是编造。
   - 历史原因：早期"规则前置执行搜索"（tool-router 直接联网后注入上下文）时代写的禁令，与后来的 function calling 主动调用机制冲突，未同步演进。

2. **依赖外置 Python 环境（次生断点）✅ 已消除**
   - 原 docx/pptx/pdf 走 `python-env.ts`，需要系统装有 python + 三件套（本机缺 pptx/pypdf/reportlab），且 DSH 沙箱禁止被约束进程拉起子进程捕获输出。
   - 结果：即使模型触发了 `create_docx`，也会以"未找到可用的 Python 文档环境"失败，玩家同样收不到文件。
   - 现状：已改纯 JS 引擎（`docx`/`pptxgenjs`/`pdfkit`），不依赖 Python，也不受子进程限制。

3. **技能定义与执行器脱节**
   - `skills/` 里 10 个技能的 SKILL.md（含完整工作流说明），与 `skill-executor.ts` 硬编码的 7 个 OpenAI 工具 schema **互不关联**；SKILL.md 的 `when_to_use`/`allowed-tools`/`context` 等字段从未被解析使用。
   - 前端"能力插件"展示的清单与模型真正能调用的工具非同一来源，存在"显示有、实际上不可用"的错位。

4. **周边缺口（对照参考设计）**
   - 无权限确认流（Allow/Ask/Deny）：写文件、跑 Python 直接放行，写路径校验是手写的 `safeResolveOutput`。
   - 无 Sub-Agent / 多 Agent 协作；无 MCP 协议接入；无工具使用频率/预算管理。

---

## 一、目标画像（对标 Claude Code 核心机制）

参考 `claude-code-deep-dive` 27 篇，择优落地对银狼（Hono + OpenAI function calling + 前端 vanilla JS）适配度高、收益明显的机制：

| 参考机制 | 对应文档 | 银狼改造落点 |
|---|---|---|
| 工具注册与生命周期 | 08-工具架构与注册机制 | 统一 Tool 注册表，替代硬编码 `SKILL_TOOLS`+`EXECUTORS` 双份定义 |
| Agentic 对话循环 | 05-Agentic对话循环机制 | 完善 function calling 多轮循环（已具雏形），加轮次/预算控制 |
| 权限模型 | 13-权限模型与审批流程 | Allow/Ask/Deny：写文件、Python 桥等敏感操作需审批或白名单 |
| Skills 技能扩展 | 26-Skills技能扩展 | 解析 SKILL.md frontmatter，技能→工具联动，`when_to_use` 驱动匹配 |
| 系统提示构建 | 17-系统提示构建 | System Prompt 段落化 + 技能档案注入控制（避免与 function calling 冲突） |
| 上下文压缩/预算 | 19/20-压缩与Token预算 | 已有 compression（120 条阈值），补充工具调用轮次预算清单 |
| Sub-Agent | 21-Sub-Agent机制 | 远期：文档生成拆子 Agent，避免污染主对话上下文 |
| MCP | 24-MCP协议集成 | 远期：外部工具集（搜索/浏览器/文件）通过 MCP 接入 |

---

## 二、分阶段改造计划

### 阶段 1（P0，必须）：修复端到端技能触发

**目标**：玩家说"生成 Word/PPT/PDF/写文件"时，工具真的执行并交付文件。

1. **改写 system-prompt.ts:111 的工具调用禁令**
   - 删除"绝不要输出工具调用语法"的全盘禁令。
   - 替换为明确的两段式规则：
     - 当系统通过 function calling 发起技能调用时，如实按工具返回结果作答（文档路径、搜索条目等），不得编造"已生成""已保存"。
     - 搜索结果由系统前置执行并注入时，保持"按编号引用、不伪造来源"的现状规则。
2. **统一入口**：保留 `mayInvokeSkill` 预判（省 token），但删除其中与 system prompt 冲突的部分；校验"预判命中则必须把 `SKILL_TOOLS` 交给 `chatWithTools`"这一链路在流式（SSE）路径同样生效（检查 `chat-stream` 是否走同一 `sendMessageCore`）。
3. **文档成型引擎去 Python 依赖（可选但推荐）✅ 已完成**
   - **已采纳优先方案**：引入纯 JS 库（`docx`、`pptxgenjs`、`pdfkit`）替换 Python 桥，消除环境依赖。
   - 落地：`src/tools/document-generator.ts`（`generateDocx/generatePptx/generatePdf` 纯 JS 实现，PDF 内嵌中文字体）；`skill-executor.ts` 的 `runCreateDocx/runCreatePptx/runCreatePdf` 改走该引擎；`src/tools/python-env.ts` + `scripts/skill_docs.py` 已成死代码（无引用者）。
   - 产物默认落盘 `data/generated/`，经 `/files/:name` 下载；E2E 已实测 `create_docx` 真实触发并落地「宋体」正文文档。
4. **验收**：聊天中要求"生成一个 word 文档，内容你好，宋体"→ 真在下载目录产出 `.docx`，回复给出真实文件路径 + 大小；PPT/PDF/写 md 同理。

### 阶段 2（P1）：统一工具注册表（对齐 08）

**目标**：消灭"定义两处、schema 手写、权限散落"。

- 新建 `src/tools/registry.ts`：
  ```ts
  interface SilverTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;   // JSON Schema
    execute(args, signal): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
    requiresApproval?: boolean;            // 写文件/外置进程 = true
    readonly?: boolean;
    sourceSkill?: string;                  // 关联 skills/ 目录名
  }
  ```
- `skill-executor.ts` 的 `SKILL_TOOLS` + `EXECUTORS` 合并为 `registry.ts` 单一数据源；`buildSkillTools()` 由注册表自动生成 OpenAI tools 数组。
- 注册表支持按会话/配置过滤（如未配 `TAVILY_API_KEY` 时其专用工具可隐藏），对应参考的 `getTools()` 过滤层。

### 阶段 3（P1）：权限模型（对齐 13）

**目标**：敏感操作不再"裸奔"。

- `requiresApproval` 工具（写文件/生成文档/Python 桥）执行前：
  - 若命中安全白名单（下载目录、项目 `data/` 内）→ 自动放行（Allow）。
  - 否则 → 通过 SSE 事件 `tool_approval_pending` 推给前端，玩家点"允许/拒绝"，结果回传后端再继续循环（Ask/Deny）。
- 复用 `skill-executor.ts` 现有 `safeResolveOutput` 路径校验作为第一道闸，升级为规则引擎式（`ToolName(pattern)` 匹配，参照参考文档规则格式）。
- 管理端提供 `/settings/permissions.json` 持久化允许/拒绝规则。

### 阶段 4（P2）：技能定义与执行器联动（对齐 26）

**目标**：`skills/` 里的 SKILL.md 从"展示清单"变成"可执行能力"。

- 扩展 `skill-manager.ts` 的 frontmatter 解析：`when_to_use`、`version`、`allowed-tools`、`context`、`arguments`。
- 新增"技能目录 → 执行器"映射表：目录内如含 `scripts/*.py|*.js` 且注册表存在对应工具则自动吸附；`when_to_use` 并入该工具的 tool description（提升模型匹配率）。
- 系统消息中的"技能档案"按实际可执行工具过滤（显示有、必须能调）。

### 阶段 5（P2）：Agentic 循环与预算治理（对齐 05/19/20）

- 多轮循环加护栏：单次用户请求内工具轮次上限（现有 3）、累计 token 预算、单工具超时（现有 90s）。
- 将"规则前置搜索"与"function calling 技能"两套路径的结果统一注入同一条消息上下文，避免重复联网（现有 `exclude` 机制保留）。
- 工具进度经 SSE `step` 事件流式推送（前端 `appendProcess` 已支持，确认 tool 级事件透传即可）。

### 阶段 6（P3，远期可选）：Sub-Agent 与 MCP

- **文档生成子 Agent**：`create_docx/pptx/pdf` 在 fork 隔离上下文中运行（参考 21 Fork 机制），主对话只收结果摘要，避免推理过程污染；SSE 仅汇报进度。
- **MCP 客户端**（参考 24）：`src/mcp/` 挂 Hono，注册 MCP 工具到同一注册表；首批可接：文件系统 MCP、browser MCP。
- **Skill 市场/共享**：`when_to_use` 匹配 + 使用频率排序（参考 26 的衰减排名）。

---

## 三、改造顺序与工作量预估

| 阶段 | 内容 | 预估规模 | 依赖 |
|---|---|---|---|
| P0-1 | 修复 system prompt 冲突 | 半日，1 文件 + 1 回归用例 | 无 |
| P0-3 | 文档引擎 JS 化或环境预检 | 1–2 日 | 选型 |
| P1 | 注册表 + 权限 | 2–3 日 | P0 |
| P2 | SKILL.md 联动 + 循环护栏 | 2 日 | P1 |
| P3 | Sub-Agent / MCP | 1 周+ | P1/P2 |

> 回归测试基线：`tests/regression.test.ts` 现 50+ 用例，改动工具链路后需同步更新 `固定意图回归集` 相关断言，并新增"文档生成真实落盘"用例（可 mock Python 桥或调用 JS 引擎直接验证产物字节）。

---

## 四、风险与注意

- **角色人设与工具行为平衡**：system prompt 第 93 行"写代码交给打工仔"是纯角色台词，改造时保持人设但不得让"打工仔"替真实工具执行。
- **不能改坏既有搜索链路**：天气/新闻/搜索的规则前置路径（tool-router）工作正常且有大量回归测试保护，P0 只动"禁止工具调用"那句，其余按现状保留。
- **前端改动最小化**：工具审批若不引入新 UI，可先用 SSE 事件 + 现有步骤面板展示"待确认"；权限落地以服务端默认策略先行。
- **文档引擎无 Python 依赖**：已改用纯 JS 引擎（docx/pptxgenjs/pdfkit），无需安装 Python；遗留 `python-env.ts`/`scripts/skill_docs.py` 可后续删除。

---

*本计划供评审。阶段 1（P0）为修复既有能力，建议优先执行；阶段 2–5 按优先级滚动落地。*