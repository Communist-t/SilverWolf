/**
 * SQLite 对话记录存储。
 *
 * 数据库文件默认保存在项目根目录的 data/silver-wolf.sqlite。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { Message } from "../agent/memory.js";
import { logger } from "../logger.js";

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const databasePath =
  process.env.DATABASE_PATH ?? join(dataDir, "silver-wolf.sqlite");

mkdirSync(dirname(databasePath), { recursive: true });

export const db: DatabaseType = new Database(databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    summarized_through_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_type TEXT NOT NULL,
    intent TEXT NOT NULL,
    query TEXT NOT NULL,
    queries_json TEXT NOT NULL,
    provider TEXT NOT NULL,
    results_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    error TEXT,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_id_id
    ON messages(session_id, id);

  CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
    ON sessions(updated_at);

  CREATE INDEX IF NOT EXISTS idx_tool_runs_session_id_id
    ON tool_runs(session_id, id DESC);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'super_admin')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_verification_codes (
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id
    ON user_tokens(user_id);

  CREATE INDEX IF NOT EXISTS idx_email_verification_codes_email
    ON email_verification_codes(email);

  CREATE TABLE IF NOT EXISTS long_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'forgotten')),
    evidence_count INTEGER NOT NULL DEFAULT 1,
    confidence REAL NOT NULL DEFAULT 0.5,
    explicit INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_recalled_at TEXT,
    UNIQUE(owner_id, memory_key)
  );

  CREATE INDEX IF NOT EXISTS idx_long_term_memories_owner_status
    ON long_term_memories(owner_id, status, updated_at DESC);

  -- 健身追踪表
  CREATE TABLE IF NOT EXISTS fitness_profile (
    owner_id TEXT PRIMARY KEY,
    bmr INTEGER DEFAULT 0,
    calorie_target INTEGER DEFAULT 0,
    protein_target_g REAL DEFAULT 0,
    carbs_target_g REAL DEFAULT 0,
    fat_target_g REAL DEFAULT 0,
    weight_kg REAL,
    height_cm REAL,
    age INTEGER,
    gender TEXT,
    activity_level TEXT DEFAULT 'sedentary',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fitness_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    date TEXT NOT NULL,
    calories INTEGER DEFAULT 0,
    protein_g REAL DEFAULT 0,
    carbs_g REAL DEFAULT 0,
    fat_g REAL DEFAULT 0,
    water_ml INTEGER DEFAULT 0,
    sleep_hours REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_id, date)
  );

  CREATE TABLE IF NOT EXISTS fitness_workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('cardio', 'strength', 'mixed')),
    duration_minutes INTEGER NOT NULL,
    details TEXT DEFAULT '',
    intensity TEXT DEFAULT 'moderate' CHECK (intensity IN ('low', 'moderate', 'high')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fitness_meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    date TEXT NOT NULL,
    meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    food_name TEXT NOT NULL,
    calories INTEGER NOT NULL,
    protein_g REAL DEFAULT 0,
    carbs_g REAL DEFAULT 0,
    fat_g REAL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fitness_daily_owner_date
    ON fitness_daily(owner_id, date DESC);

  CREATE INDEX IF NOT EXISTS idx_fitness_workouts_owner_date
    ON fitness_workouts(owner_id, date DESC);

  CREATE INDEX IF NOT EXISTS idx_fitness_meals_owner_date
    ON fitness_meals(owner_id, date DESC);
`);

const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
  name: string;
}>;
if (!sessionColumns.some((column) => column.name === "title")) {
  db.exec("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '新对话'");
}

const toolRunColumns = db.prepare("PRAGMA table_info(tool_runs)").all() as Array<{
  name: string;
}>;
if (!toolRunColumns.some((column) => column.name === "status")) {
  db.exec("ALTER TABLE tool_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'");
}
if (!toolRunColumns.some((column) => column.name === "error")) {
  db.exec("ALTER TABLE tool_runs ADD COLUMN error TEXT");
}

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{
  name: string;
}>;
if (!userColumns.some((column) => column.name === "role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

db.exec(`
  UPDATE sessions
  SET title = COALESCE(
    (
      SELECT CASE
        WHEN LENGTH(REPLACE(messages.content, CHAR(10), ' ')) > 24
          THEN SUBSTR(REPLACE(messages.content, CHAR(10), ' '), 1, 24) || '...'
        ELSE REPLACE(messages.content, CHAR(10), ' ')
      END
      FROM messages
      WHERE messages.session_id = sessions.id
        AND messages.role = 'user'
      ORDER BY messages.id ASC
      LIMIT 1
    ),
    '新对话'
  )
  WHERE title = '新对话';
`);

export interface StoredMessage extends Message {
  id: number;
  sessionId: string;
  createdAt: string;
}

export interface StoredSession {
  id: string;
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
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  has_summary: number;
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

function ensureSession(sessionId: string, timestamp = now()): void {
  db.prepare(
    `
      INSERT INTO sessions (id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = CASE
        WHEN excluded.updated_at > sessions.updated_at THEN excluded.updated_at
        ELSE sessions.updated_at
      END
    `
  ).run(sessionId, timestamp, timestamp);
}

function defaultSessionTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "新对话";
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized;
}

export function createSession(sessionId: string, title = "新对话"): StoredSession {
  const timestamp = now();
  const normalizedTitle = title.replace(/\s+/g, " ").trim().slice(0, 80) || "新对话";
  db.prepare(
    `
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `
  ).run(sessionId, normalizedTitle, timestamp, timestamp);

  return getSession(sessionId)!;
}

export function getSession(sessionId: string): StoredSession | null {
  const row = db
    .prepare(
      `
        SELECT
          sessions.id,
          sessions.title,
          sessions.created_at,
          sessions.updated_at,
          COUNT(messages.id) AS message_count,
          CASE WHEN session_summaries.session_id IS NULL THEN 0 ELSE 1 END AS has_summary
        FROM sessions
        LEFT JOIN messages ON messages.session_id = sessions.id
        LEFT JOIN session_summaries ON session_summaries.session_id = sessions.id
        WHERE sessions.id = ?
        GROUP BY sessions.id
      `
    )
    .get(sessionId) as unknown as SessionRow | undefined;

  return row ? mapSessionRow(row) : null;
}

export function renameSession(sessionId: string, title: string): StoredSession | null {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return getSession(sessionId);
  db.prepare(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?"
  ).run(normalized.slice(0, 80), now(), sessionId);
  return getSession(sessionId);
}

export function saveConversationTurn(
  sessionId: string,
  userMessage: string,
  assistantMessage: string
): void {
  const timestamp = now();

  db.exec("BEGIN");
  try {
    ensureSession(sessionId, timestamp);
    db.prepare(
      `
        UPDATE sessions
        SET title = CASE WHEN title = '新对话' THEN ? ELSE title END,
            updated_at = ?
        WHERE id = ?
      `
    ).run(defaultSessionTitle(userMessage), timestamp, sessionId);
    const insertMessage = db.prepare(
      `
        INSERT INTO messages (session_id, role, content, created_at)
        VALUES (?, ?, ?, ?)
      `
    );
    insertMessage.run(sessionId, "user", userMessage, timestamp);
    insertMessage.run(sessionId, "assistant", assistantMessage, now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getRecentMessages(
  sessionId: string,
  limit = 100
): Message[] {
  const rows = db
    .prepare(
      `
        SELECT id, session_id, role, content, created_at
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
    )
    .all(sessionId, limit) as unknown as MessageRow[];

  return rows
    .reverse()
    .map((row) => ({ role: row.role, content: row.content }));
}

export function getRecentStoredMessages(
  sessionId: string,
  limit = 100
): StoredMessage[] {
  const rows = db
    .prepare(
      `
        SELECT id, session_id, role, content, created_at
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
    )
    .all(sessionId, limit) as unknown as MessageRow[];

  return rows.reverse().map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function getMessageCount(sessionId: string): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
      `
    )
    .get(sessionId) as unknown as CountRow;

  return row.count;
}

export function getOldestRecentMessageId(
  sessionId: string,
  recentLimit = 100
): number | null {
  const row = db
    .prepare(
      `
        SELECT MIN(id) AS cutoff_id
        FROM (
          SELECT id
          FROM messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
      `
    )
    .get(sessionId, recentLimit) as unknown as CutoffRow;

  return row.cutoff_id;
}

export function listSessions(limit = 50): StoredSession[] {
  const rows = db
    .prepare(
      `
        SELECT
          sessions.id,
          sessions.title,
          sessions.created_at,
          sessions.updated_at,
          COUNT(messages.id) AS message_count,
          CASE WHEN session_summaries.session_id IS NULL THEN 0 ELSE 1 END AS has_summary
        FROM sessions
        LEFT JOIN messages ON messages.session_id = sessions.id
        LEFT JOIN session_summaries ON session_summaries.session_id = sessions.id
        GROUP BY sessions.id
        ORDER BY sessions.updated_at DESC
        LIMIT ?
      `
    )
    .all(limit) as unknown as SessionRow[];

  return rows.map(mapSessionRow);
}

function mapSessionRow(row: SessionRow): StoredSession {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    hasSummary: Boolean(row.has_summary),
  };
}

export function listSessionMessages(
  sessionId: string,
  limit = 200
): StoredMessage[] {
  const rows = db
    .prepare(
      `
        SELECT id, session_id, role, content, created_at
        FROM (
          SELECT id, session_id, role, content, created_at
          FROM messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        ) AS recent_messages
        ORDER BY id ASC
      `
    )
    .all(sessionId, limit) as unknown as MessageRow[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function listMessagesForSummary(
  sessionId: string,
  afterMessageId: number,
  beforeMessageId: number
): StoredMessage[] {
  const rows = db
    .prepare(
      `
        SELECT id, session_id, role, content, created_at
        FROM messages
        WHERE session_id = ?
          AND id > ?
          AND id < ?
        ORDER BY id ASC
      `
    )
    .all(sessionId, afterMessageId, beforeMessageId) as unknown as MessageRow[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function getSessionSummary(sessionId: string): SessionSummary | null {
  const row = db
    .prepare(
      `
        SELECT session_id, content, summarized_through_message_id, updated_at
        FROM session_summaries
        WHERE session_id = ?
      `
    )
    .get(sessionId) as unknown as SummaryRow | undefined;

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    content: row.content,
    summarizedThroughMessageId: row.summarized_through_message_id,
    updatedAt: row.updated_at,
  };
}

export function upsertSessionSummary(
  sessionId: string,
  content: string,
  summarizedThroughMessageId: number
): void {
  const timestamp = now();

  db.exec("BEGIN");
  try {
    ensureSession(sessionId, timestamp);
    db.prepare(
      `
        INSERT INTO session_summaries (
          session_id,
          content,
          summarized_through_message_id,
          updated_at
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          content = excluded.content,
          summarized_through_message_id = excluded.summarized_through_message_id,
          updated_at = excluded.updated_at
      `
    ).run(sessionId, content, summarizedThroughMessageId, timestamp);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function saveToolRun<T>(input: {
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
}): StoredToolRun<T> {
  const fetchedAt = input.fetchedAt ?? now();
  ensureSession(input.sessionId, fetchedAt);
  const result = db.prepare(`
    INSERT INTO tool_runs (
      session_id, tool_type, intent, query, queries_json,
      provider, results_json, status, error, fetched_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    input.expiresAt
  );
  return getToolRun(Number(result.lastInsertRowid)) as StoredToolRun<T>;
}

export function getToolRun<T = unknown>(id: number): StoredToolRun<T> | null {
  const row = db.prepare("SELECT * FROM tool_runs WHERE id = ?").get(id) as ToolRunRow | undefined;
  return row ? mapToolRun<T>(row) : null;
}

export function getLatestToolRun<T = unknown>(
  sessionId: string,
  includeExpired = true
): StoredToolRun<T> | null {
  const row = db.prepare(`
    SELECT * FROM tool_runs
    WHERE session_id = ? ${includeExpired ? "" : "AND expires_at > ?"}
    ORDER BY id DESC LIMIT 1
  `).get(...(includeExpired ? [sessionId] : [sessionId, now()])) as ToolRunRow | undefined;
  return row ? mapToolRun<T>(row) : null;
}

export function listToolRuns<T = unknown>(sessionId: string, limit = 20): StoredToolRun<T>[] {
  const rows = db.prepare(`
    SELECT * FROM tool_runs WHERE session_id = ? ORDER BY id DESC LIMIT ?
  `).all(sessionId, limit) as ToolRunRow[];
  return rows.map((row) => mapToolRun<T>(row));
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
    // The warning below records enough context without exposing stored content.
  }
  logger.warn("database", "invalid tool run JSON ignored", { rowId, field });
  return [];
}

export function clearSessionData(sessionId: string): boolean {
  db.exec("BEGIN");
  try {
    const exists = Boolean(getSession(sessionId));
    if (!exists) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM tool_runs WHERE session_id = ?").run(sessionId);
    db.prepare(
      "UPDATE sessions SET title = '新对话', updated_at = ? WHERE id = ?"
    ).run(now(), sessionId);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function deleteSession(sessionId: string): boolean {
  db.exec("BEGIN");
  try {
    const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getDatabasePath(): string {
  return databasePath;
}

export function closeDatabase(): void {
  if (db.open) db.close();
}
