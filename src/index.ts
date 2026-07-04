/**
 * 银狼 Agent 服务入口
 *
 * 启动方式：
 *   npm run dev   # 开发模式
 *   npm start     # 生产模式
 */

import { serve } from "@hono/node-server";
import { config, validateConfig } from "./config.js";
import { logger } from "./logger.js";

async function startServer(): Promise<void> {
  const { closeDatabase } = await import("./db/conversation-store.js");
  let createApp: typeof import("./app.js").createApp;
  let abortAllActiveRequests: typeof import("./routes/chat.js").abortAllActiveRequests;
  try {
    [{ createApp }, { abortAllActiveRequests }] = await Promise.all([
      import("./app.js"),
      import("./routes/chat.js"),
    ]);
  } catch (error) {
    closeDatabase();
    throw error;
  }

  let app: ReturnType<typeof createApp>;
  try {
    app = createApp();
  } catch (error) {
    closeDatabase();
    throw error;
  }

  let startupModel = {
    model: config.llm.model,
    baseURL: config.llm.baseURL,
  };
  try {
    const { getActiveLlmModelConfig } = await import("./llm/model-configs.js");
    const activeModel = getActiveLlmModelConfig();
    startupModel = {
      model: activeModel.model,
      baseURL: activeModel.baseURL,
    };
  } catch (error) {
    logger.warn("startup", "active model not ready", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.log(`\n🐺 银狼 Agent 启动中...`);
  console.log(`   模型: ${startupModel.model}`);
  console.log(`   监听: ${config.server.host}:${config.server.port}`);
  console.log(`   展示页: http://${config.server.host}:${config.server.port}/`);
  console.log(`   对话页: http://${config.server.host}:${config.server.port}/chat`);
  console.log(`   接口: POST http://${config.server.host}:${config.server.port}/chat\n`);
  logger.info("startup", "server configuration", {
    model: startupModel.model,
    baseURL: startupModel.baseURL,
    host: config.server.host,
    port: config.server.port,
    logLevel: config.logging.level,
    authEnabled: Boolean(config.security.authToken),
    llmProxyEnabled: Boolean(config.llm.proxyURL),
    webSearchProvider: process.env.WEB_SEARCH_PROVIDER ?? "auto",
    tavilyEnabled: Boolean(process.env.TAVILY_API_KEY),
    braveEnabled: Boolean(process.env.BRAVE_SEARCH_API_KEY),
    webSearchProxyEnabled: Boolean(
      process.env.WEB_SEARCH_PROXY_URL || config.llm.proxyURL
    ),
  });
  if (
    !["127.0.0.1", "localhost", "::1"].includes(config.server.host) &&
    !config.security.authToken
  ) {
    logger.warn("startup", "service is exposed without application authentication", {
      host: config.server.host,
      hint: "公网或局域网部署请配置 APP_AUTH_TOKEN 和 HTTPS",
    });
  }

  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      fetch: app.fetch,
      hostname: config.server.host,
      port: config.server.port,
    });
  } catch (error) {
    closeDatabase();
    throw error;
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error("startup", "port already in use", {
        port: config.server.port,
        host: config.server.host,
        hint: `请关闭占用进程，或使用 PORT=${config.server.port + 1} npm run dev`,
      });
      closeDatabase();
      process.exitCode = 1;
      return;
    }
    logger.error("startup", "server failed", { error: error.message });
    closeDatabase();
    process.exitCode = 1;
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    const abortedRequests = abortAllActiveRequests();
    logger.info("shutdown", "graceful shutdown started", {
      signal,
      abortedRequests,
    });

    const forceTimer = setTimeout(() => {
      logger.error("shutdown", "graceful shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) {
        logger.error("shutdown", "server close failed", { error: error.message });
        process.exitCode = 1;
      }
      closeDatabase();
      logger.info("shutdown", "graceful shutdown completed");
    });
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  try {
    validateConfig();
  } catch (error) {
    logger.error("startup", "invalid configuration", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  try {
    await startServer();
  } catch (error) {
    logger.error("startup", "server initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

void main();
