/**
 * modules/workspace.js — 工作区面板（Developer Tool 风格，与模型设置统一）
 * 记忆库、技能库、数据分析面板的渲染与交互
 */

import { apiFetch } from "../core/api-client.js";
import { showToast, showActionError, openActionDialog } from "../ui/dialogs.js";
import { sendMessage } from "./chat-stream.js";

const MEMORY_CATEGORY_LABELS = {
  user_preference: "用户偏好",
  fact: "事实知识",
  skill: "技能信息",
  context: "上下文",
  other: "其他",
};

const SKILL_PROMPTS = {
  "docx": "使用docx技能：生成一份Word文档：",
  "pptx": "使用pptx技能：生成一份PPT演示文稿：",
  "pdf": "使用pdf技能：处理PDF文档：",
  "markdown-generator": "使用markdown-generator技能：生成Markdown文档：",
  "mermaid-mindmap": "使用mermaid-mindmap技能：绘制思维导图：",
  "obsidian-vault-manager": "使用obsidian-vault-manager技能：管理Obsidian笔记库：",
  "universal-pyq-analyzer": "使用universal-pyq-analyzer技能：分析往年真题：",
  "weather": "使用web-search技能：查询天气：",
  "technology-news-search": "使用web-search技能：查询科技新闻：",
};

// ─── 工具函数 ────────────────────────────────────────────

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 摘要状态栏：label/value 序列 + 右侧操作按钮 */
function buildStatsBar(stats, actions) {
  const bar = document.createElement("div");
  bar.className = "ws-bar";

  stats.forEach(([label, value], index) => {
    if (index > 0) {
      const divider = document.createElement("span");
      divider.className = "ws-stat-divider";
      bar.appendChild(divider);
    }
    const stat = document.createElement("div");
    stat.className = "ws-stat";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = String(value ?? 0);
    stat.appendChild(labelNode);
    stat.appendChild(valueNode);
    bar.appendChild(stat);
  });

  if (actions && actions.length > 0) {
    const actionWrap = document.createElement("div");
    actionWrap.className = "ws-bar-actions";
    for (const btn of actions) actionWrap.appendChild(btn);
    bar.appendChild(actionWrap);
  }
  return bar;
}

function dangerTextButton(text, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ms-text-btn ms-text-btn-danger";
  btn.textContent = text;
  btn.addEventListener("click", handler);
  return btn;
}

/** 列表行：icon + 名称/副文本 + 徽标 + 操作（复用 .ms-item-* 语言） */
function buildListRow({ icon, name, sub, chips, action }) {
  const item = document.createElement("article");
  item.className = "ws-item";

  if (icon) {
    const iconEl = document.createElement("span");
    iconEl.className = "ms-item-icon";
    iconEl.innerHTML = `<i class="${esc(icon)}" aria-hidden="true"></i>`;
    item.appendChild(iconEl);
  }

  const copy = document.createElement("div");
  copy.className = "ms-item-copy ws-item-copy";
  const nameEl = document.createElement("div");
  nameEl.className = "ms-item-name";
  nameEl.textContent = name;
  copy.appendChild(nameEl);
  if (sub) {
    const subEl = document.createElement("p");
    subEl.className = "ws-item-sub";
    subEl.textContent = sub;
    copy.appendChild(subEl);
  }
  item.appendChild(copy);

  const right = document.createElement("div");
  right.className = "ws-item-right";
  if (chips && chips.length > 0) {
    const meta = document.createElement("div");
    meta.className = "ws-meta";
    for (const chip of chips) {
      const c = document.createElement("span");
      c.className = "ms-item-badge" + (chip.online !== undefined ? (chip.online ? " online" : " offline") : "");
      c.textContent = chip.text;
      meta.appendChild(c);
    }
    right.appendChild(meta);
  }
  if (action) right.appendChild(action);
  item.appendChild(right);
  return item;
}

// ─── 记忆库 ──────────────────────────────────────────────

