import { Hono } from "hono";
import {
  clearLongTermMemories,
  forgetLongTermMemory,
  getLongTermMemoryStats,
  listLongTermMemories,
  resolveMemoryOwnerId,
} from "../agent/long-term-memory.js";

export const memoryRoute = new Hono();

function ownerFromRequest(c: { req: { header(name: string): string | undefined } }): string | null {
  return resolveMemoryOwnerId(c.req.header("X-User-Token"));
}

memoryRoute.get("/", (c) => {
  const ownerId = ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  const includeCandidates = c.req.query("candidates") === "1";
  return c.json({
    memories: listLongTermMemories(ownerId, { includeCandidates, limit: 200 }),
    stats: getLongTermMemoryStats(ownerId),
  });
});

memoryRoute.get("/stats", (c) => {
  const ownerId = ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  return c.json({ stats: getLongTermMemoryStats(ownerId) });
});

memoryRoute.delete("/:memoryId", (c) => {
  const ownerId = ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  const memoryId = Number(c.req.param("memoryId"));
  if (!Number.isSafeInteger(memoryId) || memoryId <= 0) {
    return c.json({ error: "记忆 ID 无效" }, 400);
  }
  return forgetLongTermMemory(ownerId, memoryId)
    ? c.json({ ok: true, memoryId })
    : c.json({ error: "记忆不存在" }, 404);
});

memoryRoute.delete("/", (c) => {
  const ownerId = ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  return c.json({ ok: true, deleted: clearLongTermMemories(ownerId) });
});
