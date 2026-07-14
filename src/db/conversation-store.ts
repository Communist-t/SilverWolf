/**
 * PostgreSQL 对话记录存储。
 *
 * 所有数据库操作均为异步，使用 pg.Pool 连接池。
 */

import { pool } from "./pool.js";
import type { Message } from "../agent/memory.js";
import { logger } from "../logger.js";

// 重新导出 initDatabase，供 index.ts / cli.ts 统一从 conversation-store 导入
export { initDatabase } from "./pool.js";

export interface StoredMessage extends Message {
  id: number;
  sessionId: string;
  createdAt: string;
}

export interface StoredSession {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  hasSummary: boolean;
}

export interface SessionSummary {
  sessionId: string;
  content: string;
  summarizedThroughMessageId: number;
  updatedAt: string;
}

export interface StoredToolRun<T = unknown> {
  id: number;
  sessionId: string;
  toolType: string;
  intent: string;
  query: string;
  queries: string[];
  provider: string;
  results: T[];
  status: "success" | "empty" | "error";
  error?: string;
  fetchedAt: string;
  expiresAt: string;
  expired: boolean;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: Message["role"];
  content: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  owner_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  has_summary: boolean;
}

interface SummaryRow {
  session_id: string;
  content: string;
  summarized_through_message_id: number;
  updated_at: string;
}

interface CountRow {
  count: number;
}

interface CutoffRow {
  cutoff_id: number | null;
}

interface ToolRunRow {
  id: number;
  session_id: string;
  tool_type: string;
  intent: string;
  query: string;
  queries_json: string;
  provider: string;
  results_json: string;
  status: "success" | "empty" | "error";
  error: string | null;
  fetched_at: string;
  expires_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function defaultSessionTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "新对话";
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized;
}

async function ensureSession(sessionId: string, timestamp = now(), ownerId = "local-default"): Promise<void> {
  await pool.query(
    `
      INSERT INTO sessions (id, owner_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(id) DO UPDATE SET updated_at = CASE
        WHEN EXCLUDED.updated_at > sessions.updated_at THEN EXCLUDED.updated_at
        ELSE sessions.updated_at
      END
    `,
    [sessionId, ownerId, timestamp, timestamp]
  );
}

export async function createSession(sessionId: string, title = "新对话", ownerId = "local-default"): Promise<StoredSession> {
  const timestamp = now();
  const normalizedTitle = title.replace(/\s+/g, " ").trim().slice(0, 80) || "新对话";
  await pool.query(
    `
      INSERT INTO sessions (id, owner_id, title, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(id) DO NOTHING
    `,
    [sessionId, ownerId, normalizedTitle, timestamp, timestamp]
  );

  return (await getSession(sessionId))!;
}

function mapSessionRow(row: SessionRow): StoredSession {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count),
    hasSummary: Boolean(row.has_summary),
  };
}

export async function getSession(sessionId: string): Promise<StoredSession | null> {
  const result = await pool.query<SessionRow>(
    `
      SELECT
        sessions.id,
        sessions.owner_id,
        sessions.title,
        sessions.created_at,
        sessions.updated_at,
        COUNT(messages.id) AS message_count,
        EXISTS(SELECT 1 FROM session_summaries WHERE session_summaries.session_id = sessions.id) AS has_summary
      FROM sessions
      LEFT JOIN messages ON messages.session_id = sessions.id
      WHERE sessions.id = $1
      GROUP BY sessions.id
    `,
    [sessionId]
  );

  return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
}

export async function renameSession(sessionId: string, title: string): Promise<StoredSession | null> {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return getSession(sessionId);
  await pool.query(
    "UPDATE sessions SET title = $1, updated_at = $2 WHERE id = $3",
    [normalized.slice(0, 80), now(), sessionId]
  );
  return getSession(sessionId);
}

