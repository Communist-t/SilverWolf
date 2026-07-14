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
import type { ChatCompletionMessageParam, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import {
  getActiveLlmModelConfig,
  type LlmModelConfig,
} from "./model-configs.js";
import { logger } from "../logger.js";

// ── 思考过程过滤 ──────────────────────────────────────────────

/**
 * 中文思考过程开头的特征模式
 */
const CHINESE_THINKING_START_PATTERNS: RegExp[] = [
  /^好的[，,]?\s*(用户|玩家|这|首先|根据)/,           // "好的，用户发来..."
  /^(用户|玩家)(发来|说|的消息|问|想要|又|可能)/,          // "用户发来..."
  /^我(需要|应该|要|来|先|现在|不能|不|也|得)/,         // "我需要按照..."
  /^(首先|第一步|分析一下|让我想想|让我分析|回顾)/,      // "首先，..."
  /^(嗯|呃|让我|那么|实际上|不过)[，,]/,                // "嗯，让我想想..."
  /^根据(规则|之前的|示例|上下文|系统|设定)/,            // "根据规则..."
  /^(可能|也许|大概)(的)?(回复|回答|方向|思路)/,      // "可能的回复方向..."
  /^还需要(考虑|注意|检查)/,                             // "还需要考虑..."
  /^同时[，,]?(规则|注意|需要|保持|用户)/,              // "同时，规则12..."
  /^(另外|此外|还有)[，,]/,                             // "另外，..."
];

/**
 * 中文思考过程的元推理关键词（出现这些词的段落很可能是思考过程）
 */
const META_REASONING_PATTERNS: RegExp[] = [
  // ── 中文元推理 ──
  /我(需要|应该|要|来|先|现在|不能|不|也|得|可能)/,
  /(用户|玩家)(可能|接下来|发来|说|的消息|问|想要|的意图|的想法|又|是在|已经)/,
  /(规则|注意|禁止|避免|不能|不要|必须|应该|不允许)/,
  /(检查|确认|验证|最后确认|确认一下|自检|自查)/,
  /(符合|违反|是否|有没有)/,
  /(之前的例子|示例中|few-?shot|之前的回复)/i,
  /(另外|此外|还有|同时)/,
  /保持.*(语气|风格|性格|态度|简短|自然|连贯)/,
  /(所以正确|没问题|即可|正确|确保)/,
  /作为银狼.*应该/,
  /(银狼|角色)的(身份|性格|语气|风格|设定)/,
  /(客服腔|英文混用|中文标点|禁止词汇)/,
  /(预测|推测|猜测|判断|分析).*(用户|玩家|意图|想法)/,
  /(日期是|当前日期|时间背景|2026)/,
  /(回复方向|回复内容|可能的回复|思路|方向)/,
  /(需要换|需要保持|需要确保|需要考虑|需要注意|需要检查)/,
  /(第一次|第二次|第三次|上一轮|上一次|之前|此前)/,
  /(问候语|开场白|打招呼)/,

  // ── 英文元推理 ──
  /^(Thinking|Thought|Analyze|Analysis|Determine|Identify|Consider|Context|Constraints?|Key\s+Point|Background|Roleplay|Perspective|Step|Solution|Approach|Strategy|Reasoning|Evaluation|Assessment|Intent|Goal|Objective|Silver\s+Wolf|She|Better|Date)\b/i,
  /\b(user|users|player)\b.*\b(ask|asks|asked|want|wants|needs?|intent|question|request)/i,
  /\b(I|we)\b.*\b(need to|should|must|have to|will|am going to|would|could)/i,
  /\b(roleplay|role-playing|in character|out of character|stay in character)\b/i,
  /\b(constraint|rule|instruction|guideline|system prompt)\b/i,
  /\b(personality|tone|style|casual|tsundere|gamer slang)\b/i,
  /\b(memory|long.?term|session|data|storage|cache|log)\b/i,
  /\b(avoid|don't|do not|must not|should not|cannot)\b/i,
  /\b(customer service|formal|polite|generic)\b/i,
  /\b(few.?shot|example|sample|demonstration)\b/i,
  /\b(however|therefore|thus|so|because|since|although|while|whereas)\b.*\b(user|player|response|reply|answer)/i,
  /\b(better|alternative|option|approach)\b.*\b(response|reply|answer|message)/i,
  /\b(silver wolf|honkai|star rail)\b/i,
  /\b(she|her)\b.*\b(would|might|could|should|needs? to|won't)\b/i,
  /\b(dry technical|deflect|downplay|worldview|data persistence|hacker persona)\b/i,
  /\b(breaking character|admit|AI with)\b/i,
  /\b(2026)\b/i,
];

/**
 * 检测文本是否以思考过程开头（支持标签和纯文本格式）
 */
function startsWithThinking(text: string): boolean {
  const trimmed = text.trimStart();

  // 标签格式
  if (
    trimmed.startsWith("<think") ||
    trimmed.startsWith("<reasoning") ||
    trimmed.startsWith("<|thinking")
  ) {
    return true;
  }

  // 英文文本头
  if (
    /^Thinking\s*(Process)?\s*[:：]/i.test(trimmed) ||
    /^Thought\s*Process\s*[:：]/i.test(trimmed) ||
    /^Let me think/i.test(trimmed) ||
    /^Analyze\s+(the\s+)?Request/i.test(trimmed) ||
    /^Step\s*\d+/i.test(trimmed) ||
    /^(Determine|Identify|Consider|Context|Constraints?|Key\s+Point|Background|Solution|Approach|Strategy|Reasoning|Evaluation)\s*[:\-]/i.test(trimmed)
  ) {
    return true;
  }

  // 中文思考过程开头
  for (const pattern of CHINESE_THINKING_START_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * 检测段落是否包含元推理（即是否为思考过程内容）
 */
function containsMetaReasoning(paragraph: string): boolean {
  return META_REASONING_PATTERNS.some((pattern) => pattern.test(paragraph));
}

/**
 * 从完整文本中剥离思考过程，只保留实际回复
 *
 * 支持的格式：
 * 1. <think>...</think> 等标签格式
 * 2. "Thinking Process:" 等英文文本头
 * 3. "好的，用户发来..." 等中文纯文本思考过程
 */
function stripThinkingContent(text: string): string {
  let result = text;

  // ── 阶段 1：移除标签格式 ──
  result = result.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  result = result.replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "");
  result = result.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  result = result.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "");

  result = result.trim();
  if (!result) return result;

  // ── 阶段 2：检测是否有思考过程 ──
  if (!startsWithThinking(result)) {
    // 快速检查：即使不以思考开头，如果前几个段落全是元推理，也可能有思考过程
    const paragraphs = result.split(/\n{2,}/);
    if (paragraphs.length < 3) {
      // 段落太少，不太可能有思考过程
      return result.replace(/<\/?(?:think|reasoning|thinking)[^>]*>/gi, "")
        .replace(/<\|\/?thinking\|>/gi, "")
        .trim();
    }
  }

  // ── 阶段 3：按段落分析，剥离思考部分 ──
  const paragraphs = result.split(/\n{2,}/);

  if (paragraphs.length >= 2) {
    // 检查前半部分是否包含大量元推理
    const firstHalfEnd = Math.min(paragraphs.length, Math.ceil(paragraphs.length / 2));
    let metaReasoningCount = 0;
    for (let i = 0; i < firstHalfEnd; i++) {
      if (containsMetaReasoning(paragraphs[i])) metaReasoningCount++;
    }

    // 如果前半部分有超过一半的段落包含元推理，认为是思考过程
    if (metaReasoningCount >= Math.ceil(firstHalfEnd / 2) || startsWithThinking(result)) {
      // 从后往前找第一个不包含元推理的段落
      let responseStartIdx = -1;
      for (let i = paragraphs.length - 1; i >= 0; i--) {
        const para = paragraphs[i].trim();
        if (!para) continue;

        if (!containsMetaReasoning(para) && !startsWithThinking(para)) {
          responseStartIdx = i;
        } else {
          // 一旦遇到元推理段落，停止搜索（实际回复应该是连续的）
          if (responseStartIdx !== -1) break;
        }
      }

      if (responseStartIdx !== -1) {
        const filtered = paragraphs.slice(responseStartIdx).join("\n\n").trim();
        if (filtered) {
          logger.debug("llm", "thinking content stripped by paragraph analysis", {
            originalParagraphs: paragraphs.length,
            thinkingParagraphs: responseStartIdx,
            responseParagraphs: paragraphs.length - responseStartIdx,
            originalLength: result.length,
            filteredLength: filtered.length,
          });
          result = filtered;
        }
      } else {
        // 所有段落都包含元推理 — 尝试提取引号内的对话作为兜底
        const extracted = extractQuotedDialog(result);
        if (extracted) {
          logger.info("llm", "all paragraphs are meta-reasoning, extracted quoted dialog", {
            originalLength: result.length,
            extractedLength: extracted.length,
          });
          result = extracted;
        } else {
          // 无法提取对话，尝试用分隔标记
          result = trySeparatorBasedFilter(result);
        }
      }
    }
  } else {
    // 只有 1-2 个段落，尝试分隔标记
    result = trySeparatorBasedFilter(result);
  }

  // ── 阶段 4：清理残留标记和分隔前缀 ──
  result = result
    .replace(/<\/?(?:think|reasoning|thinking)[^>]*>/gi, "")
    .replace(/<\|\/?thinking\|>/gi, "")
    .replace(/^(Response|Output|Answer|Final\s+(?:Answer|Response)|My\s+(?:response|answer|reply)|回复|回答|输出)\s*[:：]\s*/i, "")
    .trim();

  return result;
}

/**
 * 当所有段落都是元推理时，尝试从文本中提取引号内的对话作为兜底
 *
 * 模型在思考过程中经常会"预演"回复内容，用引号括起来：
 *   比如"哟，又来了？看来你的账号还没被注销。"
 *   例如"这问候语太常规了，想引起我注意得加个隐藏彩蛋。"
 *
 * 本函数提取最后一个（最接近最终回复的）引号内容
 */
function extractQuotedDialog(text: string): string | null {
  // 匹配中文引号「」『』"" 和英文引号 "" 中的内容
  // 注意：中文双引号 \u201C(")是开引号，\u201D(")是闭引号，必须分开匹配
  const quotePatterns = [
    /\u201C([^\u201D\n]{4,})\u201D/g,   // 中文双引号 "..." (\u201C...\u201D)
    /[\u300C\u300E]([^\u300D\u300F\n]{4,})[\u300D\u300F]/g,  // 中文角引号 「...」『...』
    /"([^"\n]{4,})"/g,                   // 英文双引号 "..."
  ];

  const allMatches: string[] = [];

  for (const pattern of quotePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1].trim();
      // 过滤掉太短的（可能是术语引用）和太长的（可能是规则引用）
      if (content.length < 4 || content.length > 200) continue;

      // 排除明显是规则/术语引用的内容
      if (/(规则|禁止|注意|不能|必须|应该|客服腔|英文混用|禁止词汇)/.test(content)) continue;

      // 排除明显是分析性描述的内容（不是对话）
      // 对话通常以语气词、称呼、感叹号、问号等开头
      // 分析性内容通常以"根据"、"用户"、"规则"等开头
      if (/^(根据|用户|玩家|规则|首先|另外|此外|还需要|同时|可能|也许|如果|因为|所以|但是|不过|比如|例如|比如|第一次|第二次|第三次|上一轮|上一次|之前|此前|回顾|检查|确认|保持|避免|作为)/.test(content)) continue;

      // 排除包含明显分析性词汇的内容
      if (/(回复方向|回复内容|可能的回复|思路|分析用户|判断用户|推测用户|意图|需要换|需要保持|需要确保|需要考虑|需要注意|需要检查|保持.*语气|保持.*风格|保持.*简短|保持.*自然)/.test(content)) continue;

      allMatches.push(content);
    }
  }

  if (allMatches.length === 0) return null;

  // 取最后一个匹配（最接近最终回复的预演）
  const extracted = allMatches[allMatches.length - 1];
  return extracted;
}

