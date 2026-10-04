/**
 * 对话历史记录接口。
 */

import { Hono } from "hono";
import {
  createSession,
  getSession,
  getSessionSummary,
  listSessionContentDigests,
  listSessionMessages,
  listToolRuns,
  listSessions,
  renameSession,
} from "../db/conversation-store.js";
import { clearSession, removeSession } from "../agent/chat-agent.js";
import { isSessionActive } from "./chat.js";
import { resolveMemoryOwnerId } from "../agent/long-term-memory.js";
import { chat } from "../llm/client.js";
import { logger } from "../logger.js";

const historyRoute = new Hono();
const MAX_SESSION_ID_LENGTH = 120;
const SAFE_SESSION_ID = /^[a-zA-Z0-9._:-]+$/;

async function resolveOwner(c: { req: { header(name: string): string | undefined } }): Promise<string> {
  return (await resolveMemoryOwnerId(c.req.header("X-User-Token"))) ?? "local-default";
}

async function checkSessionOwnership(sessionId: string, ownerId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  if (!session) return false;
  // 允许归属为匿名默认 owner（local-default）的会话被当前用户访问/管理。
  // 修复登录态与匿名态切换后产生的"孤儿会话"可见却删不掉（404）的问题；
  // 同时仍保持不同真实用户之间的数据隔离。
  if (session.ownerId === "local-default") return true;
  return session.ownerId === ownerId;
}

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

function safeExportBaseName(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return normalized || "银狼对话";
}

function safeExportFileName(value: string, ext: "md" | "json" = "md"): string {
  return `${safeExportBaseName(value)}.${ext}`;
}

function renderSessionMarkdown(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  messages: Awaited<ReturnType<typeof listSessionMessages>>
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

function renderSessionJson(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  messages: Awaited<ReturnType<typeof listSessionMessages>>
): string {
  const payload = {
    app: "Silver Wolf",
    format: "silver-wolf-chat-export/v1",
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: messages.length,
    },
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

historyRoute.get("/info", (c) =>
  c.json({
    storage: "postgresql",
    persistent: true,
  })
);

historyRoute.get("/sessions", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 50);
  const ownerId = await resolveOwner(c);
  return c.json({ sessions: await listSessions(limit, ownerId) });
});

/**
 * 数据分析：基于前端聚合的使用统计数据，调用当前配置的大模型生成 AI 分析。
 * 统计本身由前端基于 /history/sessions 计算；本接口只负责把数据交给模型产出洞察。
 */
historyRoute.post("/analytics/analyze", async (c) => {
  const body = await c.req.json<{ stats?: unknown }>().catch(() => null);
  const stats =
    body?.stats && typeof body.stats === "object" ? (body.stats as Record<string, unknown>) : {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const analysis = await chat({
      messages: [
        {
          role: "system",
          content:
            "你是专业的数据分析师，输出简洁、精炼、专业的中文分析，不要复述原始数字表，不要客套话。",
        },
        {
          role: "user",
          content:
            `以下是银狼 AI Agent 的使用统计数据（JSON）：\n` +
            `${JSON.stringify(stats)}\n\n` +
            `请输出一段分析，包含：1) 关键发现 2) 数据趋势 3) 可操作建议。` +
            `使用要点式，控制在 180 字以内。`,
        },
      ],
      temperature: 0.5,
      maxTokens: 600,
      signal: controller.signal,
      maxRetries: 1,
    });
    return c.json({ analysis });
  } catch (error) {
    logger.warn("analytics", "AI 分析生成失败", { error: String(error) });
    return c.json({ error: "分析生成失败，请检查模型配置" }, 502);
  } finally {
    clearTimeout(timeout);
  }
});

/** 从模型原始输出中稳健解析 JSON（容忍代码块与前后杂文） */
function parseContentAnalysis(raw: string): {
  overall: string;
  topics: Array<{ name: string; sessionIds: string[] }>;
} | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      overall?: unknown;
      topics?: unknown;
    };
    const overall = typeof obj.overall === "string" ? obj.overall.trim() : "";
    const topics = Array.isArray(obj.topics)
      ? (obj.topics as Array<Record<string, unknown>>)
          .map((t) => ({
            name:
              (typeof t?.name === "string" ? t.name.trim() : "").slice(0, 24) ||
              "未分类",
            sessionIds: Array.isArray(t?.sessionIds)
              ? (t.sessionIds as unknown[]).filter(
                  (x): x is string => typeof x === "string"
                )
              : [],
          }))
          .filter((t) => t.sessionIds.length > 0)
      : [];
    return { overall, topics };
  } catch {
    return null;
  }
}

/**
 * 内容级数据分析：返回每个会话的内容摘要（真实用户消息聚合 + 长期记忆摘要），
 * 并在大模型可用时基于【会话真实内容】生成整体对话总结与主题分类，供"数据分析"面板展示。
 */
