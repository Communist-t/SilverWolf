/**
 * modules/session-manager.js — 会话管理
 * 负责会话列表加载、切换、创建、删除、重命名、批量操作、导出
 */

import { apiFetch, apiGet, apiDelete } from "../core/api-client.js";
import {
  getState, setState, persistSessionId, persistSessions,
  addSession, updateSession, removeSession, setAllSelected,
  clearSelection, toggleSessionSelection,
} from "../core/store.js";
import { emit, EventNames } from "../core/events.js";
import { compactConversationText } from "../ui/message-renderer.js";
import { showToast, showActionError, openActionDialog } from "../ui/dialogs.js";

// ─── 时间格式化 ──────────────────────────────────────────

export function formatSessionTime(value) {
  const date = new Date(value);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// ─── 会话列表渲染 ────────────────────────────────────────

export function renderSessions() {
  const sessionList = document.getElementById("sessionList");
  if (!sessionList) return;

  const sessions = getState("sessions");
  const batchMode = getState("batchMode");
  const selected = getState("selectedSessionIds");
  sessionList.innerHTML = "";

  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (session.id === getState("sessionId")) item.classList.add("active");
    if (batchMode && selected.has(session.id)) item.classList.add("selected");
    item.dataset.sessionId = session.id;

    // 批量模式下：每个会话前渲染复选框
    if (batchMode) {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "session-checkbox";
      check.checked = selected.has(session.id);
      check.setAttribute("aria-label", `选择 ${compactConversationText(session.title, "会话")}`);
      check.addEventListener("click", (e) => e.stopPropagation());
      check.addEventListener("change", () => toggleSessionSelectionById(session.id));
      item.appendChild(check);
    }

    const select = document.createElement("button");
    select.className = "session-select";
    select.type = "button";
    const titleSpan = document.createElement("span");
    titleSpan.className = "session-title";
    titleSpan.textContent = compactConversationText(session.title, "新对话");
    select.appendChild(titleSpan);
    const metaSpan = document.createElement("span");
    metaSpan.className = "session-meta";
    metaSpan.textContent = formatSessionTime(session.updatedAt || session.createdAt);
    select.appendChild(metaSpan);
    select.addEventListener("click", () => {
      if (batchMode) {
        toggleSessionSelectionById(session.id);
      } else {
        switchSession(session.id);
      }
    });
    item.appendChild(select);

    // 右键呼出上下文菜单（删除对话等）
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSessionContextMenu(e.clientX, e.clientY, session);
    });

    sessionList.appendChild(item);
  }

  // 统计信息
  const sessionCountStat = document.getElementById("sessionCountStat");
  const messageCountStat = document.getElementById("messageCountStat");
  if (sessionCountStat) sessionCountStat.textContent = String(sessions.length);
  if (messageCountStat) {
    const totalMessages = sessions.reduce((total, s) => total + Number(s.messageCount || 0), 0);
    messageCountStat.textContent = String(totalMessages);
  }

  updateBatchControls();
}

// ─── 数据加载 ────────────────────────────────────────────

export async function refreshSessions() {
  try {
    const response = await apiFetch("/history/sessions?limit=100", { cache: "no-store" });
    const data = await response.json();
    if (data && Array.isArray(data.sessions)) {
      persistSessions(data.sessions);
      renderSessions();
    }
  } catch (e) {
    showActionError(e);
  }
}

export async function initializeSessions() {
  await refreshSessions();
  const sessionId = getState("sessionId");
  if (sessionId) {
    const session = getState("sessions").find((s) => s.id === sessionId);
    if (session) {
      await switchSession(sessionId);
      return;
    }
  }
  // 没有活跃会话则创建新的
  await createSession();
}

// ─── 会话操作 ────────────────────────────────────────────

