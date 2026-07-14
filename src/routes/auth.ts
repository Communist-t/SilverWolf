import { Hono } from "hono";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  generateVerificationCode,
} from "../utils/password.js";
import { sendVerificationCode } from "../utils/email.js";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_AVATAR_DATA_URL_LENGTH = 48 * 1024;

type UserRole = "user" | "admin" | "super_admin";

interface AuthenticatedUserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string;
  role: UserRole;
  created_at: string;
}

async function getUserByToken(token: string): Promise<AuthenticatedUserRow | null> {
  const result = await pool.query<AuthenticatedUserRow>(
    `SELECT u.id, u.email, u.display_name, u.avatar_url, u.role, u.created_at
     FROM user_tokens t JOIN users u ON t.user_id = u.id
     WHERE t.token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

function serializeUser(row: AuthenticatedUserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    createdAt: row.created_at,
  };
}

export const authRoute = new Hono();

// Send verification code
authRoute.post("/send-code", async (c) => {
  try {
    const { email } = await c.req.json<{ email: string }>();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "请输入有效的邮箱地址" }, 400);
    }

    // Check existing user
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return c.json({ error: "该邮箱已被注册" }, 409);
    }

    // Rate limit: one code per 60 seconds per email
    const recentResult = await pool.query<{ created_at: string }>(
      "SELECT created_at FROM email_verification_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
      [email]
    );
    if (recentResult.rows.length > 0) {
      const elapsed = Date.now() - new Date(recentResult.rows[0].created_at).getTime();
      if (elapsed < 60000) {
        return c.json(
          { error: `请 ${Math.ceil((60000 - elapsed) / 1000)} 秒后再试` },
          429
        );
      }
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const createdAt = new Date().toISOString();

    // Clean up expired codes for this email to avoid accumulation
    await pool.query(
      "DELETE FROM email_verification_codes WHERE email = $1 AND expires_at < $2",
      [email, createdAt]
    );

    await pool.query(
      "INSERT INTO email_verification_codes (email, code, expires_at, created_at) VALUES ($1, $2, $3, $4)",
      [email, code, expiresAt, createdAt]
    );

    await sendVerificationCode(email, code);
    return c.json({ message: "验证码已发送" });
  } catch (err) {
    logger.error("auth", "send-code error", { error: String(err) });
    return c.json({ error: "发送验证码失败" }, 500);
  }
});

// Register
authRoute.post("/register", async (c) => {
  try {
    const { email, code, password, confirmPassword } = await c.req.json<{
      email: string;
      code: string;
      password: string;
      confirmPassword: string;
    }>();

    if (!email || !code || !password) {
      return c.json({ error: "请填写所有必填字段" }, 400);
    }
    if (password.length < 6) {
      return c.json({ error: "密码至少 6 位" }, 400);
    }
    if (password !== confirmPassword) {
      return c.json({ error: "两次密码输入不一致" }, 400);
    }

    // Verify code
    const codeResult = await pool.query<{ code: string; expires_at: string }>(
      "SELECT code, expires_at FROM email_verification_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
      [email]
    );
    if (codeResult.rows.length === 0) {
      return c.json({ error: "请先获取验证码" }, 400);
    }
    const row = codeResult.rows[0];
    if (row.code !== code) {
      return c.json({ error: "验证码错误" }, 400);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.json({ error: "验证码已过期" }, 400);
    }

    // Check duplicate (race condition guard)
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return c.json({ error: "该邮箱已被注册" }, 409);
    }

    // Consume the verification code so it cannot be reused
    await pool.query(
      "DELETE FROM email_verification_codes WHERE email = $1 AND code = $2",
      [email, code]
    );

    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    const createdAt = new Date().toISOString();
    const displayName = email.split("@")[0];

    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ($1, $2, $3, $4, $5)",
      [userId, email, passwordHash, displayName, createdAt]
    );

    // Generate token (replace any existing tokens)
    const token = generateToken();
    await pool.query("DELETE FROM user_tokens WHERE user_id = $1", [userId]);
    await pool.query(
      "INSERT INTO user_tokens (token, user_id, created_at) VALUES ($1, $2, $3)",
      [token, userId, createdAt]
    );

    logger.info("auth", "user registered", { userId, email });
    return c.json({
      token,
      user: {
        id: userId,
        email,
        displayName,
        avatarUrl: "",
        role: "user",
        createdAt,
      },
    });
  } catch (err) {
    logger.error("auth", "register error", { error: String(err) });
    return c.json({ error: "注册失败" }, 500);
  }
});

// Login
authRoute.post("/login", async (c) => {
  try {
    const { account, password } = await c.req.json<{
      account: string;
      password: string;
    }>();

    if (!account || !password) {
      return c.json({ error: "请输入账号和密码" }, 400);
    }

    const result = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
      display_name: string;
      avatar_url: string;
      role: UserRole;
      created_at: string;
    }>(
      "SELECT id, email, password_hash, display_name, avatar_url, role, created_at FROM users WHERE email = $1",
      [account]
    );

    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return c.json({ error: "账号或密码错误" }, 401);
    }

    const token = generateToken();
    const createdAt = new Date().toISOString();
    // Replace any existing tokens for this user
    await pool.query("DELETE FROM user_tokens WHERE user_id = $1", [user.id]);
    await pool.query(
      "INSERT INTO user_tokens (token, user_id, created_at) VALUES ($1, $2, $3)",
      [token, user.id, createdAt]
    );

    logger.info("auth", "user logged in", { userId: user.id });
    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    logger.error("auth", "login error", { error: String(err) });
    return c.json({ error: "登录失败" }, 500);
  }
});

// Get user info
authRoute.get("/user", async (c) => {
  const token = c.req.header("X-User-Token");
  if (!token) {
    return c.json({ error: "未登录" }, 401);
  }
  const row = await getUserByToken(token);

  if (!row) {
    return c.json({ error: "登录已过期" }, 401);
  }

  return c.json({ user: serializeUser(row) });
});

// Update user profile
authRoute.patch("/user", async (c) => {
  const token = c.req.header("X-User-Token");
  if (!token) {
    return c.json({ error: "未登录" }, 401);
  }

  const currentUser = await getUserByToken(token);
  if (!currentUser) {
    return c.json({ error: "登录已过期" }, 401);
  }

  try {
    const payload = await c.req.json<{
      displayName?: unknown;
      avatarUrl?: unknown;
    }>();
    const requestedDisplayName =
      typeof payload.displayName === "string" ? payload.displayName.trim() : "";
    const avatarUrl =
      typeof payload.avatarUrl === "string" ? payload.avatarUrl.trim() : "";
    const administrator = currentUser.role === "admin" || currentUser.role === "super_admin";
    const displayName = administrator
      ? currentUser.display_name
      : requestedDisplayName;

    if (administrator && requestedDisplayName !== currentUser.display_name) {
      return c.json({ error: "管理员用户名不可修改" }, 403);
    }
    if (!administrator && (!displayName || displayName.length > 24)) {
      return c.json({ error: "用户名长度应为 1-24 个字符" }, 400);
    }
    if (!administrator && /[\u0000-\u001f\u007f]/.test(displayName)) {
      return c.json({ error: "用户名包含无效字符" }, 400);
    }
    if (
      avatarUrl &&
      (!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(avatarUrl) ||
        avatarUrl.length > MAX_AVATAR_DATA_URL_LENGTH)
    ) {
      return c.json({ error: "头像格式无效或文件过大" }, 400);
    }

    if (administrator) {
      await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [
        avatarUrl,
        currentUser.id,
      ]);
    } else {
      await pool.query(
        "UPDATE users SET display_name = $1, avatar_url = $2 WHERE id = $3",
        [displayName, avatarUrl, currentUser.id]
      );
    }

    const updatedUser = (await getUserByToken(token))!;
    logger.info("auth", "user profile updated", {
      userId: currentUser.id,
      avatarLength: avatarUrl.length,
    });
    return c.json({ user: serializeUser(updatedUser) });
  } catch (err) {
    logger.error("auth", "update user error", { error: String(err) });
    return c.json({ error: "保存用户资料失败" }, 400);
  }
});

// Logout
authRoute.post("/logout", async (c) => {
  const token = c.req.header("X-User-Token");
  if (token) {
    await pool.query("DELETE FROM user_tokens WHERE token = $1", [token]);
  }
  return c.json({ message: "已退出登录" });
});