/**
 * 尝试通过分隔标记找到实际回复
 */
function trySeparatorBasedFilter(text: string): string {
  if (!startsWithThinking(text)) return text;

  const separators = [
    /\n\s*-{3,}\s*\n/,
    /\n\s*Response\s*[:：]\s*/i,
    /\n\s*Output\s*[:：]\s*/i,
    /\n\s*Answer\s*[:：]\s*/i,
    /\n\s*Final\s+(?:Answer|Response)\s*[:：]\s*/i,
    /\n\s*My\s+(?:response|answer|reply)\s*(?:is|:)\s*/i,
    /\n\s*Here['']?s?\s+(?:my|the)\s+/i,
    /\n\s*(回复|回答|输出)\s*[:：]\s*/,
  ];

  for (const sep of separators) {
    const match = text.match(sep);
    if (match && match.index !== undefined && match.index > 0) {
      return text.slice(match.index + match[0].length).trim();
    }
  }

  return text;
}

/**
 * 流式思考过程过滤器
 *
 * 策略：
 * - 先缓冲前 N 个字符，判断是否为思考过程
 * - 如果是思考过程，持续缓冲，每次新 delta 都尝试过滤
 * - 检测到实际回复开始后，切换到直通模式
 * - 如果不是思考过程，直接切换到直通模式
 */