export async function createSession() {
  try {
    const response = await apiFetch("/history/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "新对话" }),
    });
    const data = await response.json();
    if (data.session) {
      addSession(data.session);
      persistSessionId(data.session.id);
      emit(EventNames.SESSION_CREATE, data.session);
      // 新会话：清空聊天区并渲染欢迎页
      emit(EventNames.SESSION_MESSAGES_LOADED, { sessionId: data.session.id, messages: [] });
      renderSessions();
      return data.session.id;
    }
    throw new Error(data.error || "创建会话失败");
  } catch (e) {
    showActionError(e);
    return null;
  }
}

export async function switchSession(targetSessionId) {
  try {
    const response = await apiFetch(`/history/sessions/${encodeURIComponent(targetSessionId)}/messages?limit=100`, { cache: "no-store" });
    const data = await response.json();
    persistSessionId(targetSessionId);

    if (data.messages) {
      emit(EventNames.SESSION_MESSAGES_LOADED, { sessionId: targetSessionId, messages: data.messages });
    }

    // 更新会话标题
    const session = getState("sessions").find((s) => s.id === targetSessionId);
    if (session) {
      updateSession({ ...session, lastMessage: data.messages?.[data.messages.length - 1]?.content });
    }

    renderSessions();
    emit(EventNames.SESSION_SWITCH, targetSessionId);
  } catch (e) {
    showActionError(e);
  }
}