export function renderMemoryLibrary(data) {
  const panel = document.getElementById("workspacePanelBody");
  if (!panel) return;

  const memories = Array.isArray(data.memories) ? data.memories : [];
  const stats = data.stats || {};

  panel.innerHTML = "";

  const total = stats.total || memories.length;
  const active = stats.active || 0;

  const clearBtn = dangerTextButton("清除全部记忆", clearAllMemories);
  panel.appendChild(buildStatsBar([["总记忆数", total], ["活跃记忆", active]], [clearBtn]));

  const list = document.createElement("div");
  list.className = "ws-list";

  if (memories.length === 0) {
    list.innerHTML = '<div class="ms-empty">暂无记忆</div>';
  } else {
    for (const memory of memories) {
      const categoryLabel = MEMORY_CATEGORY_LABELS[memory.category] || memory.category || "未分类";
      const chips = [
        memory.confidence ? { text: `置信度 ${Math.round(memory.confidence * 100)}%` } : null,
        memory.createdAt ? { text: new Date(memory.createdAt).toLocaleString("zh-CN") } : null,
      ].filter(Boolean);
      const forgetBtn = dangerTextButton("遗忘", () => forgetMemory(memory.id, memory.content));
      list.appendChild(buildListRow({
        icon: "ph ph-brain",
        name: categoryLabel,
        sub: memory.content || "",
        chips,
        action: forgetBtn,
      }));
    }
  }

  panel.appendChild(list);
}

