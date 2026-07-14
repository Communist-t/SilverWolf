import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { chatRoute } from "./routes/chat.js";
import { historyRoute } from "./routes/history.js";
import { authRoute } from "./routes/auth.js";
import { memoryRoute } from "./routes/memory.js";
import { settingsRoute } from "./routes/settings.js";
import { getConversationCacheStats } from "./agent/chat-agent.js";
import { getSearchCacheStats } from "./tools/web-search.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { isBearerTokenValid } from "./utils/auth.js";

export function createApp(options: { authToken?: string } = {}): Hono {
  const app = new Hono();
  const authToken = options.authToken ?? config.security.authToken;

  // CORS — 允许前端独立部署后跨域访问 API
  app.use(
    "*",
    cors({
      origin: (origin) => {
        // 允许所有来源（开发阶段），生产环境可通过 FRONTEND_ORIGIN 环境变量限制
        const allowed = process.env.FRONTEND_ORIGIN;
        if (allowed && allowed !== "*") {
          return origin && allowed.split(",").includes(origin) ? origin : null;
        }
        return origin ?? "*";
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-User-Token"],
      exposeHeaders: ["X-Silver-Wolf-Agent"],
      credentials: true,
      maxAge: 86400,
    })
  );

  app.use(
    "*",
    bodyLimit({
      maxSize: 16 * 1024 * 1024,
      onError: (c) => c.json({ error: "请求体过大，最多 16MB" }, 413),
    })
  );

  app.use("*", async (c, next) => {
    if (
      c.req.path === "/health" ||
      c.req.path === "/auth/status" ||
      c.req.path.startsWith("/chat") ||
      c.req.path.startsWith("/history") ||
      c.req.path.startsWith("/memory") ||
      c.req.path.startsWith("/settings")
    ) {
      c.header("Cache-Control", "no-store");
    }
    await next();
    c.header("X-Silver-Wolf-Agent", "1");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  app.get("/auth/status", (c) => {
    const required = Boolean(authToken);
    return c.json({
      required,
      authenticated:
        !required ||
        isBearerTokenValid(
          c.req.header("Authorization"),
          authToken
        ),
    });
  });

  app.use("*", async (c, next) => {
    const protectsChatApi =
      c.req.path.startsWith("/chat") && c.req.method !== "GET";
    const protectedRoute =
      protectsChatApi ||
      c.req.path.startsWith("/history") ||
      c.req.path.startsWith("/memory") ||
      c.req.path.startsWith("/settings");
    if (
      protectedRoute &&
      authToken &&
      !isBearerTokenValid(
        c.req.header("Authorization"),
        authToken
      )
    ) {
      c.header("WWW-Authenticate", 'Bearer realm="silver-wolf-agent"');
      return c.json({ error: "需要有效的访问令牌" }, 401);
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      character: "Silver Wolf",
      service: "silver-wolf-agent",
      caches: {
        conversations: getConversationCacheStats(),
        search: getSearchCacheStats(),
      },
    })
  );
  app.route("/chat", chatRoute);
  app.route("/history", historyRoute);
  app.route("/auth", authRoute);
  app.route("/memory", memoryRoute);
  app.route("/settings", settingsRoute);
  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  app.onError((err, c) => {
    logger.error("server", "unhandled request error", {
      method: c.req.method,
      path: c.req.path,
      error: err.message,
    });
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
