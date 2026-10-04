/**
 * modules/chat-stream.js — SSE 流式对话
 * 负责消息发送、SSE 流解析、流式渲染、中断与重试
 */

import { apiFetch } from "../core/api-client.js";
import {
  getState, setState, setActiveRequest, stopActiveRequest,
  setShowProcess, setLastSubmittedMessage,
  setConversationTurns, setActiveConversationTurn, incrementActiveTurn,
} from "../core/store.js";
import { emit, EventNames } from "../core/events.js";
import { appendMessage, renderEmptyChat, appendProcess, appendSource } from "./chat-ui.js";
import { stripThinkingContent, compactConversationText } from "../ui/message-renderer.js";
import { clearFilePreview } from "./file-upload.js";
import { showToast, showActionError } from "../ui/dialogs.js";
import { createSession } from "./session-manager.js";

// ─── 网络超时与重试配置 ──────────────────────────────────

const STREAM_TIMEOUT_MS = 120_000; // 2 分钟流式超时
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1000;

/**
 * 带超时的 fetch 包装器
 */
async function fetchWithTimeout(resource, options = {}, timeoutMs = STREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("请求超时，请检查网络连接")), timeoutMs);

  try {
    const response = await apiFetch(resource, {
      ...options,
      signal: AbortSignal.any([controller.signal, options.signal].filter(Boolean)),
    });
    clearTimeout(timeoutId);
    return response;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

/**
 * 带重试的 SSE 请求
 */
async function sendMessageWithRetry(message, sessionId, attachments, signal, attempt = 0) {
  try {
    const response = await fetchWithTimeout("/chat/stream", {
      method: "POST",
      body: JSON.stringify({ message, sessionId, attachments }),
      signal,
    });
    return response;
  } catch (e) {
    if (e.name === "AbortError" && signal?.aborted) {
      throw e; // 用户主动取消，不重试
    }
    if (attempt < MAX_RETRIES && e.message?.includes("超时")) {
      showToast(`网络超时，${RETRY_DELAY_MS / 1000}秒后自动重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return sendMessageWithRetry(message, sessionId, attachments, signal, attempt + 1);
    }
    throw e;
  }
}

// ─── SSE 解析 ────────────────────────────────────────────

function parseSSE(buffer) {
  const events = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split("\n");
    let event = "message";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (data) {
      events.push({ event, data });
    }
  }

  return { events, rest };
}

// ─── 流事件处理 ──────────────────────────────────────────

async function applyStreamEvents(events, assistant) {
  let completed = false;
  let errorMessage = "";

  for (const item of events) {
    let payload;
    try {
      payload = JSON.parse(item.data);
    } catch {
      continue;
    }

    // 后端事件契约：{ type, name?, content }，SSE event 名 = type
    if (item.event === "done") {
      completed = true;
      break;
    }

    if (item.event === "error") {
      errorMessage =
        typeof payload.content === "string" ? payload.content : "请求出错";
      break;
    }

    // 正文增量：仅 delta 事件追加到回复内容
    if (item.event === "delta") {
      if (typeof payload.content === "string") {
        assistant.rawText += payload.content;
        const filtered = stripThinkingContent(assistant.rawText);
        assistant.render(filtered);
      }
      continue;
    }

    // 进程步骤：显示在过程区，不混入正文
    if (item.event === "step") {
      if (typeof payload.content === "string") {
        appendProcess(assistant.processEl, payload.content, payload.name || "step");
      }
      continue;
    }

    // 来源卡片：content 为单个来源对象
    if (item.event === "source" && payload.content) {
      appendSource(assistant.processEl, payload.content);
      continue;
    }
  }

  return { completed, errorMessage };
}

// ─── 错误处理 ────────────────────────────────────────────

async function responseError(response, fallback) {
  try {
    const payload = await response.clone().json();
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

// ─── 发送消息 ────────────────────────────────────────────

export async function sendMessage(message) {
  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const sendButton = document.getElementById("send");
  const stopButton = document.getElementById("stop");

  if (!chat || !input) return;

  input.value = "";
  input.disabled = true;
  if (sendButton) sendButton.disabled = true;
  if (stopButton) stopButton.disabled = false;

  // 移除欢迎页（新会话空态），避免消息出现在欢迎区下方
  chat.querySelectorAll(".empty-state").forEach((el) => el.remove());

  // 若当前没有激活会话（例如刚删除当前会话回到空态），先新建一个会话，
  // 避免消息落到空的 sessionId；createSession 内部会持久化 id 并渲染列表。
  let sessionId = getState("sessionId");
  if (!sessionId) {
    sessionId = await createSession();
    if (!sessionId) {
      input.disabled = false;
      if (sendButton) sendButton.disabled = false;
      if (stopButton) stopButton.disabled = true;
      return;
    }
  }

  // 读取附件（先取原始 File 对象用于消息显示，再转 base64 用于发送）
  const pendingFiles = getState("pendingFiles") || [];
  const attachments = await readFilesAsAttachments();

  // 追加用户消息（带附件预览，必须调用 render 写入正文）
  const userMsg = appendMessage("user", message, "", pendingFiles);
  userMsg?.render(message);

  // 准备助手占位
  const assistant = appendMessage("assistant");
  let completed = false;
  let streamFailure = "";

  try {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    setActiveRequest({ requestId, controller });

    const response = await sendMessageWithRetry(message, sessionId, attachments, controller.signal);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSSE(buffer);
      buffer = parsed.rest;

      const { completed: streamDone, errorMessage } = await applyStreamEvents(
        parsed.events,
        assistant
      );

      if (streamDone) {
        completed = true;
        break;
      }
      if (errorMessage) {
        streamFailure = errorMessage;
        break;
      }
    }

    // 处理剩余缓冲
    if (!completed && buffer.trim()) {
      const parsed = parseSSE(`${buffer}\n\n`);
      const { completed: finalDone, errorMessage } = await applyStreamEvents(
        parsed.events,
        assistant
      );
      if (finalDone) completed = true;
      if (errorMessage && !streamFailure) streamFailure = errorMessage;
    }

    // 完成回调
    if (completed) {
      const finalText = stripThinkingContent(assistant.rawText);
      assistant.render(finalText);
      assistant.container.classList.add("complete");
      emit(EventNames.MESSAGE_STREAM_COMPLETE, { sessionId, text: finalText });
    } else if (streamFailure) {
      const errorText = streamFailure;
      assistant.render(errorText);
      assistant.container.classList.add("error");
      emit(EventNames.MESSAGE_STREAM_ERROR, { sessionId, error: errorText });
    } else {
      // 连接提前结束，未收到完整回复
      const fallbackError = "连接提前结束，未收到完整回复";
      assistant.render(fallbackError);
      assistant.container.classList.add("error");
      emit(EventNames.MESSAGE_STREAM_ERROR, { sessionId, error: fallbackError });
    }

  } catch (e) {
    if (e.name === "AbortError") {
      assistant.container.classList.add("stopped");
      emit(EventNames.MESSAGE_STOP);
    } else {
      // 错误分类与友好提示
      let errorText = e instanceof Error ? e.message : "网络请求失败";
      let userMessage = errorText;

      if (errorText.includes("超时")) {
        userMessage = "⏱ 请求超时，银狼可能需要更多时间处理。请稍后重试，或尝试简化问题。";
      } else if (errorText.includes("Failed to fetch") || errorText.includes("NetworkError")) {
        userMessage = "📡 网络连接异常，请检查网络后重试。";
      } else if (errorText.includes("401") || errorText.includes("403")) {
        userMessage = "🔒 登录状态已过期，请重新登录。";
      } else if (errorText.includes("500") || errorText.includes("502") || errorText.includes("503")) {
        userMessage = "🔧 服务器暂时繁忙，请稍后重试。";
      }

      assistant.render(userMessage);
      assistant.container.classList.add("error");
      emit(EventNames.MESSAGE_STREAM_ERROR, { sessionId: getState("sessionId"), error: errorText });

      // 开发环境打印详细错误
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.error('[chat-stream] Error:', e);
      }
    }
  } finally {
    setActiveRequest(null);
    input.disabled = false;
    if (sendButton) sendButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    // 发送完成后清理待上传文件和预览区
    clearFilePreview();
    input.focus();
  }
}

// ─── 附件读取 ────────────────────────────────────────────

async function readFilesAsAttachments() {
  const pendingFiles = getState("pendingFiles") || [];
  const attachments = [];

  for (const file of pendingFiles) {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );
      attachments.push({
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64,
      });
    } catch {
      // skip unreadable files
    }
  }

  return attachments;
}

// ─── 重试 ────────────────────────────────────────────────

export async function retryLastMessage() {
  const chat = document.getElementById("chat");
  if (!chat) return;

  const messages = [...chat.querySelectorAll(".message.user, .message.assistant")];
  const lastUserMsg = messages.find((m) => m.dataset.role === "user");
  if (!lastUserMsg) return;

  const text = lastUserMsg.querySelector(".message-content")?.textContent ?? "";
  await sendMessage(text);
}

export { parseSSE, applyStreamEvents, responseError };
