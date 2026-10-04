/**
 * ui/dialogs.js — 弹窗 / Toast / Action 对话框
 * 统一管理所有 UI 弹窗交互
 */

import { emit, EventNames } from "../core/events.js";

let actionDialog = null;
let actionForm = null;
let actionTitle = null;
let actionMessage = null;
let actionIcon = null;
let actionHint = null;
let actionInput = null;
let actionCancel = null;
let actionConfirm = null;

let resolveActionDialog = null;
let actionDialogUsesInput = false;

// 删除等危险操作使用的垃圾桶图标（inline SVG，随 currentColor 变色）
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const WARNING_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

/**
 * 打开操作对话框
 * @param {{ title: string, message: string, inputValue?: string, confirmText?: string, danger?: boolean }} opts
 * @returns {Promise<string|null>}
 */
export function openActionDialog(opts) {
  return new Promise((resolve) => {
    resolveActionDialog = resolve;
    actionDialogUsesInput = opts.inputValue !== undefined;

    if (actionTitle) actionTitle.textContent = opts.title || "操作";
    if (actionMessage) actionMessage.textContent = opts.message || "";
    if (actionConfirm) actionConfirm.textContent = opts.confirmText || "确认";
    if (actionIcon) actionIcon.className = "dialog-icon";

    if (opts.danger) {
      if (actionConfirm) {
        actionConfirm.classList.add("danger");
        actionConfirm.innerHTML = `${TRASH_SVG}<span>${opts.confirmText || "删除"}</span>`;
      }
      if (actionDialog) actionDialog.classList.add("danger-dialog");
      if (actionIcon) {
        actionIcon.classList.add("is-danger");
        actionIcon.innerHTML = TRASH_SVG;
      }
      if (actionHint) {
        actionHint.hidden = false;
        actionHint.innerHTML = `${WARNING_SVG}<span>${opts.hint || "此操作不可撤销，删除后数据将无法恢复。"}</span>`;
      }
    } else {
      if (actionConfirm) {
        actionConfirm.classList.remove("danger");
        actionConfirm.textContent = opts.confirmText || "确认";
      }
      if (actionDialog) actionDialog.classList.remove("danger-dialog");
      if (actionIcon) {
        actionIcon.classList.remove("is-danger");
        actionIcon.textContent = "?";
      }
      if (actionHint) actionHint.hidden = true;
    }

    if (actionInput) {
      actionInput.value = opts.inputValue ?? "";
      // 只有带 inputValue 的对话框（如重命名）才显示输入框
      actionInput.hidden = !actionDialogUsesInput;
    }

    // 必须用 showModal() 展示原生 <dialog>，否则没有 open 属性 → display:none 不可见
    if (actionDialog) {
      actionDialog.returnValue = "";
      actionDialog.hidden = false;
      if (!actionDialog.open) actionDialog.showModal();
    }
  });
}

/**
 * 关闭操作对话框
 */
export function closeActionDialog(result) {
  if (actionDialog) {
    if (actionDialog.open) actionDialog.close();
    actionDialog.hidden = true;
  }
  const resolved = actionDialogUsesInput
    ? (actionInput?.value?.trim() ?? true)
    : true;
  resolveActionDialog?.(result ?? resolved);
  resolveActionDialog = null;
}

/**
 * 显示 Toast 通知
 * @param {string} message
 * @param {number} duration - 毫秒
 */
export function showToast(message, duration = 5000) {
  const toast = document.getElementById("toast");
  if (!toast) {
    console.warn("dialogs: toast element not found");
    return;
  }
  toast.textContent = message;
  toast.hidden = false;

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

/**
 * 显示操作错误 Toast
 */
export function showActionError(error) {
  showToast(error instanceof Error ? error.message : "操作失败");
}

/**
 * 显示初始化错误
 */
export function showInitializationError(error) {
  const chat = document.getElementById("chat");
  if (chat) {
    chat.innerHTML = "";
    const msg = error instanceof Error ? error.message : "会话初始化失败";
    const article = document.createElement("article");
    article.className = "message assistant";
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = msg;
    article.appendChild(content);
    chat.appendChild(article);
  }
}

/**
 * 绑定对话框 DOM 元素（需在 DOM 就绪后调用）
 */
export function bindDialogElements() {
  actionDialog = document.getElementById("actionDialog");
  actionForm = document.getElementById("actionForm");
  actionTitle = document.getElementById("actionTitle");
  actionMessage = document.getElementById("actionMessage");
  actionIcon = document.getElementById("actionIcon");
  actionHint = document.getElementById("actionHint");
  actionInput = document.getElementById("actionInput");
  actionCancel = document.getElementById("actionCancel");
  actionConfirm = document.getElementById("actionConfirm");

  if (actionCancel) {
    actionCancel.addEventListener("click", () => closeActionDialog(false));
  }
  if (actionConfirm) {
    actionConfirm.addEventListener("click", () => {
      const result = actionDialogUsesInput ? actionInput?.value?.trim() ?? true : true;
      closeActionDialog(result);
    });
  }
  // Esc / method=dialog 表单提交等触发的关闭：以 false 结束，避免 Promise 悬挂
  if (actionDialog) {
    actionDialog.addEventListener("close", () => {
      if (!resolveActionDialog) return;
      const rv = actionDialog.returnValue;
      resolveActionDialog(rv || false);
      resolveActionDialog = null;
    });
  }
}

