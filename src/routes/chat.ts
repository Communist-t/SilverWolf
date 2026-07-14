/**
 * POST /chat 路由
 *
 * 接收用户消息，组装上下文（System Prompt + RAG + Few-shot + 历史记忆），
 * 调用大模型，返回银狼风格的回复。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sendMessage, sendMessageCore, type ChatEvent } from "../agent/chat-agent.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { resolveMemoryOwnerId } from "../agent/long-term-memory.js";

const chatRoute = new Hono();
const activeRequests = new Map<string, AbortController>();
const activeSessions = new Map<string, string>();
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_SESSION_ID_LENGTH = 120;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function validateChatInput(message: unknown, sessionId: unknown): string | null {
  if (typeof message !== "string" || !message.trim()) return "缺少 message 字段";
  if (message.length > MAX_MESSAGE_LENGTH) return `消息过长，最多 ${MAX_MESSAGE_LENGTH} 个字符`;
  if (typeof sessionId !== "string" || !sessionId.trim()) return "sessionId 不能为空";
  if (sessionId.length > MAX_SESSION_ID_LENGTH || !SAFE_ID_PATTERN.test(sessionId)) {
    return "sessionId 格式无效";
  }
  return null;
}

function requestController(requestId: string, sessionId: string, requestSignal: AbortSignal): {
  controller: AbortController;
  signal: AbortSignal;
  clear: () => void;
} {
  if (
    !requestId ||
    requestId.length > MAX_SESSION_ID_LENGTH ||
    !SAFE_ID_PATTERN.test(requestId)
  ) {
    throw new Error("requestId 格式无效");
  }
  if (activeRequests.has(requestId)) {
    throw new Error("requestId 正在使用中");
  }
  if (activeSessions.has(sessionId)) {
    throw new Error("该会话正在生成回复");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("请求执行超时")),
    config.server.requestTimeoutMs
  );
  activeRequests.set(requestId, controller);
  activeSessions.set(sessionId, requestId);
  return {
    controller,
    signal: AbortSignal.any([controller.signal, requestSignal]),
    clear: () => {
      clearTimeout(timeout);
      activeRequests.delete(requestId);
      if (activeSessions.get(sessionId) === requestId) activeSessions.delete(sessionId);
    },
  };
}

function createRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function messagePreview(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80);
}

chatRoute.post("/", async (c) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const body = await c.req.json<{
    message: string;
    sessionId?: string;
  }>().catch(() => null);
  if (!body) return c.json({ error: "请求体必须是有效 JSON" }, 400);

  const { message } = body;
  const sessionId = body.sessionId ?? "default";
  const memoryOwnerId = (await resolveMemoryOwnerId(c.req.header("X-User-Token"))) ?? "local-default";

  const validationError = validateChatInput(message, sessionId);
  if (validationError) return c.json({ error: validationError }, 400);

  let request: ReturnType<typeof requestController>;
  try {
    request = requestController(requestId, sessionId, c.req.raw.signal);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "请求标识无效" }, 409);
  }

  try {
    logger.info("chat", "request started", {
      requestId,
      route: "POST /chat",
      sessionId,
      messageLength: message.length,
    });
    logger.debug("chat", "request message preview", {
      requestId,
      sessionId,
      messagePreview: messagePreview(message),
    });
    const result = await sendMessage(message, sessionId, request.signal, memoryOwnerId);
    logger.info("chat", "request completed", {
      requestId,
      sessionId,
      durationMs: Date.now() - startedAt,
      replyLength: result.reply.length,
      webSearchUsed: Boolean(result.webSearch?.used),
      webSearchIntent: result.webSearch?.intent,
      webSearchResults: result.webSearch?.results.length ?? 0,
    });
    return c.json(result);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "未知错误";
    const metadata = {
      requestId,
      sessionId,
      durationMs: Date.now() - startedAt,
      error: errorMessage,
    };
    if (request.signal.aborted) {
      logger.info("chat", "request aborted", metadata);
    } else {
      logger.error("chat", "request failed", metadata);
    }
    return c.json({ error: errorMessage }, 500);
  } finally {
    request.clear();
  }
});

chatRoute.post("/stream", async (c) => {
  const body = await c.req.json<{
    message: string;
    sessionId?: string;
    requestId?: string;
    attachments?: Array<{ name: string; type: string; size: number; data: string }>;
  }>().catch(() => null);
  if (!body) return c.json({ error: "请求体必须是有效 JSON" }, 400);
  const requestId = body.requestId?.trim() || createRequestId();
  const startedAt = Date.now();

  const { message } = body;
  const sessionId = body.sessionId ?? "default";
  const memoryOwnerId = (await resolveMemoryOwnerId(c.req.header("X-User-Token"))) ?? "local-default";

  const validationError = validateChatInput(message, sessionId);
  if (validationError) return c.json({ error: validationError }, 400);

  logger.info("chat-stream", "request started", {
    requestId,
    route: "POST /chat/stream",
    sessionId,
    messageLength: message.length,
  });
  logger.debug("chat-stream", "request message preview", {
    requestId,
    sessionId,
    messagePreview: messagePreview(message),
  });

  let request: ReturnType<typeof requestController>;
  try {
    request = requestController(requestId, sessionId, c.req.raw.signal);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "请求标识无效" }, 409);
  }

  return streamSSE(c, async (stream) => {
    const send = async (event: ChatEvent) => {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    };

    try {
      await sendMessageCore({
        message,
        sessionId,
        stream: true,
        requestId,
        memoryOwnerId,
        attachments: body.attachments,
        onEvent: send,
        signal: request.signal,
      });
      logger.info("chat-stream", "request completed", {
        requestId,
        sessionId,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "未知错误";
      const metadata = {
        requestId,
        sessionId,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
      };
      if (request.signal.aborted) {
        logger.info("chat-stream", "request aborted", metadata);
      } else {
        logger.error("chat-stream", "request failed", metadata);
      }
      if (!request.signal.aborted) {
        await send({ type: "error", content: errorMessage });
      }
    } finally {
      request.clear();
    }
  });
});

chatRoute.post("/cancel/:requestId", (c) => {
  const requestId = c.req.param("requestId");
  const controller = activeRequests.get(requestId);
  if (!controller) return c.json({ ok: false, error: "请求不存在或已结束" }, 404);
  controller.abort(new Error("玩家已停止生成"));
  return c.json({ ok: true, requestId });
});

export function abortAllActiveRequests(reason = "服务正在关闭"): number {
  const controllers = [...activeRequests.values()];
  for (const controller of controllers) {
    controller.abort(new Error(reason));
  }
  return controllers.length;
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export { chatRoute };