class ThinkingStreamFilter {
  private buffer = "";
  private mode: "detecting" | "thinking" | "passthrough" = "detecting";
  private lastEmittedLength = 0;
  private readonly detectThreshold = 60;

  processDelta(delta: string): string {
    if (this.mode === "passthrough") {
      return delta;
    }

    this.buffer += delta;

    if (this.mode === "detecting") {
      if (this.buffer.trimStart().length < this.detectThreshold) {
        return "";
      }

      if (startsWithThinking(this.buffer)) {
        this.mode = "thinking";
        logger.debug("llm", "thinking content detected in stream, buffering", {
          preview: this.buffer.slice(0, 80),
        });
      } else {
        // 不是思考过程，切换到直通模式
        this.mode = "passthrough";
        const toEmit = this.buffer;
        this.buffer = "";
        return toEmit;
      }
    }

    // thinking 模式：尝试过滤
    if (this.mode === "thinking") {
      const filtered = stripThinkingContent(this.buffer);

      // 如果过滤后有内容，且不以思考开头，说明思考可能已结束
      if (filtered && !startsWithThinking(filtered) && filtered.length < this.buffer.length) {
        // 防止过早切换：如果过滤后的内容远短于缓冲区（< 1/3），
        // 可能是从思考过程中提取的引号对话，不是真正的回复开始
        // 继续缓冲，等待更多内容或 flush 时再处理
        if (filtered.length >= this.buffer.length / 3) {
          // 检查是否新增加了可发送的内容
          if (filtered.length > this.lastEmittedLength) {
            const toEmit = filtered.slice(this.lastEmittedLength);
            this.lastEmittedLength = filtered.length;

            // 切换到直通模式，后续 delta 直接转发
            this.mode = "passthrough";
            this.buffer = "";

            logger.debug("llm", "thinking content ended, switching to passthrough", {
              toEmitLength: toEmit.length,
            });
            return toEmit;
          }
        }
      }
      // 仍在思考中，不发送
      return "";
    }

    return "";
  }

