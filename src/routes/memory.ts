import { Hono } from "hono";
import {
  clearLongTermMemories,
  forgetLongTermMemory,
  getLongTermMemoryStats,
  listLongTermMemories,
  resolveMemoryOwnerId,
} from "../agent/long-term-memory.js";

export const memoryRoute = new Hono();

async function ownerFromRequest(c: { req: { header(name: string): string | undefined } }): Promise<string | null> {
  return resolveMemoryOwnerId(c.req.header("X-User-Token"));
}

memoryRoute.get("/", async (c) => {
  const ownerId = await ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  const includeCandidates = c.req.query("candidates") === "1";
  return c.json({
    memories: await listLongTermMemories(ownerId, { includeCandidates, limit: 200 }),
    stats: await getLongTermMemoryStats(ownerId),
  });
});

memoryRoute.get("/stats", async (c) => {
  const ownerId = await ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  return c.json({ stats: await getLongTermMemoryStats(ownerId) });
});

memoryRoute.delete("/:memoryId", async (c) => {
  const ownerId = await ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  const memoryId = Number(c.req.param("memoryId"));
  if (!Number.isSafeInteger(memoryId) || memoryId <= 0) {
    return c.json({ error: "记忆 ID 无效" }, 400);
  }
  return (await forgetLongTermMemory(ownerId, memoryId))
    ? c.json({ ok: true, memoryId })
    : c.json({ error: "记忆不存在" }, 404);
});

memoryRoute.delete("/", async (c) => {
  const ownerId = await ownerFromRequest(c);
  if (!ownerId) return c.json({ error: "登录已过期" }, 401);
  return c.json({ ok: true, deleted: await clearLongTermMemories(ownerId) });
});
