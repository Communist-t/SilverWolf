import { createHash } from "node:crypto";
import { db } from "../db/conversation-store.js";
import { logger } from "../logger.js";

export type LongTermMemoryCategory =
  | "profile"
  | "preference"
  | "dislike"
  | "boundary"
  | "goal"
  | "fact";

export type LongTermMemoryStatus = "candidate" | "active" | "forgotten";

export interface LongTermMemory {
  id: number;
  ownerId: string;
  memoryKey: string;
  category: LongTermMemoryCategory;
  content: string;
  keywords: string[];
  status: LongTermMemoryStatus;
  evidenceCount: number;
  confidence: number;
  explicit: boolean;
  sourceSessionId: string;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt?: string;
}

interface MemoryRow {
  id: number;
  owner_id: string;
  memory_key: string;
  category: LongTermMemoryCategory;
  content: string;
  keywords_json: string;
  status: LongTermMemoryStatus;
  evidence_count: number;
  confidence: number;
  explicit: number;
  source_session_id: string;
  created_at: string;
  updated_at: string;
  last_recalled_at: string | null;
}

interface MemoryCandidate {
  key: string;
  category: LongTermMemoryCategory;
  content: string;
  keywords: string[];
  explicit: boolean;
  activationThreshold: number;
  confidence: number;
  conflictKey?: string;
}

const DEFAULT_OWNER_ID = "local-default";
const MAX_MEMORY_CONTENT = 240;
const META_RECALL_PATTERN = /(?:记得|记住|了解我|关于我|我的喜好|我的信息|我是谁)/;
const TRANSIENT_PATTERN = /(?:今天|刚才|现在正在|这会儿|临时|待会儿|马上)/;

function now(): string {
  return new Date().toISOString();
}