export async function saveConversationTurn(
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
  ownerId = "local-default"
): Promise<void> {
  const timestamp = now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO sessions (id, owner_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(id) DO UPDATE SET updated_at = CASE
          WHEN EXCLUDED.updated_at > sessions.updated_at THEN EXCLUDED.updated_at
          ELSE sessions.updated_at
        END
      `,
      [sessionId, ownerId, timestamp, timestamp]
    );
    await client.query(
      `
        UPDATE sessions
        SET title = CASE WHEN title = '新对话' THEN $1 ELSE title END,
            updated_at = $2
        WHERE id = $3
      `,
      [defaultSessionTitle(userMessage), timestamp, sessionId]
    );
    await client.query(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, "user", userMessage, timestamp]
    );
    await client.query(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, "assistant", assistantMessage, now()]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getRecentMessages(
  sessionId: string,
  limit = 100
): Promise<Message[]> {
  const result = await pool.query<MessageRow>(
    `
      SELECT id, session_id, role, content, created_at
      FROM messages
      WHERE session_id = $1
      ORDER BY id DESC
      LIMIT $2
    `,
    [sessionId, limit]
  );

  return result.rows
    .reverse()
    .map((row) => ({ role: row.role, content: row.content }));
}

export async function getRecentStoredMessages(
  sessionId: string,
  limit = 100
): Promise<StoredMessage[]> {
  const result = await pool.query<MessageRow>(
    `
      SELECT id, session_id, role, content, created_at
      FROM messages
      WHERE session_id = $1
      ORDER BY id DESC
      LIMIT $2
    `,
    [sessionId, limit]
  );

  return result.rows.reverse().map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export async function getMessageCount(sessionId: string): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT COUNT(*) AS count FROM messages WHERE session_id = $1`,
    [sessionId]
  );
  return Number(result.rows[0].count);
}

export async function getOldestRecentMessageId(
  sessionId: string,
  recentLimit = 100
): Promise<number | null> {
  const result = await pool.query<CutoffRow>(
    `
      SELECT MIN(id) AS cutoff_id
      FROM (
        SELECT id
        FROM messages
        WHERE session_id = $1
        ORDER BY id DESC
        LIMIT $2
      ) AS sub
    `,
    [sessionId, recentLimit]
  );
  return result.rows[0]?.cutoff_id ?? null;
}

export async function listSessions(limit = 50, ownerId?: string): Promise<StoredSession[]> {
  const result = ownerId
    ? await pool.query<SessionRow>(
        `
          SELECT
            sessions.id,
            sessions.owner_id,
            sessions.title,
            sessions.created_at,
            sessions.updated_at,
            COUNT(messages.id) AS message_count,
            EXISTS(SELECT 1 FROM session_summaries WHERE session_summaries.session_id = sessions.id) AS has_summary
          FROM sessions
          LEFT JOIN messages ON messages.session_id = sessions.id
          WHERE sessions.owner_id = $1
          GROUP BY sessions.id
          ORDER BY sessions.updated_at DESC
          LIMIT $2
        `,
        [ownerId, limit]
      )
    : await pool.query<SessionRow>(
        `
          SELECT
            sessions.id,
            sessions.owner_id,
            sessions.title,
            sessions.created_at,
            sessions.updated_at,
            COUNT(messages.id) AS message_count,
            EXISTS(SELECT 1 FROM session_summaries WHERE session_summaries.session_id = sessions.id) AS has_summary
          FROM sessions
          LEFT JOIN messages ON messages.session_id = sessions.id
          GROUP BY sessions.id
          ORDER BY sessions.updated_at DESC
          LIMIT $1
        `,
        [limit]
      );

  return result.rows.map(mapSessionRow);
}

