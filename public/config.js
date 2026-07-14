/**
 * Silver Wolf Agent — 前端配置文件
 *
 * 前后端分离后，前端需要知道后端 API 的地址。
 * 在开发环境下，API_BASE 为空（同源访问）。
 * 在生产环境下，可以通过修改此文件或注入环境变量来配置。
 */
window.SILVER_WOLF_CONFIG = {
  // 后端 API 地址（为空则同源访问）
  // 本地开发：前端 8080，后端 3000，需指定后端地址
  apiBase: window.__SILVER_WOLF_API_BASE__ ?? "http://192.168.31.143:3000",
  // 前端页面基址（为空则同源访问）
  frontendBase: window.__SILVER_WOLF_FRONTEND_BASE__ ?? "",
};