  flush(): string {
    if (this.mode === "passthrough") {
      return "";
    }

    const filtered = stripThinkingContent(this.buffer);
    const toEmit = filtered.slice(this.lastEmittedLength);

    if (this.mode === "thinking" && toEmit) {
      logger.debug("llm", "flushing filtered content after thinking", {
        originalLength: this.buffer.length,
        filteredLength: filtered.length,
        emitLength: toEmit.length,
      });
    }

    return toEmit;
  }
}

// ── 调试日志 ──────────────────────────────────────────────────

function logRequestMessages(
  model: string,
  messages: ChatCompletionMessageParam[],
  extra?: { temperature?: number; maxTokens?: number; stream?: boolean; extraParams?: Record<string, unknown> }
): void {
  console.log("\n" + "=".repeat(80));
  console.log(
    `📤 [LLM REQUEST] model=${model}${extra?.stream ? " (stream)" : ""} temp=${extra?.temperature ?? 0.8} maxTokens=${extra?.maxTokens ?? 512}`
  );
  if (extra?.extraParams && Object.keys(extra.extraParams).length > 0) {
    console.log(`   extra params: ${JSON.stringify(extra.extraParams)}`);
  }
  console.log("-".repeat(80));
  for (const [i, msg] of messages.entries()) {
    const role = (msg as { role: string }).role;
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    const preview =
      content.length > 500 ? content.slice(0, 500) + "... (truncated)" : content;
    console.log(`  [${i}] ${role.toUpperCase()}: ${preview}`);
  }
  console.log(`  (共 ${messages.length} 条消息)`);
  console.log("=".repeat(80));
}