function cleanValue(value: string): string {
  return value
    .replace(/^[，,：:\s]+|[。！？!?，,；;：:\s]+$/g, "")
    .replace(/(?:啊|呀|呢|哦|啦|了)$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizedKey(value: string): string {
  return cleanValue(value)
    .toLowerCase()
    .replace(/[\s，,。！？!?；;：:'"“”‘’（）()【】\[\]<>《》]/g, "")
    .slice(0, 80);
}

function hashedKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function keywordsFor(...values: string[]): string[] {
  const keywords = new Set<string>();
  const stopwords = new Set([
    "我", "我的", "自己", "一个", "一名", "比较", "非常", "真的", "以后",
    "希望", "记住", "记得", "喜欢", "不喜欢", "讨厌", "不要", "别再",
  ]);
  for (const value of values) {
    for (const token of cleanValue(value).toLowerCase().split(/[\s，,。！？!?；;：:'"“”‘’（）()【】\[\]<>《》/]+/)) {
      if (token.length >= 2 && !stopwords.has(token)) keywords.add(token.slice(0, 32));
    }
  }
  return [...keywords].slice(0, 12);
}

function candidate(
  category: LongTermMemoryCategory,
  key: string,
  content: string,
  value: string,
  options: Partial<Pick<MemoryCandidate, "explicit" | "activationThreshold" | "confidence" | "conflictKey">> = {}
): MemoryCandidate | null {
  const cleaned = cleanValue(value);
  if (!cleaned || cleaned.length < 2) return null;
  return {
    key,
    category,
    content: cleanValue(content).slice(0, MAX_MEMORY_CONTENT),
    keywords: keywordsFor(cleaned, content),
    explicit: options.explicit ?? false,
    activationThreshold: options.activationThreshold ?? 2,
    confidence: options.confidence ?? 0.62,
    conflictKey: options.conflictKey,
  };
}

function extractRememberedContent(input: string): string | null {
  const match = input.match(/^(?:(?:请|麻烦你)\s*(?:记住|记得)|你(?:要|得)\s*(?:记住|记得)|记住[，,：:])\s*(.+)$/);
  return match ? cleanValue(match[1]) : null;
}

export function extractMemoryCandidates(input: string): MemoryCandidate[] {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 2_000) return [];

  const found: MemoryCandidate[] = [];
  const add = (item: MemoryCandidate | null) => {
    if (item && !found.some((existing) => existing.key === item.key)) found.push(item);
  };
  const remembered = extractRememberedContent(text);

  const name = text.match(/(?:我叫|我的名字(?:是|叫)|以后叫我|叫我)\s*([^，。！？!?\n]{1,24})/);
  if (name) {
    const value = cleanValue(name[1]);
    add(candidate("profile", "profile:name", `玩家的称呼是${value}`, value, {
      explicit: true,
      activationThreshold: 1,
      confidence: 0.98,
      conflictKey: "profile:name",
    }));
  }

  const location = text.match(/(?:我住在|我来自|我目前住在|我现在住在)\s*([^，。！？!?\n]{1,32})/);
  if (location) {
    const value = cleanValue(location[1]);
    add(candidate("profile", "profile:location", `玩家居住在${value}`, value, {
      explicit: Boolean(remembered),
      activationThreshold: remembered ? 1 : 2,
      confidence: remembered ? 0.95 : 0.72,
      conflictKey: "profile:location",
    }));
  }

  const occupation = text.match(/(?:我的职业是|我的工作是|我是(?:一名|一个))\s*([^，。！？!?\n]{1,36})/);
  if (occupation) {
    const value = cleanValue(occupation[1]);
    add(candidate("profile", "profile:occupation", `玩家的职业是${value}`, value, {
      explicit: Boolean(remembered),
      activationThreshold: remembered ? 1 : 2,
      confidence: remembered ? 0.95 : 0.7,
      conflictKey: "profile:occupation",
    }));
  }

  const dislike = text.match(/(?:我不喜欢|我讨厌|我不爱)\s*([^，。！？!?\n]{1,80})/);
  if (dislike) {
    const value = cleanValue(dislike[1]);
    const objectKey = normalizedKey(value);
    add(candidate("dislike", `preference:dislike:${objectKey}`, `玩家不喜欢${value}`, value, {
      explicit: Boolean(remembered),
      activationThreshold: remembered ? 1 : 2,
      confidence: remembered ? 0.95 : 0.68,
      conflictKey: objectKey,
    }));
  } else {
    const preference = text.match(/(?:我喜欢|我爱|我偏好|我更喜欢)\s*([^，。！？!?\n]{1,80})/);
    if (preference) {
      const value = cleanValue(preference[1]);
      const objectKey = normalizedKey(value);
      add(candidate("preference", `preference:like:${objectKey}`, `玩家喜欢${value}`, value, {
        explicit: Boolean(remembered),
        activationThreshold: remembered ? 1 : 2,
        confidence: remembered ? 0.95 : 0.68,
        conflictKey: objectKey,
      }));
    }
  }

  const boundary = text.match(/(?:我不希望你|不要再|别再)\s*([^，。！？!?\n]{2,100})/);
  if (boundary) {
    const value = cleanValue(boundary[1]);
    add(candidate("boundary", `boundary:${hashedKey(normalizedKey(value))}`, `玩家要求不要${value}`, value, {
      explicit: true,
      activationThreshold: 1,
      confidence: 0.98,
    }));
  }

  const goal = text.match(/(?:我计划|我打算|我准备|我希望以后|我长期想)\s*([^，。！？!?\n]{2,100})/);
  if (goal && !TRANSIENT_PATTERN.test(goal[0])) {
    const value = cleanValue(goal[1]);
    add(candidate("goal", `goal:${hashedKey(normalizedKey(value))}`, `玩家的长期计划是${value}`, value, {
      explicit: Boolean(remembered),
      activationThreshold: remembered ? 1 : 2,
      confidence: remembered ? 0.92 : 0.64,
    }));
  }

  const stableClauses = text
    .split(/[。！？!?；;\n]+/)
    .map(cleanValue)
    .filter((clause) =>
      clause.length >= 4 &&
      clause.length <= 120 &&
      !TRANSIENT_PATTERN.test(clause) &&
      /(?:我(?:一直|经常|通常|平时|习惯|常用|主要|更倾向|最常)|我的(?:电脑|设备|项目|系统|工作流|习惯|偏好))/.test(clause)
    );
  for (const clause of stableClauses) {
    add(candidate(
      "fact",
      `habit:${hashedKey(normalizedKey(clause))}`,
      `玩家反复提到：${clause}`,
      clause,
      {
        explicit: Boolean(remembered),
        activationThreshold: remembered ? 1 : 2,
        confidence: remembered ? 0.92 : 0.6,
      }
    ));
  }

  if (remembered && found.length === 0) {
    add(candidate("fact", `fact:${hashedKey(normalizedKey(remembered))}`, remembered, remembered, {
      explicit: true,
      activationThreshold: 1,
      confidence: 0.95,
    }));
  }

  return found;
}

export function resolveMemoryOwnerId(token?: string | null): string | null {
  if (!token) return DEFAULT_OWNER_ID;
  const row = db.prepare("SELECT user_id FROM user_tokens WHERE token = ?").get(token) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
}

function mapRow(row: MemoryRow): LongTermMemory {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(row.keywords_json) as unknown;
    if (Array.isArray(parsed)) keywords = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    logger.warn("memory", "invalid memory keywords ignored", { memoryId: row.id });
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    memoryKey: row.memory_key,
    category: row.category,
    content: row.content,
    keywords,
    status: row.status,
    evidenceCount: row.evidence_count,
    confidence: row.confidence,
    explicit: Boolean(row.explicit),
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at ?? undefined,
  };
}

function deactivateConflicts(ownerId: string, item: MemoryCandidate): void {
  if (!item.conflictKey) return;
  db.prepare(
    `UPDATE long_term_memories
     SET status = 'forgotten', updated_at = ?
     WHERE owner_id = ?
       AND memory_key IN (?, ?)
       AND memory_key <> ?`
  ).run(
    now(),
    ownerId,
    `preference:like:${item.conflictKey}`,
    `preference:dislike:${item.conflictKey}`,
    item.key
  );
}

function upsertCandidate(ownerId: string, sessionId: string, item: MemoryCandidate): LongTermMemory {
  const timestamp = now();
  deactivateConflicts(ownerId, item);
  db.prepare(
    `INSERT INTO long_term_memories (
       owner_id, memory_key, category, content, keywords_json, status,
       evidence_count, confidence, explicit, source_session_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, memory_key) DO UPDATE SET
       category = excluded.category,
       content = excluded.content,
       keywords_json = excluded.keywords_json,
       status = CASE
         WHEN excluded.explicit = 1 OR long_term_memories.evidence_count + 1 >= ? THEN 'active'
         ELSE 'candidate'
       END,
       evidence_count = long_term_memories.evidence_count + 1,
       confidence = MIN(1.0, MAX(long_term_memories.confidence, excluded.confidence) + 0.1),
       explicit = MAX(long_term_memories.explicit, excluded.explicit),
       source_session_id = excluded.source_session_id,
       updated_at = excluded.updated_at`
  ).run(
    ownerId,
    item.key,
    item.category,
    item.content,
    JSON.stringify(item.keywords),
    item.explicit || item.activationThreshold <= 1 ? "active" : "candidate",
    item.confidence,
    item.explicit ? 1 : 0,
    sessionId,
    timestamp,
    timestamp,
    item.activationThreshold
  );
  const row = db.prepare(
    "SELECT * FROM long_term_memories WHERE owner_id = ? AND memory_key = ?"
  ).get(ownerId, item.key) as MemoryRow;
  return mapRow(row);
}

export function forgetMemoriesFromMessage(ownerId: string, input: string): number {
  const match = input.match(/(?:忘掉|忘记|不要记得|别记得)[，,：:\s]*(.+)$/);
  if (!match) return 0;
  const target = cleanValue(match[1]);
  if (!target) return 0;
  const rows = listLongTermMemories(ownerId, { includeCandidates: true, includeForgotten: false, limit: 200 });
  const terms = keywordsFor(target);
  const ids = rows
    .filter((memory) =>
      memory.content.includes(target) ||
      target.includes(memory.content) ||
      memory.keywords.some((keyword) => target.includes(keyword) || terms.includes(keyword))
    )
    .map((memory) => memory.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(
    `UPDATE long_term_memories SET status = 'forgotten', updated_at = ? WHERE owner_id = ? AND id IN (${placeholders})`
  ).run(now(), ownerId, ...ids);
  return result.changes;
}

export function observeLongTermMemories(
  ownerId: string,
  sessionId: string,
  userMessage: string
): { observed: LongTermMemory[]; activated: LongTermMemory[]; forgotten: number } {
  const forgotten = forgetMemoriesFromMessage(ownerId, userMessage);
  if (forgotten > 0) return { observed: [], activated: [], forgotten };
  const observed = extractMemoryCandidates(userMessage).map((item) =>
    upsertCandidate(ownerId, sessionId, item)
  );
  return {
    observed,
    activated: observed.filter((memory) => memory.status === "active"),
    forgotten: 0,
  };
}

export function listLongTermMemories(
  ownerId: string,
  options: { includeCandidates?: boolean; includeForgotten?: boolean; limit?: number } = {}
): LongTermMemory[] {
  const statuses = ["active"];
  if (options.includeCandidates) statuses.push("candidate");
  if (options.includeForgotten) statuses.push("forgotten");
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM long_term_memories
     WHERE owner_id = ? AND status IN (${placeholders})
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
              confidence DESC, evidence_count DESC, updated_at DESC
     LIMIT ?`
  ).all(ownerId, ...statuses, Math.min(Math.max(options.limit ?? 100, 1), 500)) as MemoryRow[];
  return rows.map(mapRow);
}

export function recallLongTermMemories(
  ownerId: string,
  query: string,
  limit = 8
): LongTermMemory[] {
  const memories = listLongTermMemories(ownerId, { limit: 200 });
  const normalizedQuery = query.toLowerCase();
  const queryKeywords = keywordsFor(query);
  const metaRecall = META_RECALL_PATTERN.test(query);
  const scored = memories.map((memory) => {
    let score = memory.confidence + Math.min(memory.evidenceCount, 5) * 0.08;
    for (const keyword of memory.keywords) {
      if (normalizedQuery.includes(keyword) || queryKeywords.includes(keyword)) score += 2.5;
    }
    if (metaRecall) score += 1.5;
    if (memory.category === "profile" || memory.category === "boundary") score += 0.35;
    return { memory, score };
  });
  const recalled = scored
    .filter(({ score }) => metaRecall || score >= 1.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(limit, 1), 20))
    .map(({ memory }) => memory);
  if (recalled.length > 0) {
    const timestamp = now();
    const ids = recalled.map((memory) => memory.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE long_term_memories SET last_recalled_at = ? WHERE owner_id = ? AND id IN (${placeholders})`
    ).run(timestamp, ownerId, ...ids);
  }
  return recalled;
}

export function forgetLongTermMemory(ownerId: string, memoryId: number): boolean {
  const result = db.prepare(
    "UPDATE long_term_memories SET status = 'forgotten', updated_at = ? WHERE owner_id = ? AND id = ?"
  ).run(now(), ownerId, memoryId);
  return result.changes > 0;
}

export function clearLongTermMemories(ownerId: string): number {
  const result = db.prepare("DELETE FROM long_term_memories WHERE owner_id = ?").run(ownerId);
  return result.changes;
}

export function getLongTermMemoryStats(ownerId: string): {
  active: number;
  candidates: number;
  forgotten: number;
} {
  const rows = db.prepare(
    "SELECT status, COUNT(*) AS count FROM long_term_memories WHERE owner_id = ? GROUP BY status"
  ).all(ownerId) as Array<{ status: LongTermMemoryStatus; count: number }>;
  const counts = { active: 0, candidates: 0, forgotten: 0 };
  for (const row of rows) {
    if (row.status === "active") counts.active = row.count;
    else if (row.status === "candidate") counts.candidates = row.count;
    else counts.forgotten = row.count;
  }
  return counts;
}
