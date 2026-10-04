import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
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
      exposeHeaders: ["X-Silver-Wolf-Agent", "Content-Disposition"],
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
    // 跳过认证相关路由
    if (c.req.path.startsWith("/auth")) {
      return await next();
    }
    
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

  // 技能生成文件的下载端点 —— 产物统一落在 data/generated/，供前端下载
  app.get("/files/:name", (c) => {
    const name = c.req.param("name");
    if (!name || name !== decodeURIComponent(name) || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      return c.json({ error: "文件名不合法" }, 400);
    }
    try {
      const filePath = `./data/generated/${name}`;
      const content = readFileSync(filePath);
      return new Response(content, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    } catch {
      return c.json({ error: "文件不存在或已删除" }, 404);
    }
  });

  // 页面路由 —— 后端直接提供各前端页面（clean URL）
  // 必须放在 API 路由之后、serveStatic 之前，避免被静态回退误判。
  const servePage = (file: string) => (c: any) => {
    try {
      return c.html(readFileSync(`./public/${file}`, "utf-8"));
    } catch {
      return c.json({ error: "Not Found" }, 404);
    }
  };
  app.get("/", (c) => c.redirect("/landing", 302));
  app.get("/landing", servePage("landing.html"));
  app.get("/login", servePage("login.html"));
  app.get("/chat", servePage("index.html"));

  // 静态文件服务 —— 让后端也能直接提供前端页面
  // 注意：必须放在 API 路由之后、notFound 之前
  // 静态资源禁用缓存：确保前端代码改动后浏览器刷新必定拉取最新版本
  app.use("/*", async (c, next) => {
    await next();
    const path = c.req.path;
    if (
      path.startsWith("/scripts") ||
      path.startsWith("/styles") ||
      path.startsWith("/assets")
    ) {
      c.header("Cache-Control", "no-store");
    }
  });
  app.use("/*", serveStatic({ root: "./public" }));

  app.notFound((c) => {
    // 对于非 API 请求，回退到对话页 index.html（支持前端路由）
    const path = c.req.path;
    const isApiPath =
      path.startsWith("/api") ||
      path.startsWith("/chat") ||
      path.startsWith("/history") ||
      path.startsWith("/auth") ||
      path.startsWith("/memory") ||
      path.startsWith("/settings") ||
      path.startsWith("/health");
    if (!isApiPath) {
      try {
        return c.html(readFileSync("./public/index.html", "utf-8"));
      } catch {
        // fallthrough
      }
    }
    return c.json({ error: "Not Found" }, 404);
  });
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