function logResponseContent(model: string, content: string): void {
  console.log("\n" + "=".repeat(80));
  console.log(`📥 [LLM RESPONSE] model=${model} length=${content.length}`);
  console.log("-".repeat(80));
  console.log(content);
  console.log("=".repeat(80) + "\n");
}

// ── 核心 API ──────────────────────────────────────────────────

async function createClient() {
  const activeModel = await getActiveLlmModelConfig();
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

// ── 重试机制 ──────────────────────────────────────────────────

const MAX_LLM_RETRIES = 3;
const LLM_RETRY_INTERVAL_MS = 10_000;

/** 可重试的错误特征：模型返回空、网络请求失败 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    msg.includes("模型返回为空") ||
    msg.includes("模型返回内容为空") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("Internal Server Error") ||
    msg.includes("Service Unavailable") ||
    msg.includes("Bad Gateway") ||
    msg.includes("Gateway Timeout") ||
    msg.includes("Connection ended")
  );
}

/** 带中断支持的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

/**
 * 调用大模型完成对话（单次，不含重试）。
 * 返回模型回复的文本内容（已过滤思考过程）。
 */
async function chatOnce(params: ChatParams): Promise<string> {
  const { client, activeModel } = await createClient();
  params.onModelResolved?.(activeModel);

  // 构建 Qwen 思考模式关闭参数（多种参数名兼容）
  const extraParams: Record<string, unknown> = {};
  if (activeModel.provider.toLowerCase().includes("qwen")) {
    extraParams.enable_thinking = false;
    extraParams.chat_template_kwargs = { enable_thinking: false };
  }

  logRequestMessages(activeModel.model, params.messages, {
    temperature: params.temperature ?? 0.8,
    maxTokens: params.maxTokens ?? 512,
    extraParams,
  });

  const response = await client.chat.completions.create(
    {
      model: activeModel.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.8,
      max_tokens: params.maxTokens ?? 512,
      ...extraParams,
    } as ChatCompletionCreateParamsNonStreaming,
    { signal: params.signal }
  );

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) {
    logger.warn("llm", "model returned empty content", {
      model: activeModel.model,
    });
    throw new Error("模型返回为空，请检查 API 配置。");
  }

  const content = stripThinkingContent(rawContent);
  if (content !== rawContent) {
    logger.info("llm", "thinking content filtered", {
      model: activeModel.model,
      rawLength: rawContent.length,
      filteredLength: content.length,
    });
  }

  logResponseContent(activeModel.model, content);

  if (!content) {
    logger.warn("llm", "content empty after thinking filter", {
      model: activeModel.model,
      rawLength: rawContent.length,
    });
    throw new Error("模型返回内容为空（可能全部是思考过程），请检查模型配置。");
  }

  return content;
}

/**
 * 调用大模型完成对话（含重试机制）。
 * 遇到空返回或网络错误时自动重试，最多 3 次，间隔 10 秒。
 * 全部失败后返回友好提示。
 */
export async function chat(params: ChatParams): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
    try {
      return await chatOnce(params);
    } catch (error) {
      lastError = error as Error;
      if (params.signal?.aborted) throw error;
      if (!isRetryableError(error)) throw error;

      if (attempt < MAX_LLM_RETRIES) {
        logger.warn("llm", "retrying after retryable error", {
          attempt,
          maxAttempts: MAX_LLM_RETRIES,
          intervalMs: LLM_RETRY_INTERVAL_MS,
          error: lastError.message,
        });
        await sleep(LLM_RETRY_INTERVAL_MS, params.signal);
      }
    }
  }

  logger.error("llm", "all retry attempts exhausted", {
    maxAttempts: MAX_LLM_RETRIES,
    lastError: lastError?.message,
  });
  throw new Error("当前网络有问题，请重新尝试。");
}

