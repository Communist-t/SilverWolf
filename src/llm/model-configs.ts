import { randomUUID } from "node:crypto";
import { db } from "../db/conversation-store.js";
import { config } from "../config.js";

const ENV_MODEL_ID = "env-default";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_COMPATIBLE_BASE_URL = "https://api.example.com/v1";

db.exec(`
  CREATE TABLE IF NOT EXISTS llm_model_configs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_model_configs_single_active
    ON llm_model_configs(active)
    WHERE active = 1;
`);

export interface LlmModelConfig {
  id: string;
  label: string;
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
  active: boolean;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicLlmModelConfig extends Omit<LlmModelConfig, "apiKey"> {
  hasApiKey: boolean;
}

interface LlmModelConfigRow {
  id: string;
  label: string;
  provider: string;
  base_url: string;
  model: string;
  api_key: string;
  active: number;
  built_in: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertLlmModelInput {
  label: string;
  provider?: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function inferProvider(baseURL: string, model: string): string {
  const combined = `${baseURL} ${model}`.toLowerCase();
  if (combined.includes("deepseek")) return "DeepSeek";
  if (combined.includes("agnes")) return "Agnes";
  if (combined.includes("openai") || combined.includes("gpt-")) return "OpenAI";
  return "OpenAI 兼容";
}

function isGenericAccessFormat(value: string): boolean {
  return /^(openai\s*compatible|openai\s*兼容|兼容|openai)$/i.test(
    value.replace(/\s+/g, " ").trim()
  );
}

function normalizeProvider(provider: string | undefined, baseURL: string, model: string): string {
  const normalized = normalizeText(provider ?? "", 40);
  if (!normalized || isGenericAccessFormat(normalized)) {
    return normalizeText(inferProvider(baseURL, model), 40);
  }
  return normalized;
}

function validateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function validateLlmModelInput(input: UpsertLlmModelInput): string[] {
  const errors: string[] = [];
  if (!normalizeText(input.label, 80)) errors.push("配置名称不能为空");
  if (!normalizeText(input.model, 120)) errors.push("模型 ID 不能为空");
  const baseURL = input.baseURL.trim();
  if (!baseURL || !validateHttpUrl(baseURL)) {
    errors.push("Base URL 必须是有效的 HTTP(S) 地址");
  }
  if (!input.apiKey.trim()) errors.push("API Key 不能为空");
  return errors;
}

function mapRow(row: LlmModelConfigRow): LlmModelConfig {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    baseURL: row.base_url,
    model: row.model,
    apiKey: row.api_key,
    active: Boolean(row.active),
    builtIn: Boolean(row.built_in),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicModelConfig(model: LlmModelConfig): PublicLlmModelConfig {
  const { apiKey, ...safeModel } = model;
  return { ...safeModel, hasApiKey: Boolean(apiKey.trim()) };
}

function activateFirstAvailableModel(excludedId?: string): void {
  const fallback = db
    .prepare(
      `
        SELECT id FROM llm_model_configs
        WHERE id != ? AND TRIM(api_key) != ''
        ORDER BY updated_at DESC
        LIMIT 1
      `
    )
    .get(excludedId ?? "") as { id: string } | undefined;
  if (!fallback) return;

  db.prepare("UPDATE llm_model_configs SET active = 0").run();
  db.prepare("UPDATE llm_model_configs SET active = 1, updated_at = ? WHERE id = ?").run(
    now(),
    fallback.id
  );
}

function removeEnvironmentModelConfig(): void {
  const existing = db
    .prepare("SELECT active FROM llm_model_configs WHERE id = ?")
    .get(ENV_MODEL_ID) as { active: number } | undefined;
  if (!existing) return;

  db.exec("BEGIN");
  try {
    if (existing.active) activateFirstAvailableModel(ENV_MODEL_ID);
    db.prepare("DELETE FROM llm_model_configs WHERE id = ?").run(ENV_MODEL_ID);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function seedEnvironmentModelConfig(): void {
  const envApiKey = config.llm.apiKey.trim();
  if (!envApiKey) {
    removeEnvironmentModelConfig();
    return;
  }

  const timestamp = now();
  const activeCount = db
    .prepare("SELECT COUNT(*) AS count FROM llm_model_configs WHERE active = 1")
    .get() as { count: number };
  const existing = db
    .prepare("SELECT id FROM llm_model_configs WHERE id = ?")
    .get(ENV_MODEL_ID) as { id: string } | undefined;

  db.prepare(
    `
      INSERT INTO llm_model_configs (
        id, label, provider, base_url, model, api_key,
        active, built_in, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        base_url = excluded.base_url,
        model = excluded.model,
        api_key = excluded.api_key,
        updated_at = excluded.updated_at
    `
  ).run(
    ENV_MODEL_ID,
    "当前 .env 配置",
    inferProvider(config.llm.baseURL, config.llm.model),
    config.llm.baseURL,
    config.llm.model,
    envApiKey,
    existing ? 0 : activeCount.count === 0 ? 1 : 0,
    timestamp,
    timestamp
  );
}

export function listLlmModelConfigs(): LlmModelConfig[] {
  seedEnvironmentModelConfig();
  const rows = db
    .prepare("SELECT * FROM llm_model_configs ORDER BY active DESC, built_in DESC, updated_at DESC")
    .all() as LlmModelConfigRow[];
  return rows.map(mapRow);
}

export function getActiveLlmModelConfig(): LlmModelConfig {
  seedEnvironmentModelConfig();
  const row = db
    .prepare("SELECT * FROM llm_model_configs WHERE active = 1 LIMIT 1")
    .get() as LlmModelConfigRow | undefined;
  if (row) return mapRow(row);

  activateFirstAvailableModel();
  const activated = db
    .prepare("SELECT * FROM llm_model_configs WHERE active = 1 LIMIT 1")
    .get() as LlmModelConfigRow | undefined;
  if (activated) return mapRow(activated);

  throw new Error("没有可用的模型配置，请先在模型设置中新增 DeepSeek 配置。");
}

export function createLlmModelConfig(input: UpsertLlmModelInput): LlmModelConfig {
  const errors = validateLlmModelInput(input);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const timestamp = now();
  const baseURL = input.baseURL.trim();
  const model = normalizeText(input.model, 120);
  const label = normalizeText(input.label, 80);
  const provider = normalizeProvider(input.provider, baseURL, model);
  const id = randomUUID();

  db.prepare(
    `
      INSERT INTO llm_model_configs (
        id, label, provider, base_url, model, api_key,
        active, built_in, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `
  ).run(id, label, provider, baseURL, model, input.apiKey.trim(), timestamp, timestamp);

  return getLlmModelConfig(id)!;
}

export function updateLlmModelConfig(
  id: string,
  input: Partial<UpsertLlmModelInput>
): LlmModelConfig | null {
  const current = getLlmModelConfig(id);
  if (!current || current.builtIn) return null;
  const next = {
    label: input.label ?? current.label,
    provider: input.provider ?? current.provider,
    baseURL: input.baseURL ?? current.baseURL,
    model: input.model ?? current.model,
    apiKey: input.apiKey ?? current.apiKey,
  };
  const errors = validateLlmModelInput(next);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const baseURL = next.baseURL.trim();
  const model = normalizeText(next.model, 120);
  db.prepare(
    `
      UPDATE llm_model_configs
      SET label = ?, provider = ?, base_url = ?, model = ?, api_key = ?, updated_at = ?
      WHERE id = ? AND built_in = 0
    `
  ).run(
    normalizeText(next.label, 80),
    normalizeProvider(next.provider, baseURL, model),
    baseURL,
    model,
    next.apiKey.trim(),
    now(),
    id
  );
  return getLlmModelConfig(id);
}

export function getLlmModelConfig(id: string): LlmModelConfig | null {
  seedEnvironmentModelConfig();
  const row = db
    .prepare("SELECT * FROM llm_model_configs WHERE id = ?")
    .get(id) as LlmModelConfigRow | undefined;
  return row ? mapRow(row) : null;
}

export function setActiveLlmModelConfig(id: string): LlmModelConfig | null {
  seedEnvironmentModelConfig();
  const target = getLlmModelConfig(id);
  if (!target) return null;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE llm_model_configs SET active = 0").run();
    db.prepare("UPDATE llm_model_configs SET active = 1, updated_at = ? WHERE id = ?").run(
      now(),
      id
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getLlmModelConfig(id);
}

export function deleteLlmModelConfig(id: string): boolean {
  seedEnvironmentModelConfig();
  db.exec("BEGIN");
  try {
    const target = getLlmModelConfig(id);
    if (!target || target.builtIn || target.active) {
      db.exec("ROLLBACK");
      return false;
    }
    const result = db
      .prepare("DELETE FROM llm_model_configs WHERE id = ? AND built_in = 0 AND active = 0")
      .run(id);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function deepSeekTemplate(): Pick<LlmModelConfig, "label" | "provider" | "baseURL" | "model"> {
  return {
    label: "DeepSeek Flash",
    provider: "DeepSeek",
    baseURL: DEFAULT_DEEPSEEK_BASE_URL,
    model: "deepseek-v4-flash",
  };
}

export function compatibleModelTemplate(): Pick<
  LlmModelConfig,
  "label" | "provider" | "baseURL" | "model"
> {
  return {
    label: "自定义模型",
    provider: "OpenAI 兼容",
    baseURL: DEFAULT_COMPATIBLE_BASE_URL,
    model: "custom-model",
  };
}