export async function listSessionMessages(
  sessionId: string,
  limit = 200
): Promise<StoredMessage[]> {
  const result = await pool.query<MessageRow>(
    `
      SELECT id, session_id, role, content, created_at
      FROM (
        SELECT id, session_id, role, content, created_at
        FROM messages
        WHERE session_id = $1
        ORDER BY id DESC
        LIMIT $2
      ) AS recent_messages
      ORDER BY id ASC
    `,
    [sessionId, limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export async function listMessagesForSummary(
  sessionId: string,
  afterMessageId: number,
  beforeMessageId: number
): Promise<StoredMessage[]> {
  const result = await pool.query<MessageRow>(
    `
      SELECT id, session_id, role, content, created_at
      FROM messages
      WHERE session_id = $1
        AND id > $2
        AND id < $3
      ORDER BY id ASC
    `,
    [sessionId, afterMessageId, beforeMessageId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  const result = await pool.query<SummaryRow>(
    `SELECT session_id, content, summarized_through_message_id, updated_at FROM session_summaries WHERE session_id = $1`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    sessionId: row.session_id,
    content: row.content,
    summarizedThroughMessageId: Number(row.summarized_through_message_id),
    updatedAt: row.updated_at,
  };
}

export async function upsertSessionSummary(
  sessionId: string,
  content: string,
  summarizedThroughMessageId: number,
  ownerId = "local-default"
): Promise<void> {
  const timestamp = now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO sessions (id, owner_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(id) DO UPDATE SET updated_at = CASE
          WHEN EXCLUDED.updated_at > sessions.updated_at THEN EXCLUDED.updated_at
          ELSE sessions.updated_at
        END
      `,
      [sessionId, ownerId, timestamp, timestamp]
    );
    await client.query(
      `
        INSERT INTO session_summaries (session_id, content, summarized_through_message_id, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(session_id) DO UPDATE SET
          content = EXCLUDED.content,
          summarized_through_message_id = EXCLUDED.summarized_through_message_id,
          updated_at = EXCLUDED.updated_at
      `,
      [sessionId, content, summarizedThroughMessageId, timestamp]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function mapToolRun<T>(row: ToolRunRow): StoredToolRun<T> {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolType: row.tool_type,
    intent: row.intent,
    query: row.query,
    queries: parseStoredArray<string>(row.queries_json, row.id, "queries_json"),
    provider: row.provider,
    results: parseStoredArray<T>(row.results_json, row.id, "results_json"),
    status: row.status,
    error: row.error ?? undefined,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= Date.now(),
  };
}

function parseStoredArray<T>(value: string, rowId: number, field: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
  } catch {
    // logged below
  }
  logger.warn("database", "invalid tool run JSON ignored", { rowId, field });
  return [];
}

export async function saveToolRun<T>(input: {
  sessionId: string;
  toolType: string;
  intent: string;
  query: string;
  queries: string[];
  provider: string;
  results: T[];
  status?: "success" | "empty" | "error";
  error?: string;
  fetchedAt?: string;
  expiresAt: string;
}): Promise<StoredToolRun<T>> {
  const fetchedAt = input.fetchedAt ?? now();
  await ensureSession(input.sessionId, fetchedAt);
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO tool_runs (
        session_id, tool_type, intent, query, queries_json,
        provider, results_json, status, error, fetched_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `,
    [
      input.sessionId,
      input.toolType,
      input.intent,
      input.query,
      JSON.stringify(input.queries),
      input.provider,
      JSON.stringify(input.results),
      input.status ?? (input.results.length > 0 ? "success" : "empty"),
      input.error ?? null,
      fetchedAt,
      input.expiresAt,
    ]
  );
  return (await getToolRun<T>(Number(result.rows[0].id)))!;
}

export async function getToolRun<T = unknown>(id: number): Promise<StoredToolRun<T> | null> {
  const result = await pool.query<ToolRunRow>(
    "SELECT * FROM tool_runs WHERE id = $1",
    [id]
  );
  return result.rows[0] ? mapToolRun<T>(result.rows[0]) : null;
}

export async function getLatestToolRun<T = unknown>(
  sessionId: string,
  includeExpired = true
): Promise<StoredToolRun<T> | null> {
  const result = includeExpired
    ? await pool.query<ToolRunRow>(
        `SELECT * FROM tool_runs WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
        [sessionId]
      )
    : await pool.query<ToolRunRow>(
        `SELECT * FROM tool_runs WHERE session_id = $1 AND expires_at > $2 ORDER BY id DESC LIMIT 1`,
        [sessionId, now()]
      );
  return result.rows[0] ? mapToolRun<T>(result.rows[0]) : null;
}

export async function listToolRuns<T = unknown>(sessionId: string, limit = 20): Promise<StoredToolRun<T>[]> {
  const result = await pool.query<ToolRunRow>(
    `SELECT * FROM tool_runs WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows.map((row) => mapToolRun<T>(row));
}

export async function clearSessionData(sessionId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query("SELECT id FROM sessions WHERE id = $1", [sessionId]);
    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("DELETE FROM messages WHERE session_id = $1", [sessionId]);
    await client.query("DELETE FROM session_summaries WHERE session_id = $1", [sessionId]);
    await client.query("DELETE FROM tool_runs WHERE session_id = $1", [sessionId]);
    await client.query(
      "UPDATE sessions SET title = '新对话', updated_at = $1 WHERE id = $2",
      [now(), sessionId]
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function getDatabasePath(): string {
  return process.env.DATABASE_URL ?? "postgresql://localhost:5432/silver_wolf_agent";
}

export async function closeDatabase(): Promise<void> {
  const { closePool } = await import("./pool.js");
  await closePool();
}
