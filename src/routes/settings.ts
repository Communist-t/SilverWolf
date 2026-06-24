import { Hono } from "hono";
import {
  compatibleModelTemplate,
  createLlmModelConfig,
  deepSeekTemplate,
  deleteLlmModelConfig,
  getActiveLlmModelConfig,
  listLlmModelConfigs,
  setActiveLlmModelConfig,
  toPublicModelConfig,
  updateLlmModelConfig,
  validateLlmModelInput,
  type UpsertLlmModelInput,
} from "../llm/model-configs.js";
import { logger } from "../logger.js";

export const settingsRoute = new Hono();

function parseModelInput(payload: Record<string, unknown>): UpsertLlmModelInput {
  return {
    label: typeof payload.label === "string" ? payload.label : "",
    provider: typeof payload.provider === "string" ? payload.provider : undefined,
    baseURL: typeof payload.baseURL === "string" ? payload.baseURL : "",
    model: typeof payload.model === "string" ? payload.model : "",
    apiKey: typeof payload.apiKey === "string" ? payload.apiKey : "",
  };
}

function parsePartialModelInput(
  payload: Record<string, unknown>
): Partial<UpsertLlmModelInput> {
  return {
    ...(typeof payload.label === "string" ? { label: payload.label } : {}),
    ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
    ...(typeof payload.baseURL === "string" ? { baseURL: payload.baseURL } : {}),
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof payload.apiKey === "string" ? { apiKey: payload.apiKey } : {}),
  };
}

settingsRoute.get("/models", (c) => {
  const models = listLlmModelConfigs().map(toPublicModelConfig);
  return c.json({
    activeModel: toPublicModelConfig(getActiveLlmModelConfig()),
    models,
    templates: {
      compatible: compatibleModelTemplate(),
      deepseek: deepSeekTemplate(),
    },
  });
});

settingsRoute.post("/models", async (c) => {
  try {
    const input = parseModelInput(await c.req.json<Record<string, unknown>>());
    const errors = validateLlmModelInput(input);
    if (errors.length > 0) return c.json({ error: errors.join("；") }, 400);
    const model = createLlmModelConfig(input);
    logger.info("settings", "llm model created", {
      modelId: model.id,
      provider: model.provider,
      model: model.model,
    });
    return c.json({ model: toPublicModelConfig(model) }, 201);
  } catch (err) {
    logger.error("settings", "create llm model failed", { error: String(err) });
    return c.json({ error: "新增模型配置失败" }, 400);
  }
});

settingsRoute.patch("/models/:modelId", async (c) => {
  try {
    const input = parsePartialModelInput(await c.req.json<Record<string, unknown>>());
    const updated = updateLlmModelConfig(c.req.param("modelId"), input);
    if (!updated) return c.json({ error: "模型配置不存在或不可编辑" }, 404);
    logger.info("settings", "llm model updated", {
      modelId: updated.id,
      provider: updated.provider,
      model: updated.model,
    });
    return c.json({ model: toPublicModelConfig(updated) });
  } catch (err) {
    logger.error("settings", "update llm model failed", { error: String(err) });
    return c.json({ error: err instanceof Error ? err.message : "保存模型配置失败" }, 400);
  }
});

settingsRoute.post("/models/:modelId/activate", (c) => {
  const activeModel = setActiveLlmModelConfig(c.req.param("modelId"));
  if (!activeModel) return c.json({ error: "模型配置不存在" }, 404);
  logger.info("settings", "llm model activated", {
    modelId: activeModel.id,
    provider: activeModel.provider,
    model: activeModel.model,
  });
  return c.json({ activeModel: toPublicModelConfig(activeModel) });
});

settingsRoute.delete("/models/:modelId", (c) => {
  const deleted = deleteLlmModelConfig(c.req.param("modelId"));
  return deleted
    ? c.json({ ok: true })
    : c.json({ error: "模型配置不存在、正在使用或不可删除" }, 400);
});
