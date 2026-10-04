/**
 * core/store.js — 全局状态管理（轻量级发布订阅）
 * 替代 chat-app.js 中的全局 let 变量，提供集中式状态和变更通知
 */

import { apiFetch, apiGet, apiDelete, apiPatch } from "./api-client.js";

// ─── 常量 ────────────────────────────────────────────────
const ACTIVE_SESSION_KEY = "silver-wolf-active-session";
const USER_TOKEN_KEY = "silver-wolf-user-token";
const USER_INFO_KEY = "silver-wolf-user-info";
const THEME_KEY = "silver-wolf-theme";

// ─── 状态 ────────────────────────────────────────────────
const state = {
  sessionId: localStorage.getItem(ACTIVE_SESSION_KEY) ?? "",
  userToken: localStorage.getItem(USER_TOKEN_KEY) ?? "",
  userInfo: null,
  pendingAvatarUrl: "",
  authMode: "login", // "login" | "register"
  modelSettings: { models: [], activeModel: null, templates: {} },
  selectedModelConfigId: null,
  selectedModelSnapshot: null,
  sessions: [],
  batchMode: false,
  selectedSessionIds: new Set(),
  showProcess: false,
  activeRequest: null,
  lastSubmittedMessage: "",
  conversationTurns: [],
  activeConversationTurn: 0,
  conversationMapRefreshTimer: null,
  conversationMapScrollFrame: null,
  sendCodeCountdown: 0,
  sendCodeTimer: null,
  theme: "auto",
};

// ─── 订阅者 ──────────────────────────────────────────────
const listeners = new Map();

/**
 * 订阅状态变更
 * @param {string} key - 状态键名
 * @param {Function} callback - (newVal, oldVal) => void
 * @returns {Function} 取消订阅函数
 */
export function subscribe(key, callback) {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(callback);

  return () => {
    const subs = listeners.get(key);
    const idx = subs.indexOf(callback);
    if (idx !== -1) subs.splice(idx, 1);
  };
}

/**
 * 批量订阅多个键
 */
export function subscribeAll(keys, callback) {
  return keys.map((k) => subscribe(k, callback));
}

/**
 * 内部：触发变更通知
 */
function notify(key, newVal, oldVal) {
  const subs = listeners.get(key);
  if (subs) {
    for (const cb of subs) {
      try { cb(newVal, oldVal); } catch (e) { console.error(`store notify error (${key}):`, e); }
    }
  }
}

/**
 * 设置状态并触发变更
 */
export function setState(key, value) {
  const oldVal = state[key];
  state[key] = value;
  notify(key, value, oldVal);
}

/**
 * 批量设置
 */
export function setStates(pairs) {
  for (const [key, value] of pairs) {
    const oldVal = state[key];
    state[key] = value;
    notify(key, value, oldVal);
  }
}

/**
 * 读取状态
 */
export function getState(key) {
  return state[key];
}

/**
 * 读取完整状态快照（不可变）
 */
export function getStateSnapshot() {
  return { ...state };
}

// ─── 会话相关持久化 ──────────────────────────────────────

export function persistSessionId(id) {
  localStorage.setItem(ACTIVE_SESSION_KEY, id);
  setState("sessionId", id);
}

export function persistUserToken(token) {
  localStorage.setItem(USER_TOKEN_KEY, token);
  setState("userToken", token);
}

export function persistUserInfo(info) {
  localStorage.setItem(USER_INFO_KEY, JSON.stringify(info));
  setState("userInfo", info);
}

export function persistTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  setState("theme", theme);
}

// ─── 会话列表持久化 ──────────────────────────────────────

export function persistSessions(sessions) {
  setState("sessions", sessions);
}

export function addSession(session) {
  const sessions = [...state.sessions];
  sessions.unshift(session);
  setState("sessions", sessions);
}

export function updateSession(updates) {
  const sessions = state.sessions.map((s) =>
    s.id === updates.id ? { ...s, ...updates } : s
  );
  setState("sessions", sessions);
}

