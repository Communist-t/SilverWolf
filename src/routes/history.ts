/**
 * 对话历史记录接口。
 */

import { Hono } from "hono";
import {
  createSession,
  getSession,
  getSessionSummary,
  listSessionMessages,
  listToolRuns,
  listSessions,
  renameSession,
} from "../db/conversation-store.js";
import { clearSession, removeSession } from "../agent/chat-agent.js";
import { isSessionActive } from "./chat.js";

const historyRoute = new Hono();
const MAX_SESSION_ID_LENGTH = 120;
const SAFE_SESSION_ID = /^[a-zA-Z0-9._:-]+$/;

function validSessionId(value: string): boolean {
  return Boolean(value) && value.length <= MAX_SESSION_ID_LENGTH && SAFE_SESSION_ID.test(value);
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 500);
}

function formatExportTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function safeMarkdownHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim() || "新对话";
}

function safeExportFileName(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return `${normalized || "银狼对话"}.md`;
}

function renderSessionMarkdown(
  session: NonNullable<ReturnType<typeof getSession>>,
  messages: ReturnType<typeof listSessionMessages>
): string {
  const lines = [
    `# ${safeMarkdownHeading(session.title)}`,
    "",
    `> 导出时间：${formatExportTime(new Date().toISOString())}`,
    `> 会话 ID：\`${session.id}\``,
    "",
    "---",
    "",
  ];

  if (messages.length === 0) {
    lines.push("_此会话暂无消息。_", "");
    return lines.join("\n");
  }

  const roleLabels = { user: "用户", assistant: "银狼", system: "系统" } as const;
  for (const message of messages) {
    lines.push(
      `## ${roleLabels[message.role]}`,
      "",
      `*${formatExportTime(message.createdAt)}*`,
      "",
      message.content.trim(),
      ""
    );
  }

  return lines.join("\n");
}

historyRoute.get("/info", (c) =>
  c.json({
    storage: "sqlite",
    persistent: true,
  })
);

historyRoute.get("/sessions", (c) => {
  const limit = parseLimit(c.req.query("limit"), 50);
  return c.json({ sessions: listSessions(limit) });
});

historyRoute.post("/sessions", async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "请求体必须是有效 JSON 对象" }, 400);
  }
  const input = body as { id?: unknown; title?: unknown };
  if (input.id !== undefined && typeof input.id !== "string") {
    return c.json({ error: "id 必须是字符串" }, 400);
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    return c.json({ error: "title 必须是字符串" }, 400);
  }
  const sessionId = input.id?.trim() || `web-${crypto.randomUUID()}`;
  if (!validSessionId(sessionId)) {
    return c.json({ error: "会话 ID 格式无效" }, 400);
  }
  if (getSession(sessionId)) {
    return c.json({ error: "会话已存在" }, 409);
  }
  return c.json({ session: createSession(sessionId, input.title) }, 201);
});

historyRoute.post("/sessions/batch-delete", async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => null);
  if (!body || !Array.isArray(body.ids)) {
    return c.json({ error: "ids 必须是数组" }, 400);
  }
  if (body.ids.some((id) => typeof id !== "string")) {
    return c.json({ error: "ids 中的每一项都必须是字符串" }, 400);
  }
  const ids = Array.from(
    new Set(body.ids.map((id) => id.trim()).filter(Boolean))
  );
  if (ids.length > 200) {
    return c.json({ error: "单次最多删除 200 个会话" }, 400);
  }
  if (ids.some((id) => !validSessionId(id))) {
    return c.json({ error: "ids 中包含格式无效的会话 ID" }, 400);
  }
  const activeIds = ids.filter(isSessionActive);
  if (activeIds.length > 0) {
    return c.json({ error: "部分会话正在生成回复，请停止生成后再删除", activeIds }, 409);
  }

  const deleted: string[] = [];
  for (const sessionId of ids) {
    if (removeSession(sessionId)) deleted.push(sessionId);
  }

  return c.json({ ok: true, deleted });
});

historyRoute.patch("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const body = await c.req.json<{ title?: string }>().catch(() => null);
  if (!body || typeof body.title !== "string") {
    return c.json({ error: "title 必须是字符串" }, 400);
  }
  const session = renameSession(sessionId, body.title ?? "");
  return session
    ? c.json({ session })
    : c.json({ error: "会话不存在" }, 404);
});

historyRoute.get("/sessions/:sessionId/messages", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  if (!getSession(sessionId)) return c.json({ error: "会话不存在" }, 404);
  const limit = parseLimit(c.req.query("limit"), 200);
  return c.json({
    sessionId,
    messages: listSessionMessages(sessionId, limit),
  });
});

historyRoute.get("/sessions/:sessionId/export", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const session = getSession(sessionId);
  if (!session) return c.json({ error: "会话不存在" }, 404);

  const messages = listSessionMessages(sessionId, Math.max(session.messageCount, 1));
  const fileName = safeExportFileName(session.title);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="silver-wolf-chat.md"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );
  return c.body(renderSessionMarkdown(session, messages));
});

historyRoute.get("/sessions/:sessionId/summary", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  if (!getSession(sessionId)) return c.json({ error: "会话不存在" }, 404);
  return c.json({
    sessionId,
    summary: getSessionSummary(sessionId),
  });
});

historyRoute.get("/sessions/:sessionId/tools", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  if (!getSession(sessionId)) return c.json({ error: "会话不存在" }, 404);
  const limit = parseLimit(c.req.query("limit"), 20);
  return c.json({ sessionId, toolRuns: listToolRuns(sessionId, limit) });
});

historyRoute.delete("/sessions/:sessionId/messages", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  if (isSessionActive(sessionId)) return c.json({ error: "会话正在生成回复" }, 409);
  if (!clearSession(sessionId)) return c.json({ error: "会话不存在" }, 404);
  return c.json({ ok: true, sessionId });
});

historyRoute.delete("/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  if (isSessionActive(sessionId)) return c.json({ error: "会话正在生成回复" }, 409);
  if (!removeSession(sessionId)) return c.json({ error: "会话不存在" }, 404);
  return c.json({ ok: true, sessionId });
});

export { historyRoute };
