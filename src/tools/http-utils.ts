/**
 * 共享 HTTP 工具函数
 *
 * 从 web-search.ts 提取，供 web-search 和 weather-skill 共用。
 */

import { fetch, ProxyAgent } from "undici";
import { logger } from "../logger.js";
import { config } from "../config.js";

function getDispatcher(): ProxyAgent | undefined {
  const proxyURL =
    process.env.WEB_SEARCH_PROXY_URL || process.env.LLM_PROXY_URL || "";
  return proxyURL ? new ProxyAgent(proxyURL) : undefined;
}

export async function fetchWithTimeout(
  url: URL | string,
  timeoutMs: number,
  init: Parameters<typeof fetch>[1] = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    return await fetch(url, {
      ...init,
      dispatcher: getDispatcher(),
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.search.retries; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === config.search.retries) throw error;
      logger.warn("web-search", "provider retry", {
        provider: label,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250 * (attempt + 1));
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    }
  }
  throw lastError;
}
