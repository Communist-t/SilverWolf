import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

const ENV_MODEL_ID = "env-default";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_COMPATIBLE_BASE_URL = "https://api.example.com/v1";

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

async function activateFirstAvailableModel(excludedId?: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `
      SELECT id FROM llm_model_configs
      WHERE id != $1 AND TRIM(api_key) != ''
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [excludedId ?? ""]
  );
  if (result.rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE llm_model_configs SET active = 0");
    await client.query("UPDATE llm_model_configs SET active = 1, updated_at = $1 WHERE id = $2", [
      now(),
      result.rows[0].id,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function removeEnvironmentModelConfig(): Promise<void> {
  const result = await pool.query<{ active: number }>(
    "SELECT active FROM llm_model_configs WHERE id = $1",
    [ENV_MODEL_ID]
  );
  if (result.rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (result.rows[0].active) await activateFirstAvailableModel(ENV_MODEL_ID);
    await client.query("DELETE FROM llm_model_configs WHERE id = $1", [ENV_MODEL_ID]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function seedEnvironmentModelConfig(): Promise<void> {
  const envApiKey = config.llm.apiKey.trim();
  if (!envApiKey) {
    await removeEnvironmentModelConfig();
    return;
  }

  const timestamp = now();
  const activeResult = await pool.query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM llm_model_configs WHERE active = 1"
  );
  const existingResult = await pool.query<{ id: string }>(
    "SELECT id FROM llm_model_configs WHERE id = $1",
    [ENV_MODEL_ID]
  );
  const activeCount = Number(activeResult.rows[0].count);
  const existing = existingResult.rows.length > 0;

  await pool.query(
    `
      INSERT INTO llm_model_configs (
        id, label, provider, base_url, model, api_key,
        active, built_in, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)
      ON CONFLICT(id) DO UPDATE SET
        provider = EXCLUDED.provider,
        base_url = EXCLUDED.base_url,
        model = EXCLUDED.model,
        api_key = EXCLUDED.api_key,
        updated_at = EXCLUDED.updated_at
    `,
    [
      ENV_MODEL_ID,
      "当前 .env 配置",
      inferProvider(config.llm.baseURL, config.llm.model),
      config.llm.baseURL,
      config.llm.model,
      envApiKey,
      existing ? 0 : activeCount === 0 ? 1 : 0,
      timestamp,
      timestamp,
    ]
  );
}

export async function listLlmModelConfigs(): Promise<LlmModelConfig[]> {
  await seedEnvironmentModelConfig();
  const result = await pool.query<LlmModelConfigRow>(
    "SELECT * FROM llm_model_configs ORDER BY active DESC, built_in DESC, updated_at DESC"
  );
  return result.rows.map(mapRow);
}

export async function getActiveLlmModelConfig(): Promise<LlmModelConfig> {
  await seedEnvironmentModelConfig();
  const result = await pool.query<LlmModelConfigRow>(
    "SELECT * FROM llm_model_configs WHERE active = 1 LIMIT 1"
  );
  if (result.rows.length > 0) return mapRow(result.rows[0]);

  await activateFirstAvailableModel();
  const activated = await pool.query<LlmModelConfigRow>(
    "SELECT * FROM llm_model_configs WHERE active = 1 LIMIT 1"
  );
  if (activated.rows.length > 0) return mapRow(activated.rows[0]);

  throw new Error("没有可用的模型配置，请先在模型设置中新增 DeepSeek 配置。");
}

export async function createLlmModelConfig(input: UpsertLlmModelInput): Promise<LlmModelConfig> {
  const errors = validateLlmModelInput(input);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const timestamp = now();
  const baseURL = input.baseURL.trim();
  const model = normalizeText(input.model, 120);
  const label = normalizeText(input.label, 80);
  const provider = normalizeProvider(input.provider, baseURL, model);
  const id = randomUUID();

  await pool.query(
    `
      INSERT INTO llm_model_configs (
        id, label, provider, base_url, model, api_key,
        active, built_in, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8)
    `,
    [id, label, provider, baseURL, model, input.apiKey.trim(), timestamp, timestamp]
  );

  return (await getLlmModelConfig(id))!;
}

export async function updateLlmModelConfig(
  id: string,
  input: Partial<UpsertLlmModelInput>
): Promise<LlmModelConfig | null> {
  const current = await getLlmModelConfig(id);
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
  await pool.query(
    `
      UPDATE llm_model_configs
      SET label = $1, provider = $2, base_url = $3, model = $4, api_key = $5, updated_at = $6
      WHERE id = $7 AND built_in = 0
    `,
    [
      normalizeText(next.label, 80),
      normalizeProvider(next.provider, baseURL, model),
      baseURL,
      model,
      next.apiKey.trim(),
      now(),
      id,
    ]
  );
  return getLlmModelConfig(id);
}

export async function getLlmModelConfig(id: string): Promise<LlmModelConfig | null> {
  await seedEnvironmentModelConfig();
  const result = await pool.query<LlmModelConfigRow>(
    "SELECT * FROM llm_model_configs WHERE id = $1",
    [id]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function setActiveLlmModelConfig(id: string): Promise<LlmModelConfig | null> {
  await seedEnvironmentModelConfig();
  const target = await getLlmModelConfig(id);
  if (!target) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE llm_model_configs SET active = 0");
    await client.query("UPDATE llm_model_configs SET active = 1, updated_at = $1 WHERE id = $2", [
      now(),
      id,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return getLlmModelConfig(id);
}

export async function deleteLlmModelConfig(id: string): Promise<boolean> {
  await seedEnvironmentModelConfig();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await getLlmModelConfig(id);
    if (!target || target.builtIn || target.active) {
      await client.query("ROLLBACK");
      return false;
    }
    const result = await client.query(
      "DELETE FROM llm_model_configs WHERE id = $1 AND built_in = 0 AND active = 0",
      [id]
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
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
