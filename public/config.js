/**
 * Silver Wolf Agent — 前端配置文件
 *
 * 前后端分离后，前端需要知道后端 API 的地址。
 * 在开发环境下，API_BASE 为空（同源访问）。
 * 在生产环境下，可以通过修改此文件或注入环境变量来配置。
 */
(function () {
  'use strict';

  // 检测是否为本地开发环境
  function isLocalDev() {
    const hostname = window.location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  }

  // 检测当前协议
  function getProtocol() {
    return window.location.protocol === 'https:' ? 'https:' : 'http:';
  }

  // 自动推断 API 地址
  function inferApiBase() {
    // 1. 环境变量注入优先级最高
    if (typeof window.__SILVER_WOLF_API_BASE__ !== 'undefined' && window.__SILVER_WOLF_API_BASE__) {
      return window.__SILVER_WOLF_API_BASE__;
    }

    // 2. 默认同源访问。
    //    后端（Hono）同时提供 API 与前端静态资源，因此前端与 API 始终同源，
    //    使用空字符串可避免 localhost 与 127.0.0.1 之间的跨域及协议不一致问题。
    //    如需前后端分离部署，请通过 window.__SILVER_WOLF_API_BASE__ 显式注入。
    return '';
  }

  // 自动推断前端基址
  function inferFrontendBase() {
    if (typeof window.__SILVER_WOLF_FRONTEND_BASE__ !== 'undefined' && window.__SILVER_WOLF_FRONTEND_BASE__) {
      return window.__SILVER_WOLF_FRONTEND_BASE__;
    }
    return '';
  }

  window.SILVER_WOLF_CONFIG = {
    // 后端 API 地址（在开发环境中指向本地3000端口）
    apiBase: "http://127.0.0.1:3000",
    // 前端页面基址（为空则同源访问）
    frontendBase: inferFrontendBase(),
    // 配置元信息（调试用）
    _meta: {
      detectedProtocol: getProtocol(),
      detectedHostname: window.location.hostname,
      isLocalDev: isLocalDev(),
    },
  };

  // 开发环境打印配置信息
  if (isLocalDev()) {
    console.log('[SilverWolf] Config loaded:', window.SILVER_WOLF_CONFIG);
  }
})();
