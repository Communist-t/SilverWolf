/**
 * core/events.js — 事件总线
 * 用于模块间解耦通信，替代直接在 DOM 元素上绑定的散乱事件
 */

const events = new Map();

/**
 * 订阅事件
 * @param {string} name - 事件名
 * @param {Function} handler - (payload) => void
 * @returns {Function} 取消订阅
 */
export function on(name, handler) {
  if (!events.has(name)) events.set(name, new Set());
  events.get(name).add(handler);

  return () => off(name, handler);
}

/**
 * 移除特定处理器
 */
export function off(name, handler) {
  const handlers = events.get(name);
  if (handlers) handlers.delete(handler);
}

/**
 * 一次性订阅
 */
export function once(name, handler) {
  const wrapper = (payload) => {
    handler(payload);
    off(name, wrapper);
  };
  on(name, wrapper);
  return () => off(name, wrapper);
}

/**
 * 触发事件
 */
export function emit(name, payload) {
  const handlers = events.get(name);
  if (handlers) {
    for (const h of handlers) {
      try { h(payload); } catch (e) { console.error(`event emit error (${name}):`, e); }
    }
  }
}

/**
 * 触发异步事件（等待所有处理器完成）
 */
export async function emitAsync(name, payload) {
  const handlers = events.get(name);
  if (handlers) {
    const promises = [];
    for (const h of handlers) {
      try { promises.push(Promise.resolve(h(payload))); } catch (e) { /* skip */ }
    }
    await Promise.allSettled(promises);
  }
}

// ─── 预定义事件名 ───────────────────────────────────────

export const EventNames = {
  // 会话
  SESSION_SWITCH: "session:switch",
  SESSION_CREATE: "session:create",
  SESSION_DELETE: "session:delete",
  SESSION_RENAME: "session:rename",
  SESSION_MESSAGES_LOADED: "session:messages-loaded",
  SESSION_BATCH_DELETE: "session:batch-delete",

  // 消息
  MESSAGE_SEND: "message:send",
  MESSAGE_STREAM_START: "message:stream:start",
  MESSAGE_STREAM_COMPLETE: "message:stream:complete",
  MESSAGE_STREAM_ERROR: "message:stream:error",
  MESSAGE_STOP: "message:stop",

  // 认证
  AUTH_LOGIN_SUCCESS: "auth:login-success",
  AUTH_LOGOUT: "auth:logout",
  AUTH_USER_UPDATE: "auth:user-update",

  // 模型
  MODEL_ACTIVATE: "model:activate",
  MODEL_SETTINGS_CHANGED: "model:settings-changed",

  // UI
  TOAST_SHOW: "ui:toast",
  DIALOG_OPEN: "ui:dialog-open",
  DIALOG_CLOSE: "ui:dialog-close",
  THEME_CHANGE: "ui:theme-change",
  NAVIGATION_CHANGE: "ui:navigation-change",

  // 文件
  FILE_ATTACH: "file:attach",
  FILE_DETACH: "file:detach",

  // 工作区
  WORKSPACE_OPEN: "workspace:open",
  WORKSPACE_CLOSE: "workspace:close",
};

export default { on, off, once, emit, emitAsync, EventNames };