/**
 * 流式调用大模型完成对话（单次，不含重试）。
 * 每收到一段 token delta 就调用 onDelta（已过滤思考过程），并返回完整文本。
 */
async function chatStreamOnce(params: ChatStreamParams): Promise<string> {
  const { client, activeModel } = await createClient();
  params.onModelResolved?.(activeModel);

  // 构建 Qwen 思考模式关闭参数（多种参数名兼容）
  const extraParams: Record<string, unknown> = {};
  if (activeModel.provider.toLowerCase().includes("qwen")) {
    extraParams.enable_thinking = false;
    extraParams.chat_template_kwargs = { enable_thinking: false };
  }

  logRequestMessages(activeModel.model, params.messages, {
    temperature: params.temperature ?? 0.8,
    maxTokens: params.maxTokens ?? 512,
    stream: true,
    extraParams,
  });

  const stream = await client.chat.completions.create(
    {
      model: activeModel.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.8,
      max_tokens: params.maxTokens ?? 512,
      stream: true,
      ...extraParams,
    } as ChatCompletionCreateParamsStreaming,
    { signal: params.signal }
  );

  const thinkingFilter = new ThinkingStreamFilter();
  let rawContent = "";
  let filteredContent = "";

  for await (const chunk of stream) {
    params.signal?.throwIfAborted();
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (!delta) {
      continue;
    }

    rawContent += delta;

    const cleanDelta = thinkingFilter.processDelta(delta);
    if (cleanDelta) {
      filteredContent += cleanDelta;
      await params.onDelta(cleanDelta);
    }
  }

  const remaining = thinkingFilter.flush();
  if (remaining) {
    filteredContent += remaining;
    await params.onDelta(remaining);
  }

  if (rawContent && !filteredContent) {
    logger.warn("llm", "stream content empty after thinking filter", {
      model: activeModel.model,
      rawLength: rawContent.length,
    });
    throw new Error("模型返回内容为空（可能全部是思考过程），请检查模型配置。");
  }

  if (!rawContent) {
    logger.warn("llm", "model returned empty content (stream)", {
      model: activeModel.model,
    });
    throw new Error("模型返回为空，请检查 API 配置。");
  }

  if (filteredContent !== rawContent) {
    logger.info("llm", "thinking content filtered (stream)", {
      model: activeModel.model,
      rawLength: rawContent.length,
      filteredLength: filteredContent.length,
    });
  }

  logResponseContent(activeModel.model, filteredContent);

  return filteredContent;
}

/**
 * 流式调用大模型完成对话（含重试机制）。
 *
 * 遇到空返回或网络错误时自动重试，最多 3 次，间隔 10 秒。
 * 仅在尚未向客户端发送任何内容时才重试（避免重复发送）。
 * 全部失败后返回友好提示。
 */
export async function chatStream(params: ChatStreamParams): Promise<string> {
  let contentSent = false;
  let lastError: Error | null = null;

  // 包装 onDelta，跟踪是否已向客户端发送内容
  const wrappedOnDelta = (delta: string) => {
    contentSent = true;
    return params.onDelta(delta);
  };

  for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
    contentSent = false;
    try {
      const result = await chatStreamOnce({ ...params, onDelta: wrappedOnDelta });
      return result;
    } catch (error) {
      lastError = error as Error;
      if (params.signal?.aborted) throw error;
      // 如果已经向客户端发送了内容，不能重试
      if (contentSent) throw error;
      if (!isRetryableError(error)) throw error;

      if (attempt < MAX_LLM_RETRIES) {
        logger.warn("llm", "retrying stream after retryable error", {
          attempt,
          maxAttempts: MAX_LLM_RETRIES,
          intervalMs: LLM_RETRY_INTERVAL_MS,
          error: lastError.message,
        });
        await sleep(LLM_RETRY_INTERVAL_MS, params.signal);
      }
    }
  }

  logger.error("llm", "all stream retry attempts exhausted", {
    maxAttempts: MAX_LLM_RETRIES,
    lastError: lastError?.message,
  });
  throw new Error("当前网络有问题，请重新尝试。");
}

/** 暴露原始 client，供高级用法使用 */
export async function getRawClient(): Promise<OpenAI> {
  return (await createClient()).client;
}
