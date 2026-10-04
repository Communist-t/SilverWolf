import "dotenv/config";
import { boundedInteger } from "./utils/numbers.js";
import { collectConfigErrors } from "./utils/config-validation.js";

export const config = {
  llm: {
    // 模型配置（provider/base_url/model/api_key）统一存于数据库 llm_model_configs，
    // 不再从 .env 读取。proxyURL 为可选代理，仍由环境变量控制。
    proxyURL: process.env.LLM_PROXY_URL ?? "",
  },
  server: {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: boundedInteger(process.env.PORT, 3000, 1, 65535),
    requestTimeoutMs: boundedInteger(process.env.REQUEST_TIMEOUT_MS, 90000, 5000, 300000),
  },
  search: {
    timeoutMs: boundedInteger(process.env.WEB_SEARCH_TIMEOUT_MS, 20000, 1000, 60000),
    retries: boundedInteger(process.env.WEB_SEARCH_RETRIES, 2, 0, 5),
    cacheTtlMs: boundedInteger(process.env.WEB_SEARCH_CACHE_TTL_MS, 300000, 0, 3600000),
  },
  logging: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  security: {
    authToken: process.env.APP_AUTH_TOKEN?.trim() ?? "",
  },
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: boundedInteger(process.env.SMTP_PORT, 587, 1, 65535),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "",
  },
} as const;

/** 启动时校验必须的环境变量 */
export function validateConfig(): void {
  const errors = collectConfigErrors(process.env);
  if (errors.length > 0) {
    throw new Error(`${errors.join("；")}。请检查 .env 文件。`);
  }
}