export async function loadMemoryLibrary() {
  try {
    const response = await apiFetch("/memory?candidates=1", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    renderMemoryLibrary(data);
    // 更新侧边栏“记忆库”标签
    const navLabel = document.getElementById("memoryNavLabel");
    if (navLabel) {
      const total = data.stats?.total ?? (Array.isArray(data.memories) ? data.memories.length : 0);
      navLabel.textContent = `${total} 条`;
    }
  } catch (e) {
    showActionError(e);
  }
}

export async function forgetMemory(memoryId, content) {
  const confirmed = await openActionDialog({
    title: "遗忘记忆",
    message: `确定遗忘这条记忆吗？`,
    confirmText: "遗忘",
    danger: true,
  });

  if (confirmed === true || confirmed === "true") {
    try {
      await apiFetch(`/memory/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      showToast("记忆已遗忘");
      await loadMemoryLibrary();
    } catch (e) {
      showActionError(e);
    }
  }
}

export async function clearAllMemories() {
  const confirmed = await openActionDialog({
    title: "清除全部记忆",
    message: "确定清除所有记忆吗？此操作不可撤销。",
    confirmText: "清除",
    danger: true,
  });

  if (confirmed === true || confirmed === "true") {
    try {
      await apiFetch("/memory", { method: "DELETE" });
      showToast("全部记忆已清除");
      await loadMemoryLibrary();
    } catch (e) {
      showActionError(e);
    }
  }
}

// ─── 技能库 ──────────────────────────────────────────────

export function renderSkillsLibrary(data) {
  const panel = document.getElementById("workspacePanelBody");
  if (!panel) return;

  const skills = Array.isArray(data.skills) ? data.skills : [];
  const online = skills.filter((s) => s.status === "online").length;

  panel.innerHTML = "";
  panel.appendChild(buildStatsBar([["总技能数", skills.length], ["在线", online]], []));

  const list = document.createElement("div");
  list.className = "ws-list";

  if (skills.length === 0) {
    list.innerHTML = '<div class="ms-empty">暂无技能</div>';
  } else {
    for (const skill of skills) {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "ms-btn ms-btn-ghost ws-btn-sm";
      useBtn.textContent = "使用";
      useBtn.addEventListener("click", async () => {
        const prompt = SKILL_PROMPTS[skill.name] || `使用${skill.name}技能：`;
        // 关闭能力插件面板
        const dialog = document.getElementById("workspacePanelDialog");
        if (dialog) dialog.hidden = true;
        // 填入输入框并聚焦
        const input = document.getElementById("input");
        if (input) {
          input.value = prompt;
          input.focus();
          // 自动发送，直接开始对话
          try {
            await sendMessage(prompt);
          } catch (e) {
            showActionError(e);
          }
        }
      });
      list.appendChild(buildListRow({
        icon: "ph ph-lightning",
        name: skill.name,
        sub: skill.description || "",
        chips: [
          { text: `v${skill.version || "1.0.0"}` },
          { text: skill.status === "online" ? "在线" : "离线", online: skill.status === "online" },
        ],
        action: useBtn,
      }));
    }
  }

  panel.appendChild(list);
}

export async function loadSkillsLibrary() {
  try {
    const response = await apiFetch("/settings/skills", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    renderSkillsLibrary(data);
    // 更新侧边栏“能力插件”标签
    const navLabel = document.getElementById("skillNavLabel");
    if (navLabel) {
      const count = Array.isArray(data.skills) ? data.skills.length : 0;
      navLabel.textContent = `${count} 项`;
    }
  } catch (e) {
    showActionError(e);
  }
}

export async function refreshSkillsBadge() {
  try {
    const response = await apiFetch("/settings/skills", { cache: "no-store" });
    const data = await response.json();
    const badge = document.getElementById("skillsBadge");
    if (badge) {
      badge.textContent = String(data.skills?.length || 0);
    }
  } catch { /* ignore */ }
}

// ─── 数据分析面板 ────────────────────────────────────────

/** 取会话的可读内容（优先真实内容聚合，其次长期摘要，最后首条消息预览） */
function sessionDigestText(s) {
  return s.contentDigest || s.summaryContent || s.preview || "";
}

/** 简洁的相对/绝对时间 */
function fmtWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`;
  if (diffMin < 10080) return `${Math.floor(diffMin / 1440)} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/**
 * 本地内容总结：基于每个会话的标题/摘要/首条消息，构造可读的内容级总结。
 * 无论大模型是否可用都始终展示，满足"就算没有深度，也要总结"。
 */
function buildLocalContentSummary(sessions) {
  const wrap = document.createElement("div");
  wrap.className = "an-text";

  const addHead = (t) => {
    const h = document.createElement("div");
    h.className = "an-h3";
    h.textContent = t;
    wrap.appendChild(h);
  };
  const addList = (items) => {
    const ul = document.createElement("ul");
    ul.className = "an-list";
    for (const t of items) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  };

  if (sessions.length === 0) {
    addHead("暂无数据");
    addList(["还没有对话记录，先和银狼聊几句再来看分析。"]);
    return wrap;
  }

  const withSummary = sessions.filter((s) => s.hasSummary).length;
  const totalMsgs = sessions.reduce((t, s) => t + Number(s.messageCount || 0), 0);

  addHead("对话概览");
  addList([
    `共 ${sessions.length} 个会话、${totalMsgs} 条消息，其中 ${withSummary} 个会话已生成长期摘要。`,
  ]);

  addHead("近期对话");
  addList(
    sessions.slice(0, 5).map((s) => {
      const body = sessionDigestText(s) || "（暂无内容预览）";
      return `《${(s.title || "未命名").slice(0, 16)}》：${body.slice(0, 40)}`;
    })
  );

  addHead("建议");
  const advises = [];
  if (withSummary < sessions.length) {
    advises.push("部分会话尚未生成内容摘要，继续对话积累到阈值后会自动补齐。");
  }
  advises.push(
    sessions.length >= 20
      ? "会话数量较多，可为重要对话重命名，并利用上方分类进行管理。"
      : "可在左侧会话列表重命名对话，便于后续分类与查找。"
  );
  addList(advises);

  return wrap;
}

/** 会话分类：按大模型基于【会话内容】产出的主题分组展示；每条附内容片段，不只看名字 */
function buildTopics(topics, sessionsById) {
  const wrap = document.createElement("div");
  if (!Array.isArray(topics) || topics.length === 0) {
    const p = document.createElement("div");
    p.className = "an-fallback";
    p.textContent = "（大模型暂不可用，未生成自动分类，请在下方「会话管理」中按内容查看）";
    wrap.appendChild(p);
    return wrap;
  }

  for (const topic of topics) {
    const card = document.createElement("section");
    card.className = "an-topic";
    const head = document.createElement("div");
    head.className = "an-topic-head";
    const name = document.createElement("span");
    name.className = "an-topic-name";
    name.textContent = topic.name || "未分类";
    const count = document.createElement("span");
    count.className = "an-topic-count";
    count.textContent = `${topic.sessionIds.length} 个会话`;
    head.append(name, count);
    card.appendChild(head);

    const list = document.createElement("div");
    list.className = "an-topic-list";
    for (const id of topic.sessionIds) {
      const s = sessionsById.get(id);
      if (!s) continue;
      const item = document.createElement("div");
      item.className = "an-topic-item";
      const itTitle = document.createElement("span");
      itTitle.className = "an-topic-item-title";
      itTitle.textContent = s.title || "未命名";
      const itBody = document.createElement("span");
      itBody.className = "an-topic-item-body";
      itBody.textContent = sessionDigestText(s).slice(0, 40) || "（暂无内容）";
      item.append(itTitle, itBody);
      list.appendChild(item);
    }
    card.appendChild(list);
    wrap.appendChild(card);
  }
  return wrap;
}

/**
 * 会话管理（多会话整体管理）：按主题把【全部会话】分组成列表，每条显示真实内容摘要，
 * 而不是一个会话一个展开项。有 AI 主题则按主题分组，否则归入"全部会话"。
 */
function buildSessionManagement(sessions, topics, sessionsById) {
  const wrap = document.createElement("div");
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ms-empty";
    empty.textContent = "暂无会话";
    wrap.appendChild(empty);
    return wrap;
  }

  // 分组：优先用大模型主题，未命中的归入"未分类"；无主题时全部归一组
  const groups = [];
  if (Array.isArray(topics) && topics.length > 0) {
    const unassigned = new Set(sessions.map((s) => s.id));
    for (const t of topics) {
      const ids = (t.sessionIds || []).filter((id) => unassigned.delete(id));
      if (ids.length) groups.push({ name: t.name || "未分类", ids });
    }
    const rest = sessions.filter((s) => unassigned.has(s.id));
    if (rest.length) groups.push({ name: "未分类", ids: rest.map((s) => s.id) });
  } else {
    groups.push({ name: "全部会话", ids: sessions.map((s) => s.id) });
  }

  for (const g of groups) {
    const group = document.createElement("div");
    group.className = "an-session-group";

    const ghead = document.createElement("div");
    ghead.className = "an-session-group-head";
    const gname = document.createElement("span");
    gname.className = "an-session-group-name";
    gname.textContent = g.name;
    const gcount = document.createElement("span");
    gcount.className = "an-session-group-count";
    gcount.textContent = `${g.ids.length} 个会话`;
    ghead.append(gname, gcount);
    group.appendChild(ghead);

    const list = document.createElement("div");
    list.className = "an-session-list";
    for (const id of g.ids) {
      const s = sessionsById.get(id);
      if (!s) continue;
      const row = document.createElement("div");
      row.className = "an-session-row";
      const main = document.createElement("div");
      main.className = "an-session-row-main";
      const title = document.createElement("span");
      title.className = "an-session-title";
      title.textContent = s.title || "未命名";
      const meta = document.createElement("span");
      meta.className = "an-session-meta";
      meta.textContent = `${s.messageCount || 0} 条 · ${fmtWhen(s.updatedAt)}`;
      main.append(title, meta);
      const body = document.createElement("div");
      body.className = "an-session-body";
      body.textContent = sessionDigestText(s) || "（暂无内容）";
      row.append(main, body);
      list.appendChild(row);
    }
    group.appendChild(list);
    wrap.appendChild(group);
  }
  return wrap;
}

export async function renderAnalyticsPanel() {
  const panel = document.getElementById("workspacePanelBody");
  if (!panel) return;

  panel.innerHTML = '<div class="loading">正在加载分析数据...</div>';
  panel.scrollTop = 0;
  panel.classList.add("an-panel-body");

  // 内容级数据分析：会话内容摘要 + AI 整体总结 + 主题分类（调用后端 /analytics/content）
  let data = { sessions: [], ai: false, overall: null, topics: null };
  try {
    const res = await apiFetch("/history/analytics/content", { cache: "no-store" });
    data = await res.json();
  } catch { /* 接口失败时保持空数据，仅展示本地总结 */ }
  if (!Array.isArray(data.sessions)) data.sessions = [];

  const sessions = data.sessions;
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));

  panel.innerHTML = "";

  // ── 顶部统计条 ──
  const totalMsgs = sessions.reduce((t, s) => t + Number(s.messageCount || 0), 0);
  const withSummary = sessions.filter((s) => s.hasSummary).length;
  panel.appendChild(buildStatsBar([
    ["总会话", sessions.length],
    ["总消息", totalMsgs],
    ["已摘要", withSummary],
  ], []));

  // ── 内容总结 ──
  const summarySection = document.createElement("section");
  summarySection.className = "ws-section an-section";
  const summaryTitle = document.createElement("h3");
  summaryTitle.className = "ms-section-title";
  summaryTitle.textContent = "内容总结";
  summarySection.appendChild(summaryTitle);

  if (data.ai && data.overall) {
    const aiBox = document.createElement("div");
    aiBox.className = "an-text an-ai-summary";
    const aiHead = document.createElement("div");
    aiHead.className = "an-h3";
    aiHead.textContent = "AI 整体总结";
    const text = document.createElement("div");
    text.textContent = data.overall;
    aiBox.append(aiHead, text);
    summarySection.appendChild(aiBox);
  } else if (!data.ai) {
    const hint = document.createElement("div");
    hint.className = "an-fallback";
    hint.textContent = "（大模型暂不可用，以下为本地统计总结）";
    summarySection.appendChild(hint);
  }
  summarySection.appendChild(buildLocalContentSummary(sessions));
  panel.appendChild(summarySection);

  // ── 会话分类 ──
  const topicSection = document.createElement("section");
  topicSection.className = "ws-section an-section";
  const topicTitle = document.createElement("h3");
  topicTitle.className = "ms-section-title";
  topicTitle.textContent = "会话分类";
  topicSection.appendChild(topicTitle);
  topicSection.appendChild(buildTopics(data.topics, sessionsById));
  panel.appendChild(topicSection);

  // ── 会话管理 ──
  const manageSection = document.createElement("section");
  manageSection.className = "ws-section an-section";
  const manageHead = document.createElement("div");
  manageHead.className = "an-analysis-head";
  const manageTitle = document.createElement("h3");
  manageTitle.className = "ms-section-title";
  manageTitle.textContent = "会话管理";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ws-btn-sm an-refresh";
  refreshBtn.innerHTML = '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 重新分析';
  refreshBtn.addEventListener("click", renderAnalyticsPanel);
  manageHead.append(manageTitle, refreshBtn);
  manageSection.appendChild(manageHead);
  manageSection.appendChild(buildSessionManagement(sessions, data.topics, sessionsById));
  panel.appendChild(manageSection);
}

// ─── 通用工作区面板 ──────────────────────────────────────

export function closeWorkspacePanelDialog() {
  const dialog = document.getElementById("workspacePanelDialog");
  if (dialog) dialog.hidden = true;
}

export function setWorkspaceHeader(kind) {
  const title = document.getElementById("workspacePanelTitle");
  const subtitle = document.getElementById("workspacePanelSubtitle");

  if (!title || !subtitle) return;

  const headers = {
    memory: { title: "记忆库", subtitle: "查看和管理长期记忆" },
    skills: { title: "能力插件", subtitle: "可用的 Agent 技能与插件" },
    analytics: { title: "数据分析", subtitle: "对话内容总结与分类" },
  };

  const config = headers[kind] || headers.memory;
  title.textContent = config.title;
  subtitle.textContent = config.subtitle;
}

export function setWorkspaceLoading(message = "正在读取数据...") {
  const body = document.getElementById("workspacePanelBody");
  if (!body) return;
  body.classList.remove("an-panel-body");
  body.innerHTML = `<div class="loading">${esc(message)}</div>`;
}

export function renderWorkspaceEmpty(message, actionText, actionHandler) {
  const body = document.getElementById("workspacePanelBody");
  if (!body) return;

  body.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "ms-empty";
  empty.style.padding = "48px 20px";
  empty.textContent = message;
  body.appendChild(empty);

  if (actionText && actionHandler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ms-btn ms-btn-ghost";
    button.textContent = actionText;
    button.addEventListener("click", actionHandler);
    body.appendChild(button);
  }
}

export async function openWorkspacePanel(kind) {
  const dialog = document.getElementById("workspacePanelDialog");
  if (!dialog) return;

  dialog.hidden = false;
  setWorkspaceHeader(kind);

  switch (kind) {
    case "memory":
      setWorkspaceLoading("正在读取记忆...");
      await loadMemoryLibrary();
      break;
    case "skills":
      setWorkspaceLoading("正在读取技能...");
      await loadSkillsLibrary();
      break;
    case "analytics":
      setWorkspaceLoading("正在加载分析...");
      await renderAnalyticsPanel();
      break;
    default:
      renderWorkspaceEmpty("未知面板类型", null, null);
  }
}
