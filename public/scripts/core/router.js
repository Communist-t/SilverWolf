/**
 * core/router.js — 页面/视图路由
 * 管理 SPA 内的视图切换（聊天页、登录页、展示页等）
 * 基于 hash 路由，无需后端配合
 */

import { emit, EventNames } from "./events.js";

const ROUTES = {
  HOME: "/",
  CHAT: "/chat",
  LOGIN: "/login",
};

let currentView = "home"; // home | chat | login
let viewHistory = ["home"];

/**
 * 获取当前视图
 */
export function getCurrentView() {
  return currentView;
}

/**
 * 导航到指定视图
 */
export function navigate(view, pushState = true) {
  if (view === currentView) return;

  if (pushState) {
    viewHistory.push(view);
    history.pushState({ view }, "", `#${view}`);
  }

  const prevView = currentView;
  currentView = view;

  emit(EventNames.NAVIGATION_CHANGE, { from: prevView, to: view });
}

/**
 * 后退导航
 */
export function goBack() {
  if (viewHistory.length <= 1) return;
  viewHistory.pop();
  const prevView = currentView;
  currentView = viewHistory[viewHistory.length - 1];
  history.back();
  emit(EventNames.NAVIGATION_CHANGE, { from: prevView, to: currentView });
}

/**
 * 前进导航
 */
export function goForward() {
  if (viewHistory.length <= 1) return;
  viewHistory.pop();
  const prevView = currentView;
  currentView = viewHistory[viewHistory.length - 1];
  history.forward();
  emit(EventNames.NAVIGATION_CHANGE, { from: prevView, to: currentView });
}

/**
 * 初始化路由监听
 */
export function initRouter() {
  window.addEventListener("popstate", () => {
    const hash = location.hash.replace("#", "") || "home";
    if (hash !== currentView) {
      const prevView = currentView;
      currentView = hash;
      viewHistory = [hash];
      emit(EventNames.NAVIGATION_CHANGE, { from: prevView, to: currentView });
    }
  });

  // 初始路由
  const initialHash = location.hash.replace("#", "") || "home";
  currentView = initialHash;
  viewHistory = [initialHash];
}

/**
 * 检查是否为某个路由
 */
export function isRoute(route) {
  return currentView === route;
}

/**
 * 获取路由常量
 */
export { ROUTES };
