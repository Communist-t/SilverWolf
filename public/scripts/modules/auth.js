/**
 * modules/auth.js — 认证模块
 * 登录、注册、验证码、用户资料、登出
 */

import { apiFetch, apiPost } from "../core/api-client.js";
import {
  getState, setState, persistUserToken, persistUserInfo, clearUserAuth,
} from "../core/store.js";
import { emit, EventNames } from "../core/events.js";
import { showToast, showActionError, openActionDialog } from "../ui/dialogs.js";

const AUTH_TOKEN_KEY = "silver-wolf-auth-token";
const USER_TOKEN_KEY = "silver-wolf-user-token";
const USER_INFO_KEY = "silver-wolf-user-info";

// ─── 用户信息 UI ─────────────────────────────────────────

export function updateUserInfoUI(info) {
  const userInfoArea = document.getElementById("userInfoArea");
  const userLoggedIn = document.getElementById("userLoggedIn");
  const userAvatar = document.getElementById("userAvatar");
  const userDisplayName = document.getElementById("userDisplayName");
  const userEmail = document.getElementById("userEmail");
  const loginPromptBtn = document.getElementById("loginPromptBtn");

  if (!info) {
    if (userLoggedIn) userLoggedIn.hidden = true;
    if (loginPromptBtn) loginPromptBtn.hidden = false;
    return;
  }

  if (userInfoArea) userInfoArea.hidden = false;
  if (userLoggedIn) userLoggedIn.hidden = false;
  if (loginPromptBtn) loginPromptBtn.hidden = true;

  const displayName = info.displayName || info.email?.split("@")[0] || "用户";
  const administrator = info.role === "admin" || info.role === "super_admin";

  if (userDisplayName) userDisplayName.textContent = displayName;
  if (userEmail) userEmail.textContent = info.email || "";

  // 管理员徽章
  if (administrator) {
    const badge = document.createElement("span");
    badge.className = "admin-badge";
    badge.textContent = "管理员";
    if (userDisplayName) userDisplayName.parentNode.appendChild(badge);
  }

  // 头像
  if (userAvatar) {
    const avatarUrl = info.avatarUrl || "/assets/silver-wolf-avatar.png?v=1";
    userAvatar.src = avatarUrl;
    userAvatar.alt = displayName;
    document.documentElement.style.setProperty("--user-avatar-image", `url("${avatarUrl}")`);
  }
}

// ─── 用户认证检查 ────────────────────────────────────────

export async function checkUserAuth() {
  // 无 token 时直接判定未登录，避免向 /auth/user 发起注定 401 的请求（消除控制台噪音）
  const token =
    sessionStorage.getItem(AUTH_TOKEN_KEY) ||
    localStorage.getItem(USER_TOKEN_KEY) ||
    "";

  if (token) {
    try {
      const res = await apiFetch("/auth/user", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const user = data.user || data;
        persistUserInfo(user);
        updateUserInfoUI(user);
        emit(EventNames.AUTH_LOGIN_SUCCESS, user);
        return true;
      }
    } catch {
      // token 已失效（401 等）：清除无效 token，按未登录处理，由上层跳转登录页
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(USER_TOKEN_KEY);
    }
  }

  updateUserInfoUI(null);
  return false;
}

// ─── 登录/注册 ──────────────────────────────────────────

export async function handleAuthSubmit(event) {
  event.preventDefault();

  const authMode = getState("authMode");
  const authAccount = document.getElementById("authAccount");
  const authPassword = document.getElementById("authPassword");
  const authEmail = document.getElementById("authEmail");
  const authCode = document.getElementById("authCode");
  const authRegPassword = document.getElementById("authRegPassword");
  const authConfirmPassword = document.getElementById("authConfirmPassword");
  const authError = document.getElementById("authError");

  if (!authError) return;
  authError.textContent = "";

  try {
    if (authMode === "login") {
      const response = await apiPost("/auth/login", {
        account: authAccount?.value?.trim(),
        password: authPassword?.value,
      });
      const data = await response.json();
      if (data.token) {
        sessionStorage.setItem(AUTH_TOKEN_KEY, data.token);
        persistUserToken(data.token);
        if (data.user) persistUserInfo(data.user);
        showToast("登录成功");
        emit(EventNames.AUTH_LOGIN_SUCCESS, data);
        location.reload();
      }
    } else {
      const response = await apiPost("/auth/register", {
        email: authEmail?.value?.trim(),
        code: authCode?.value?.trim(),
        password: authRegPassword?.value,
        confirmPassword: authConfirmPassword?.value,
      });
      const data = await response.json();
      if (data.token) {
        sessionStorage.setItem(AUTH_TOKEN_KEY, data.token);
        persistUserToken(data.token);
        if (data.user) persistUserInfo(data.user);
        showToast("注册成功");
        emit(EventNames.AUTH_LOGIN_SUCCESS, data);
        location.reload();
      }
    }
  } catch (e) {
    authError.textContent = e instanceof Error ? e.message : "操作失败";
  }
}

// ─── 验证码 ──────────────────────────────────────────────

let sendCodeCountdown = 0;
let sendCodeTimer = null;

export async function sendVerificationCode() {
  const emailInput = document.getElementById("authEmail");
  if (!emailInput) return;

  const email = emailInput.value.trim();
  if (!email || !email.includes("@")) {
    showToast("请输入有效邮箱");
    return;
  }

  try {
    const response = await apiPost("/auth/send-code", { email });
    const data = await response.json();
    if (data.success) {
      showToast("验证码已发送");
      startSendCodeCountdown(60);
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : "发送失败");
  }
}

function startSendCodeCountdown(seconds) {
  sendCodeCountdown = seconds;
  const btn = document.getElementById("sendCodeBtn");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = `${sendCodeCountdown}s`;

  sendCodeTimer = setInterval(() => {
    sendCodeCountdown--;
    if (sendCodeCountdown <= 0) {
      clearInterval(sendCodeTimer);
      btn.disabled = false;
      btn.textContent = "发送验证码";
    } else {
      btn.textContent = `${sendCodeCountdown}s`;
    }
  }, 1000);
}

// ─── 登出 ────────────────────────────────────────────────

export async function logout() {
  try {
    await apiPost("/auth/logout", {});
  } catch { /* ignore */ }

  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  clearUserAuth();
  emit(EventNames.AUTH_LOGOUT);
  location.reload();
}

// ─── 用户资料更新 ────────────────────────────────────────

export async function updateProfile(displayName, avatarFile) {
  try {
    const payload = { displayName };
    if (avatarFile) {
      // 压缩头像并转 base64 data URL
      const compressed = await compressAvatar(avatarFile);
      payload.avatarUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(compressed);
      });
    }

    const response = await apiFetch("/auth/user", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    const user = data.user || data;
    persistUserInfo(user);
    updateUserInfoUI(user);
    showToast("资料已更新");
  } catch (e) {
    showToast(e instanceof Error ? e.message : "更新失败");
  }
}

async function compressAvatar(file, maxSize = 200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext("2d");
      const size = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - size) / 2, (img.naturalHeight - size) / 2, size, size, 0, 0, maxSize, maxSize);
      canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.8);
    };
    img.src = URL.createObjectURL(file);
  });
}

// ─── 主题切换 ────────────────────────────────────────────

export function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  setState("theme", theme);
  emit(EventNames.THEME_CHANGE, theme);
}

export function initTheme() {
  const savedTheme = localStorage.getItem("silver-wolf-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = savedTheme ?? (prefersDark ? "dark" : "light");
  applyTheme(theme);
}
