/**
 * core/api-client.js — 统一 API 请求层
 * 封装 fetch，自动注入鉴权头、处理错误、统一 baseURL
 */

const API_BASE = window.SILVER_WOLF_CONFIG?.apiBase ?? "";
const FRONTEND_BASE = window.SILVER_WOLF_CONFIG?.frontendBase ?? "";
const AUTH_TOKEN_KEY = "silver-wolf-auth-token";
const USER_TOKEN_KEY = "silver-wolf-user-token";

/**
 * 获取当前鉴权 token
 * 优先从 sessionStorage 读取（当前会话），回退到 localStorage（登录页持久化）。
 * 登录页将 token 同时写入两处，但 sessionStorage 在关闭标签页后会丢失，
 * 因此返回用户必须从 localStorage 恢复，否则会被误判为未登录。
 */
function getAuthToken() {
  return (
    sessionStorage.getItem(AUTH_TOKEN_KEY) ||
    localStorage.getItem(USER_TOKEN_KEY) ||
    ""
  );
}

/**
 * 统一 API 请求
 * @param {string} resource - URL 路径（以 / 开头则拼接 API_BASE）
 * @param {object} options - fetch 选项
 * @returns {Promise<Response>}
 */
export async function apiFetch(resource, options = {}) {
  const headers = new Headers(options.headers);

  // 自动注入鉴权头（Authorization 用于应用级鉴权，X-User-Token 用于用户级鉴权）
  const token = getAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-User-Token", token);
  }

  // 默认 Content-Type（仅 JSON 字符串自动设置，FormData 等由浏览器处理）
  if (!headers.has("Content-Type") && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  const url = resource.startsWith("/") ? API_BASE + resource : resource;

  const response = await fetch(url, {
    ...options,
    headers,
    signal: options.signal,
  });

  if (!response.ok) {
    // 401：token 失效。非认证类接口统一跳转登录页，避免应用静默 401 假死。
    if (
      response.status === 401 &&
      !resource.startsWith("/auth") &&
      !window.__authRedirecting
    ) {
      try {
        const current = window.location.pathname + window.location.search;
        if (!current.startsWith("/login")) {
          window.__authRedirecting = true;
          window.location.href = "/login?next=" + encodeURIComponent(current);
        }
      } catch { /* ignore */ }
    }
    const payload = await response.clone().json().catch(() => ({}));
    const message = payload.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return response;
}

/**
 * GET 快捷方法
 */
export async function apiGet(path, init = {}) {
  return apiFetch(path, { ...init, method: "GET" });
}

/**
 * POST 快捷方法
 */
export async function apiPost(path, body, init = {}) {
  return apiFetch(path, {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * DELETE 快捷方法
 */
export async function apiDelete(path, init = {}) {
  return apiFetch(path, { ...init, method: "DELETE" });
}

/**
 * PATCH 快捷方法
 */
export async function apiPatch(path, body, init = {}) {
  return apiFetch(path, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export { API_BASE, FRONTEND_BASE };