historyRoute.get("/analytics/content", async (c) => {
  const ownerId = await resolveOwner(c);
  const sessions = await listSessionContentDigests(ownerId, 200);
  const payload = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    hasSummary: s.hasSummary,
    summaryContent: s.summaryContent,
    preview: s.preview,
    contentDigest: s.contentDigest,
  }));

  if (sessions.length === 0) {
    return c.json({ sessions: payload, ai: false, overall: null, topics: null });
  }

  // 只把真实会话内容喂给大模型（截断会话数控制 token），让它依据内容而非标题分析
  const forLlm = sessions.slice(0, 120);
  const digestLines = forLlm
    .map((s) => {
      const body = s.contentDigest || s.summaryContent || s.preview || "（无内容）";
      return `[会话 ${s.id}] 内容：${body.slice(0, 160)}`;
    })
    .join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const raw = await chat({
      temperature: 0.3,
      maxTokens: 1600,
      signal: controller.signal,
      maxRetries: 1,
      messages: [
        {
          role: "system",
          content:
            "你是对话管理分析师。你只输出合法 JSON，不要输出 JSON 以外的任何文字。",
        },
        {
          role: "user",
          content:
            `下面是用户每个会话的【真实对话内容摘要】（取自会话内消息，不是标题）：\n${digestLines}\n\n` +
            `请输出 JSON：\n{\n  "overall": "对整个对话历史的一句话总结（中文，概括用户主要聊了什么、关注什么，60-100字）",\n  "topics": [{"name":"主题名(≤10字)","sessionIds":["会话id"]}]\n}\n` +
            `要求：\n` +
            `1. 只依据上面给出的会话内容进行总结与分类，忽略会话标题/名称；\n` +
            `2. 把每个会话恰好分到一个主题；sessionIds 只能使用上面出现的会话 id；\n` +
            `3. 主题数量控制在 3-8 个；内容过少或无法归类的会话不必强行分配。`,
        },
      ],
    });
    const parsed = parseContentAnalysis(raw);
    if (parsed) {
      return c.json({
        sessions: payload,
        ai: true,
        overall: parsed.overall,
        topics: parsed.topics,
      });
    }
    return c.json({ sessions: payload, ai: false, overall: null, topics: null });
  } catch (error) {
    logger.warn("analytics", "内容分析生成失败", { error: String(error) });
    return c.json({ sessions: payload, ai: false, overall: null, topics: null });
  } finally {
    clearTimeout(timeout);
  }
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
  const ownerId = await resolveOwner(c);
  const sessionId = input.id?.trim() || `web-${crypto.randomUUID()}`;
  if (!validSessionId(sessionId)) {
    return c.json({ error: "会话 ID 格式无效" }, 400);
  }
  if (await getSession(sessionId)) {
    return c.json({ error: "会话已存在" }, 409);
  }
  return c.json({ session: await createSession(sessionId, input.title, ownerId) }, 201);
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
    if (await removeSession(sessionId)) deleted.push(sessionId);
  }

  return c.json({ ok: true, deleted });
});

historyRoute.patch("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  const body = await c.req.json<{ title?: string }>().catch(() => null);
  if (!body || typeof body.title !== "string") {
    return c.json({ error: "title 必须是字符串" }, 400);
  }
  const session = await renameSession(sessionId, body.title ?? "");
  return session
    ? c.json({ session })
    : c.json({ error: "会话不存在" }, 404);
});

historyRoute.get("/sessions/:sessionId/messages", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  const limit = parseLimit(c.req.query("limit"), 200);
  return c.json({
    sessionId,
    messages: await listSessionMessages(sessionId, limit),
  });
});

historyRoute.get("/sessions/:sessionId/export", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  const session = await getSession(sessionId);
  if (!session) return c.json({ error: "会话不存在" }, 404);

  const messages = await listSessionMessages(sessionId, Math.max(session.messageCount, 1));
  const format = c.req.query("format") === "json" ? "json" : "md";
  const fileName = safeExportFileName(session.title, format);
  c.header(
    "Content-Disposition",
    `attachment; filename="silver-wolf-chat.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );
  if (format === "json") {
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.body(renderSessionJson(session, messages));
  }
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(renderSessionMarkdown(session, messages));
});

historyRoute.get("/sessions/:sessionId/summary", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  return c.json({
    sessionId,
    summary: await getSessionSummary(sessionId),
  });
});

historyRoute.get("/sessions/:sessionId/tools", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  const limit = parseLimit(c.req.query("limit"), 20);
  return c.json({ sessionId, toolRuns: await listToolRuns(sessionId, limit) });
});

historyRoute.delete("/sessions/:sessionId/messages", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  if (isSessionActive(sessionId)) return c.json({ error: "会话正在生成回复" }, 409);
  if (!(await clearSession(sessionId))) return c.json({ error: "会话不存在" }, 404);
  return c.json({ ok: true, sessionId });
});

historyRoute.delete("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!validSessionId(sessionId)) return c.json({ error: "会话 ID 格式无效" }, 400);
  const ownerId = await resolveOwner(c);
  if (!(await checkSessionOwnership(sessionId, ownerId))) {
    return c.json({ error: "会话不存在或无权访问" }, 404);
  }
  if (isSessionActive(sessionId)) return c.json({ error: "会话正在生成回复" }, 409);
  if (!(await removeSession(sessionId))) return c.json({ error: "会话不存在" }, 404);
  return c.json({ ok: true, sessionId });
});

export { historyRoute };
