/**
 * 大模型 API 适配层
 *
 * 基于 OpenAI 兼容协议。换模型只需修改 .env 中的 baseURL + apiKey + model。
 * 支持的模型（示例）：
 *   - OpenAI:    baseURL=https://api.openai.com/v1
 *   - DeepSeek:  baseURL=https://api.deepseek.com/v1
 *   - 其他兼容服务: 填入对应 baseURL 即可
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import {
  getActiveLlmModelConfig,
  type LlmModelConfig,
} from "./model-configs.js";

function createClient() {
  const activeModel = getActiveLlmModelConfig();
  return {
    activeModel,
    client: new OpenAI({
      apiKey: activeModel.apiKey,
      baseURL: activeModel.baseURL,
      httpAgent: config.llm.proxyURL
        ? new HttpsProxyAgent(config.llm.proxyURL)
        : undefined,
    }),
  };
}

export interface ChatParams {
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onModelResolved?: (model: LlmModelConfig) => void;
}

export interface ChatStreamParams extends ChatParams {
  onDelta: (delta: string) => void | Promise<void>;
}

/**
 * 调用大模型完成对话。
 * 返回模型回复的文本内容。
 */
export async function chat(params: ChatParams): Promise<string> {
  const { client, activeModel } = createClient();
  params.onModelResolved?.(activeModel);
  const response = await client.chat.completions.create({
    model: activeModel.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.8,
    max_tokens: params.maxTokens ?? 512,
  }, { signal: params.signal });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("模型返回为空，请检查 API 配置。");
  }

  return content;
}

/**
 * 流式调用大模型完成对话。
 * 每收到一段 token delta 就调用 onDelta，并返回完整文本。
 */
export async function chatStream(params: ChatStreamParams): Promise<string> {
  const { client, activeModel } = createClient();
  params.onModelResolved?.(activeModel);
  const stream = await client.chat.completions.create({
    model: activeModel.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.8,
    max_tokens: params.maxTokens ?? 512,
    stream: true,
  }, { signal: params.signal });

  let content = "";
  for await (const chunk of stream) {
    params.signal?.throwIfAborted();
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (!delta) {
      continue;
    }

    content += delta;
    await params.onDelta(delta);
  }

  if (!content) {
    throw new Error("模型返回为空，请检查 API 配置。");
  }

  return content;
}

/** 暴露原始 client，供高级用法使用 */
export function getRawClient(): OpenAI {
  return createClient().client;
}