export function removeSession(id) {
  const sessions = state.sessions.filter((s) => s.id !== id);
  setState("sessions", sessions);
}

export function clearSessions() {
  setState("sessions", []);
}

// ─── 选中状态 ────────────────────────────────────────────

export function toggleSessionSelection(id) {
  const set = new Set(state.selectedSessionIds);
  if (set.has(id)) set.delete(id); else set.add(id);
  setState("selectedSessionIds", set);
}

export function setAllSelected(selected) {
  const set = selected ? new Set(state.sessions.map((s) => s.id)) : new Set();
  setState("selectedSessionIds", set);
  setState("batchMode", selected);
}

export function clearSelection() {
  setState("selectedSessionIds", new Set());
  setState("batchMode", false);
}

// ─── 认证状态 ────────────────────────────────────────────

export function setAuthMode(mode) {
  setState("authMode", mode);
}

export function setUserInfo(info) {
  persistUserInfo(info);
}

export function clearUserAuth() {
  localStorage.removeItem(USER_TOKEN_KEY);
  localStorage.removeItem(USER_INFO_KEY);
  setState("userToken", "");
  setState("userInfo", null);
}

// ─── 主题状态 ────────────────────────────────────────────

export function getTheme() {
  return state.theme;
}

export function setTheme(theme) {
  persistTheme(theme);
}

// ─── 模型设置 ────────────────────────────────────────────

export function setModelSettings(settings) {
  setState("modelSettings", settings);
}

export function setSelectedModelConfigId(id) {
  setState("selectedModelConfigId", id);
}

export function setSelectedModelSnapshot(snapshot) {
  setState("selectedModelSnapshot", snapshot);
}

export function setActiveModel(model) {
  const ms = { ...state.modelSettings, activeModel: model };
  setState("modelSettings", ms);
}

// ─── 请求控制 ────────────────────────────────────────────

export function setActiveRequest(req) {
  setState("activeRequest", req);
}

export function stopActiveRequest() {
  const { controller } = state.activeRequest;
  if (controller) controller.abort();
  setState("activeRequest", null);
}

export function setShowProcess(show) {
  setState("showProcess", show);
}

export function setLastSubmittedMessage(msg) {
  setState("lastSubmittedMessage", msg);
}

// ─── 对话轮次 ────────────────────────────────────────────

export function setConversationTurns(turns) {
  setState("conversationTurns", turns);
}

export function setActiveConversationTurn(index) {
  setState("activeConversationTurn", index);
}

export function incrementActiveTurn() {
  setState("activeConversationTurn", state.activeConversationTurn + 1);
}

// ─── 文件上传 ────────────────────────────────────────────

export function setPendingFiles(files) {
  setState("pendingFiles", files);
}

export function addPendingFile(file) {
  const files = state.pendingFiles || [];
  files.push(file);
  setState("pendingFiles", files);
}

export function removePendingFile(index) {
  const files = [...(state.pendingFiles || [])];
  files.splice(index, 1);
  setState("pendingFiles", files);
}

export function clearPendingFiles() {
  setState("pendingFiles", []);
}

// ─── 初始化 ──────────────────────────────────────────────

export async function initializeStore() {
  // 恢复主题
  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setState("theme", savedTheme ?? (prefersDark ? "dark" : "light"));

  // 恢复用户信息
  const cached = localStorage.getItem(USER_INFO_KEY);
  if (cached) {
    try {
      setState("userInfo", JSON.parse(cached));
    } catch { /* ignore */ }
  }

  // 恢复会话列表
  try {
    const response = await apiFetch("/history/sessions?limit=100", { cache: "no-store" });
    const data = await response.json();
    if (data && Array.isArray(data.sessions)) {
      setState("sessions", data.sessions);
    }
  } catch (e) {
    console.warn("store: 初始化会话列表失败", e);
  }
}

export { state };