export async function renameCurrentSession() {
  const current = getState("sessions").find((s) => s.id === getState("sessionId"));
  if (!current) return;

  const title = await openActionDialog({
    title: "重命名会话",
    message: "输入新名称",
    inputValue: current.title,
    confirmText: "保存",
  });

  if (typeof title === "string" && title) {
    try {
      const response = await apiFetch(
        `/history/sessions/${encodeURIComponent(current.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title }),
        }
      );
      const data = await response.json();
      updateSession({ ...current, title: data.session?.title || title });
      renderSessions();
    } catch (e) {
      showActionError(e);
    }
  }
}

export async function deleteSession(targetSessionId, title) {
  const confirmed = await openActionDialog({
    title: "删除会话",
    message: `确定删除「${compactConversationText(title, "会话")}」吗？`,
    hint: "此操作不可撤销，删除后该会话及其中的消息将无法恢复。",
    confirmText: "删除",
    danger: true,
  });

  if (confirmed !== true && confirmed !== "true") return;

  const wasActive = getState("sessionId") === targetSessionId;

  try {
    // 1. 调用后端删除
    await apiDelete(`/history/sessions/${encodeURIComponent(targetSessionId)}`);
    // 2. 本地 state 同步移除
    removeSession(targetSessionId);
    emit(EventNames.SESSION_DELETE, targetSessionId);

    if (wasActive) {
      // 3. 删的是当前会话：清空当前 ID，回到空态欢迎页。
      //    不再自动新建空会话顶上——否则列表永远不减，看起来像"删不掉"。
      setState("sessionId", "");
      persistSessionId("");
      renderSessions();
      emit(EventNames.SESSION_MESSAGES_LOADED, { sessionId: "", messages: [] });
    } else {
      // 4. 删的是非当前会话：仅刷新列表
      await refreshSessions();
    }

    showToast("已删除会话");
  } catch (e) {
    showActionError(e);
    // 删除失败时从后端重新拉取，避免本地 state 与后端不一致
    await refreshSessions().catch(() => {});
  }
}

// ─── 会话右键菜单 ────────────────────────────────────────

let sessionContextMenu = null;

export function openSessionContextMenu(x, y, session) {
  closeSessionContextMenu();

  const menu = document.createElement("div");
  menu.className = "session-context-menu";
  menu.setAttribute("role", "menu");

  const del = document.createElement("button");
  del.type = "button";
  del.className = "session-context-item danger";
  del.setAttribute("role", "menuitem");
  del.textContent = "删除对话";
  del.addEventListener("click", () => {
    closeSessionContextMenu();
    deleteSession(session.id, session.title);
  });
  menu.appendChild(del);

  document.body.appendChild(menu);

  // 防止菜单超出视口
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(Math.max(x, margin), window.innerWidth - rect.width - margin);
  const top = Math.min(Math.max(y, margin), window.innerHeight - rect.height - margin);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  sessionContextMenu = menu;
}

export function closeSessionContextMenu() {
  if (sessionContextMenu) {
    sessionContextMenu.remove();
    sessionContextMenu = null;
  }
}

// 点击其他区域 / 滚动 / Esc 关闭右键菜单与导出菜单
document.addEventListener("click", (e) => {
  // 忽略右键产生的 click，保持菜单打开
  if (e.button === 2) return;
  closeSessionContextMenu();
  closeExportMenu();
});
document.addEventListener("scroll", () => {
  closeSessionContextMenu();
  closeExportMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSessionContextMenu();
    closeExportMenu();
  }
});

// ─── 批量操作 ────────────────────────────────────────────

export function toggleSessionSelectionById(id) {
  toggleSessionSelection(id);
  updateBatchControls();
  const item = document.querySelector(`.session-item[data-session-id="${CSS.escape(id)}"]`);
  if (item) item.classList.toggle("selected", getState("selectedSessionIds").has(id));
}

export function updateBatchControls() {
  const batchActions = document.getElementById("batchActions");
  const selectAllSessions = document.getElementById("selectAllSessions");
  const deleteSelectedSessions = document.getElementById("deleteSelectedSessions");
  const batchMode = getState("batchMode");
  const sessions = getState("sessions");
  const nSelected = getState("selectedSessionIds").size;

  if (batchActions) batchActions.hidden = !batchMode;
  if (selectAllSessions) {
    selectAllSessions.checked = sessions.length > 0 && nSelected === sessions.length;
    selectAllSessions.indeterminate = sessions.length > 0 && nSelected > 0 && nSelected < sessions.length;
  }
  if (deleteSelectedSessions) {
    deleteSelectedSessions.disabled = nSelected === 0;
    deleteSelectedSessions.textContent = `删除 (${nSelected})`;
  }
}

export function setBatchMode(enabled) {
  setState("batchMode", enabled);
  if (!enabled) clearSelection();
  updateBatchControls();
}

export async function deleteSelected() {
  const ids = [...getState("selectedSessionIds")];
  if (ids.length === 0) return;

  const confirmed = await openActionDialog({
    title: "批量删除",
    message: `确定删除 ${ids.length} 个会话吗？`,
    hint: "此操作不可撤销，删除后这些会话及其中的消息将无法恢复。",
    confirmText: "删除",
    danger: true,
  });

  if (confirmed !== true && confirmed !== "true") return;

  const currentId = getState("sessionId");
  const wasActive = Boolean(currentId) && ids.includes(currentId);

  try {
    // 1. 调用后端批量删除
    const response = await apiFetch("/history/sessions/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    const data = await response.json().catch(() => ({}));
    const deleted = Array.isArray(data.deleted) && data.deleted.length > 0 ? data.deleted : ids;

    // 2. 本地 state 同步移除
    for (const id of deleted) removeSession(id);
    clearSelection();
    emit(EventNames.SESSION_BATCH_DELETE, ids);

    if (wasActive) {
      // 3. 删了当前会话：清空当前 ID，回到空态欢迎页，不自动新建
      setState("sessionId", "");
      persistSessionId("");
      renderSessions();
      emit(EventNames.SESSION_MESSAGES_LOADED, { sessionId: "", messages: [] });
    } else {
      // 4. 未删当前会话：仅刷新列表
      await refreshSessions();
    }

    showToast(`已删除 ${deleted.length} 个会话`);
  } catch (e) {
    showActionError(e);
    await refreshSessions().catch(() => {});
  }
}

// ─── 导出 ────────────────────────────────────────────────

function exportFileNameFromResponse(response, fallbackExt = "md") {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) return decodeURIComponent(encodedMatch[1]);
  const simpleMatch = disposition.match(/filename="?([^";\n]+)"?/i);
  if (simpleMatch) return simpleMatch[1];
  return `silver-wolf-chat.${fallbackExt}`;
}

/**
 * 导出当前会话
 * @param {"md"|"json"} format 导出格式
 */
export async function exportCurrentChat(format = "md") {
  const current = getState("sessions").find((item) => item.id === getState("sessionId"));
  if (!current) {
    showToast("没有可导出的会话");
    return;
  }

  try {
    const response = await apiFetch(
      `/history/sessions/${encodeURIComponent(current.id)}/export?format=${format}`,
      { cache: "no-store" }
    );
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = exportFileNameFromResponse(response, format);
    link.click();
    URL.revokeObjectURL(downloadUrl);
    showToast(format === "json" ? "已导出 JSON" : "已导出 Markdown");
  } catch (e) {
    showActionError(e);
  }
}

// ─── 导出格式菜单 ────────────────────────────────────────

let exportMenu = null;

/** 在按钮下方弹出「导出格式」小菜单 */
export function openExportMenu(anchorX, anchorY) {
  closeExportMenu();

  const current = getState("sessions").find((item) => item.id === getState("sessionId"));
  if (!current) {
    showToast("没有可导出的会话");
    return;
  }

  const menu = document.createElement("div");
  menu.className = "session-context-menu export-menu";
  menu.setAttribute("role", "menu");

  const mdItem = document.createElement("button");
  mdItem.type = "button";
  mdItem.className = "session-context-item";
  mdItem.setAttribute("role", "menuitem");
  mdItem.innerHTML = '<span>Markdown 格式</span><small>.md</small>';
  mdItem.addEventListener("click", () => {
    closeExportMenu();
    exportCurrentChat("md");
  });
  menu.appendChild(mdItem);

  const jsonItem = document.createElement("button");
  jsonItem.type = "button";
  jsonItem.className = "session-context-item";
  jsonItem.setAttribute("role", "menuitem");
  jsonItem.innerHTML = '<span>JSON 格式</span><small>.json</small>';
  jsonItem.addEventListener("click", () => {
    closeExportMenu();
    exportCurrentChat("json");
  });
  menu.appendChild(jsonItem);

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(Math.max(anchorX, margin), window.innerWidth - rect.width - margin);
  const top = Math.min(Math.max(anchorY, margin), window.innerHeight - rect.height - margin);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  exportMenu = menu;
}

export function closeExportMenu() {
  if (exportMenu) {
    exportMenu.remove();
    exportMenu = null;
  }
}

// ─── 消息用量（Context Storage）─────────────────────────

/** 上下文消息上限：与后端 chat-agent 的 COMPRESSION_THRESHOLD_MESSAGES=120 保持一致，超过即触发会话压缩 */
const CONTEXT_MESSAGE_LIMIT = 120;

/** 实时计算当前会话的 Context Storage 用量：消息条数占上下文上限（120 条）的比例 */
export function updateContextUsage() {
  const chat = document.getElementById("chat");
  const value = document.getElementById("memoryValue");
  const bar = document.getElementById("memoryBar");
  const detail = document.getElementById("memoryDetail");
  if (!chat) return;

  const count = chat.querySelectorAll(".message.user, .message.assistant").length;
  const shown = Math.min(count, CONTEXT_MESSAGE_LIMIT);
  const percent = Math.min(100, (shown / CONTEXT_MESSAGE_LIMIT) * 100);

  if (value) value.textContent = count === 0 ? "0%" : `${Math.max(1, Math.round(percent))}%`;
  if (bar) bar.style.width = `${Math.min(100, Math.max(1, percent))}%`;
  if (detail) {
    detail.textContent = `${shown} / ${CONTEXT_MESSAGE_LIMIT} 条消息`;
  }
}
