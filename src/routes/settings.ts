import { Hono } from "hono";
import OpenAI from "openai";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import {
  compatibleModelTemplate,
  createLlmModelConfig,
  deepSeekTemplate,
  deleteLlmModelConfig,
  getActiveLlmModelConfig,
  getLlmModelConfig,
  listLlmModelConfigs,
  setActiveLlmModelConfig,
  toPublicModelConfig,
  updateLlmModelConfig,
  validateLlmModelInput,
  type UpsertLlmModelInput,
  type PublicLlmModelConfig,
} from "../llm/model-configs.js";
import { logger } from "../logger.js";
import { listSkills } from "../tools/skill-manager.js";

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

function parseModelTestInput(payload: Record<string, unknown>): UpsertLlmModelInput & {
  modelId?: string;
} {
  return {
    ...parseModelInput(payload),
    modelId: typeof payload.modelId === "string" ? payload.modelId : undefined,
  };
}

function safeModelTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer ***")
    .slice(0, 240);
}

settingsRoute.get("/models", async (c) => {
  const models = (await listLlmModelConfigs()).map(toPublicModelConfig);
  let activeModel: PublicLlmModelConfig | null = null;
  try {
    activeModel = toPublicModelConfig(await getActiveLlmModelConfig());
  } catch {
    // 没有可用的已激活模型配置
  }
  return c.json({
    activeModel,
    models,
    templates: {
      compatible: compatibleModelTemplate(),
      deepseek: deepSeekTemplate(),
    },
  });
});

settingsRoute.get("/skills", (c) => {
  return c.json({
    skills: listSkills().map((skill) => ({
      ...skill,
      status: "online",
      builtIn: true,
    })),
  });
});

settingsRoute.post("/models/test", async (c) => {
  try {
    const input = parseModelTestInput(await c.req.json<Record<string, unknown>>());
    const savedModel = input.modelId ? await getLlmModelConfig(input.modelId) : null;
    const resolvedInput: UpsertLlmModelInput = {
      label: input.label || "模型测试",
      provider: input.provider,
      baseURL: input.baseURL,
      model: input.model,
      apiKey: input.apiKey.trim() || savedModel?.apiKey || "",
    };
    const errors = validateLlmModelInput(resolvedInput);
    if (errors.length > 0) return c.json({ error: errors.join("；") }, 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const client = new OpenAI({
        apiKey: resolvedInput.apiKey.trim(),
        baseURL: resolvedInput.baseURL.trim(),
        httpAgent: config.llm.proxyURL
          ? new HttpsProxyAgent(config.llm.proxyURL)
          : undefined,
      });
      const response = await client.chat.completions.create(
        {
          model: resolvedInput.model.trim(),
          messages: [
            {
              role: "user",
              content: "ping",
            },
          ],
          temperature: 0,
          max_tokens: 4,
        },
        { signal: controller.signal }
      );
      const content = response.choices[0]?.message?.content ?? "";
      return c.json({
        ok: true,
        model: resolvedInput.model.trim(),
        replyPreview: content.slice(0, 80),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.warn("settings", "llm model test failed", {
      error: safeModelTestError(err),
    });
    return c.json({ error: `测试失败：${safeModelTestError(err)}` }, 400);
  }
});

settingsRoute.post("/models", async (c) => {
  try {
    const input = parseModelInput(await c.req.json<Record<string, unknown>>());
    const errors = validateLlmModelInput(input);
    if (errors.length > 0) return c.json({ error: errors.join("；") }, 400);
    const model = await createLlmModelConfig(input);
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
    const updated = await updateLlmModelConfig(c.req.param("modelId"), input);
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

settingsRoute.post("/models/:modelId/activate", async (c) => {
  const activeModel = await setActiveLlmModelConfig(c.req.param("modelId"));
  if (!activeModel) return c.json({ error: "模型配置不存在" }, 404);
  logger.info("settings", "llm model activated", {
    modelId: activeModel.id,
    provider: activeModel.provider,
    model: activeModel.model,
  });
  return c.json({ activeModel: toPublicModelConfig(activeModel) });
});

settingsRoute.delete("/models/:modelId", async (c) => {
  const deleted = await deleteLlmModelConfig(c.req.param("modelId"));
  return deleted
    ? c.json({ ok: true })
    : c.json({ error: "模型配置不存在、正在使用或不可删除" }, 400);
});
