/**
 * main.js — 应用入口
 * 初始化 Store、Router、事件总线，绑定所有模块
 */

import { initializeStore, getState, setState, persistSessionId, persistTheme, setShowProcess, setAllSelected } from "./core/store.js";
import { initRouter, getCurrentView } from "./core/router.js";
import { on, emit, EventNames } from "./core/events.js";
import { apiFetch } from "./core/api-client.js";
import {
  renderSessions, initializeSessions, createSession, switchSession,
  renameCurrentSession, deleteSession, deleteSelected, exportCurrentChat,
  refreshSessions, updateBatchControls, updateContextUsage,
  openExportMenu, closeExportMenu,
} from "./modules/session-manager.js";
import { sendMessage, retryLastMessage } from "./modules/chat-stream.js";
import { appendMessage, renderEmptyChat, appendProcess, appendSource } from "./modules/chat-ui.js";
import {
  checkUserAuth, updateUserInfoUI, initTheme, applyTheme, logout, handleAuthSubmit,
  sendVerificationCode, updateProfile,
} from "./modules/auth.js";
import {
  loadModelSettings, renderModelConfigs, openModelSettingsDialog,
  closeModelSettingsDialog, saveModelConfig, testModelConfig,
  updateModelEditState, updateActiveModelUI, deleteModelConfig,
} from "./modules/model-settings.js";
import { openWorkspacePanel, closeWorkspacePanelDialog, loadMemoryLibrary, loadSkillsLibrary } from "./modules/workspace.js";
import { initFileUpload } from "./modules/file-upload.js";
import { bindDialogElements, showToast, showActionError, showInitializationError } from "./ui/dialogs.js";

// ─── 导航切换 ────────────────────────────────────────────

function setActiveNavigation(activeButton) {
  const buttons = [
    document.getElementById("conversationNav"),
    document.getElementById("memoryLibraryNav"),
    document.getElementById("skillLibraryNav"),
    document.getElementById("analyticsNav"),
    document.getElementById("modelSettingsNav"),
  ];

  for (const button of buttons) {
    if (button) button.classList.remove("active");
  }

  if (activeButton) activeButton.classList.add("active");

  // 更新导航标签
  const labels = {
    conversationNav: "对话",
    memoryLibraryNav: "记忆",
    skillLibraryNav: "技能",
    analyticsNav: "分析",
    modelSettingsNav: "模型",
  };

  for (const [navId, labelText] of Object.entries(labels)) {
    const labelEl = document.getElementById(`${navId}Label`);
    if (labelEl) labelEl.textContent = labelText;
  }
}

// ─── 侧边栏 ──────────────────────────────────────────────

function setSessionPanelOpen(open) {
  // CSS 翻转机制依赖 .left-workspace.sessions-open（sidebar-rotator 旋转 180°）
  const leftWorkspace = document.querySelector(".left-workspace");
  const sessionSidebar = document.querySelector(".session-sidebar");

  if (leftWorkspace) leftWorkspace.classList.toggle("sessions-open", open);
  if (sessionSidebar) {
    if (open) {
      sessionSidebar.removeAttribute("inert");
      sessionSidebar.setAttribute("aria-hidden", "false");
    } else {
      sessionSidebar.setAttribute("inert", "");
      sessionSidebar.setAttribute("aria-hidden", "true");
    }
  }
}

// ─── 初始化 ──────────────────────────────────────────────

async function verifyBackend() {
  try {
    const response = await apiFetch("/health", { cache: "no-store" });
    const health = await response.json();
    const isSilverWolf = health.character === "Silver Wolf";
    return isSilverWolf;
  } catch {
    return false;
  }
}

async function initializeApp() {
  try {
    // 1. 初始化 Store
    await initializeStore();

    // 2. 初始化主题
    initTheme();
    applyTheme(getState("theme"));

    // 3. 初始化路由
    initRouter();

    // 4. 绑定对话框元素
    bindDialogElements();

    // 5. 验证后端
    const backendOk = await verifyBackend();
    if (!backendOk) {
      console.warn("main: 后端连接异常");
    }

    // 6. 检查用户认证
    const isAuthenticated = await checkUserAuth();
    if (!isAuthenticated) {
      // 如果当前不是登录页面，跳转到登录页并携带next参数
      if (!window.location.pathname.startsWith("/login")) {
        const currentPath = window.location.pathname + window.location.search;
        window.location.href = "/login?next=" + encodeURIComponent(currentPath);
        return;
      }
    }

    // 7. 初始化会话（必须先绑定事件监听，否则初始化期发出的 SESSION_MESSAGES_LOADED 会丢失）
    bindEventListeners();
    await initializeSessions();

    // 8. 加载模型设置
    await loadModelSettings();

    // 9. 预加载导航标签数据（记忆/技能，失败不阻塞）
    loadMemoryLibrary().catch(() => {});
    loadSkillsLibrary().catch(() => {});

    // 10. 渲染会话列表
    renderSessions();
    updateContextUsage();

    // 11. 初始化文件上传
    initFileUpload();

    // 12. 绑定全局事件
    bindGlobalEvents();

    console.log("main: 应用初始化完成");
  } catch (e) {
    showInitializationError(e);
    console.error("main: 初始化失败", e);
  }
}

// ─── 全局事件绑定 ────────────────────────────────────────

function bindGlobalEvents() {
  // 发送消息
  const form = document.getElementById("form");
  const input = document.getElementById("input");
  const sendButton = document.getElementById("send");
  const stopButton = document.getElementById("stop");

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const message = input?.value?.trim();
      if (!message) return;

      try {
        await sendMessage(message);
      } catch (e) {
        showActionError(e);
      }
    });
  }

  if (sendButton) {
    sendButton.addEventListener("click", async () => {
      const message = input?.value?.trim();
      if (!message) return;
      try {
        await sendMessage(message);
      } catch (e) {
        showActionError(e);
      }
    });
  }

  if (stopButton) {
    stopButton.addEventListener("click", () => {
      const { controller } = getState("activeRequest") || {};
      controller?.abort();
    });
  }

  // 回车发送（Shift+Enter 换行）
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form?.requestSubmit();
      }
    });
  }

  // 新建会话
  const newSessionButton = document.getElementById("newSession");
  if (newSessionButton) {
    newSessionButton.addEventListener("click", async () => {
      const id = await createSession();
      if (id) {
        persistSessionId(id);
        renderSessions();
      }
    });
  }

  // 重命名
  const renameSessionButton = document.getElementById("renameSession");
  if (renameSessionButton) {
    renameSessionButton.addEventListener("click", renameCurrentSession);
  }

  // 清空聊天
  const clearChat = document.getElementById("clearChat");
  if (clearChat) {
    clearChat.addEventListener("click", () => {
      const chat = document.getElementById("chat");
      if (chat) {
        chat.innerHTML = "";
        renderEmptyChat();
      }
    });
  }

  // 导出（点击弹出格式菜单：Markdown / JSON）
  const exportChatButton = document.getElementById("exportChat");
  const storageExportButton = document.getElementById("storageExport");
  const openExportAt = (anchor, e) => {
    if (e) e.stopPropagation();
    const rect = anchor.getBoundingClientRect();
    openExportMenu(rect.right - 4, rect.bottom + 6);
  };
  if (exportChatButton) {
    exportChatButton.addEventListener("click", (e) => openExportAt(exportChatButton, e));
  }
  if (storageExportButton) {
    storageExportButton.addEventListener("click", (e) => openExportAt(storageExportButton, e));
  }

  // 侧边栏切换
  const toggleSidebar = document.getElementById("toggleSidebar");
  if (toggleSidebar) {
    toggleSidebar.addEventListener("click", () => {
      const leftWorkspace = document.querySelector(".left-workspace");
      const isOpen = leftWorkspace && leftWorkspace.classList.contains("sessions-open");
      setSessionPanelOpen(!isOpen);
    });
  }

  // 查看过程切换（默认隐藏过程区，点击后显示）
  const toggleProcessBtn = document.getElementById("toggleProcess");
  if (toggleProcessBtn) {
    const applyProcessVisibility = (show) => {
      const chat = document.getElementById("chat");
      if (chat) chat.classList.toggle("show-process", show);
      toggleProcessBtn.setAttribute("aria-pressed", String(show));
    };
    // 初始同步
    applyProcessVisibility(getState("showProcess"));
    toggleProcessBtn.addEventListener("click", () => {
      const next = !getState("showProcess");
      setShowProcess(next);
      applyProcessVisibility(next);
    });
  }

  // ─── 关闭所有面板 ──────────────────────────────
  function closeAllPanels() {
    const workspacePanel = document.getElementById("workspacePanelDialog");
    const modelSettings = document.getElementById("modelSettingsDialog");
    const profileDialog = document.getElementById("profileDialog");
    if (workspacePanel) workspacePanel.hidden = true;
    if (modelSettings) modelSettings.hidden = true;
    if (profileDialog) profileDialog.hidden = true;
  }

  // ─── 填充用户资料弹窗 ────────────────────────────
  function populateProfileDialog() {
    const userInfo = getState("userInfo");
    if (!userInfo) return;

    const avatarImg = document.getElementById("profileDialogAvatar");
    const displayNameInput = document.getElementById("profileDisplayName");
    const accountEl = document.getElementById("profileDialogAccount");
    const roleEl = document.getElementById("profileDialogRole");
    const createdAtEl = document.getElementById("profileDialogCreatedAt");

    if (avatarImg) avatarImg.src = userInfo.avatarUrl || "/assets/silver-wolf-avatar.png?v=1";
    if (displayNameInput) displayNameInput.value = userInfo.displayName || "";
    if (accountEl) accountEl.textContent = userInfo.email || "-";
    if (roleEl) roleEl.textContent = userInfo.role === "admin" || userInfo.role === "super_admin" ? "管理员" : "普通用户";
    if (createdAtEl) {
      const created = userInfo.createdAt || userInfo.created_at;
      createdAtEl.textContent = created ? new Date(created).toLocaleString("zh-CN") : "-";
    }
  }

  // 导航按钮
  const navButtons = {
    conversationNav: () => {
      setActiveNavigation(document.getElementById("conversationNav"));
      closeAllPanels();
      // 展开会话侧边栏
      setSessionPanelOpen(true);
    },
    memoryLibraryNav: () => {
      closeAllPanels();
      setActiveNavigation(document.getElementById("memoryLibraryNav"));
      openWorkspacePanel("memory");
    },
    skillLibraryNav: () => {
      closeAllPanels();
      setActiveNavigation(document.getElementById("skillLibraryNav"));
      openWorkspacePanel("skills");
    },
    analyticsNav: () => {
      closeAllPanels();
      setActiveNavigation(document.getElementById("analyticsNav"));
      openWorkspacePanel("analytics");
    },
    modelSettingsNav: () => {
      closeAllPanels();
      setActiveNavigation(document.getElementById("modelSettingsNav"));
      openModelSettingsDialog();
    },
  };

  for (const [navId, handler] of Object.entries(navButtons)) {
    const btn = document.getElementById(navId);
    if (btn) btn.addEventListener("click", handler);
  }

  // 批量操作：全选对话复选框（勾选=进入批量模式并全选，取消=退出批量模式）
  const selectAllSessions = document.getElementById("selectAllSessions");
  if (selectAllSessions) {
    selectAllSessions.addEventListener("change", (e) => {
      setAllSelected(e.target.checked);
      renderSessions();
    });
  }

  const deleteSelectedBtn = document.getElementById("deleteSelectedSessions");
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener("click", deleteSelected);
  }
  const themeToggle = document.getElementById("themeToggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = getState("theme");
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      showToast(`已切换到${next === "dark" ? "深色" : "浅色"}模式`);
    });
  }

  // 登出
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", logout);
  }

  // 用户头像点击 → 弹出资料面板
  const userInfoArea = document.getElementById("userInfoArea");
  if (userInfoArea) {
    userInfoArea.addEventListener("click", () => {
      const profileDialog = document.getElementById("profileDialog");
      if (profileDialog) {
        populateProfileDialog();
        profileDialog.hidden = false;
      }
    });
  }

  // 登录弹窗打开
  const loginPromptBtn = document.getElementById("loginPromptBtn");
  if (loginPromptBtn) {
    loginPromptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const authDialog = document.getElementById("authDialog");
      if (authDialog) authDialog.showModal();
    });
  }

  // 登录弹窗关闭
  const authDialogClose = document.getElementById("authDialogClose");
  if (authDialogClose) {
    authDialogClose.addEventListener("click", () => {
      const authDialog = document.getElementById("authDialog");
      if (authDialog) authDialog.close();
    });
  }

  // 登录/注册切换
  const authToggleMode = document.getElementById("authToggleMode");
  if (authToggleMode) {
    authToggleMode.addEventListener("click", () => {
      const current = getState("authMode");
      setState("authMode", current === "login" ? "register" : "login");
      // 切换 UI 可见性
      const loginFields = document.getElementById("loginFields");
      const registerFields = document.getElementById("registerFields");
      const authTitle = document.getElementById("authTitle");
      const authSubtitle = document.getElementById("authSubtitle");
      const authModeText = document.getElementById("authModeText");

      if (loginFields) loginFields.hidden = current !== "login";
      if (registerFields) registerFields.hidden = current !== "register";
      if (authTitle) authTitle.textContent = current === "login" ? "登录" : "注册";
      if (authSubtitle) authSubtitle.textContent = current === "login" ? "使用邮箱登录" : "创建新账号";
      if (authModeText) authModeText.textContent = current === "login" ? "没有账号？注册" : "已有账号？登录";
    });
  }

  // 登录表单提交
  const authForm = document.getElementById("authForm");
  if (authForm) {
    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleAuthSubmit(e);
    });
  }

  // 发送验证码
  const sendCodeBtn = document.getElementById("sendCodeBtn");
  if (sendCodeBtn) {
    sendCodeBtn.addEventListener("click", async () => {
      await sendVerificationCode();
    });
  }

  // 保存模型配置
  const saveModelConfigBtn = document.getElementById("saveModelConfig");
  if (saveModelConfigBtn) {
    saveModelConfigBtn.addEventListener("click", async () => {
      await saveModelConfig();
    });
  }

  // 测试模型配置
  const testModelConfigBtn = document.getElementById("testModelConfig");
  if (testModelConfigBtn) {
    testModelConfigBtn.addEventListener("click", async () => {
      await testModelConfig();
    });
  }

  // 新建模型按钮
  const newModelConfig = document.getElementById("newModelConfig");
  if (newModelConfig) {
    newModelConfig.addEventListener("click", () => {
      openModelSettingsDialog();
    });
  }

  // 删除当前模型按钮
  const deleteCurrentModel = document.getElementById("deleteCurrentModel");
  if (deleteCurrentModel) {
    deleteCurrentModel.addEventListener("click", async () => {
      const modelId = getState("selectedModelConfigId");
      if (!modelId) {
        showToast("请先选择一个模型");
        return;
      }
      const models = getState("modelSettings")?.models || [];
      const model = models.find(m => m.id === modelId);
      await deleteModelConfig(modelId, model?.label || "未命名");
    });
  }

  // 模型设置弹窗关闭
  const modelSettingsClose = document.getElementById("modelSettingsClose");
  if (modelSettingsClose) {
    modelSettingsClose.addEventListener("click", closeModelSettingsDialog);
  }

  // 工作区面板关闭
  const workspacePanelClose = document.getElementById("workspacePanelClose");
  if (workspacePanelClose) {
    workspacePanelClose.addEventListener("click", closeWorkspacePanelDialog);
  }

  // 个人资料保存
  // 更换头像：选中文件后即时预览到弹窗头像（无需点保存即实时可见）
  const profileAvatarInput = document.getElementById("profileAvatarInput");
  const profileAvatarImg = document.getElementById("profileDialogAvatar");
  if (profileAvatarInput && profileAvatarImg) {
    profileAvatarInput.addEventListener("change", () => {
      const file = profileAvatarInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        profileAvatarImg.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  const profileSaveBtn = document.getElementById("profileSaveBtn");
  if (profileSaveBtn) {
    profileSaveBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const displayName = document.getElementById("profileDisplayName")?.value?.trim();
      const avatarInput = document.getElementById("profileAvatarInput");
      const file = avatarInput?.files?.[0];
      await updateProfile(displayName, file);
      const profileDialog = document.getElementById("profileDialog");
      if (profileDialog) profileDialog.hidden = true;
    });
  }

  // 个人资料弹窗关闭
  const profileDialogClose = document.getElementById("profileDialogClose");
  if (profileDialogClose) {
    profileDialogClose.addEventListener("click", () => {
      const profileDialog = document.getElementById("profileDialog");
      if (profileDialog) profileDialog.hidden = true;
    });
  }

  // 兼容模板填充
  const useCompatibleTemplate = document.getElementById("useCompatibleTemplate");
  if (useCompatibleTemplate) {
    useCompatibleTemplate.addEventListener("click", () => {
      const modelSettings = getState("modelSettings");
      let template = modelSettings?.templates?.deepseek ?? {
        label: "DeepSeek V4 Flash",
        provider: "DeepSeek",
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-v4-flash",
      };
      // 服务端模板可能仍是已弃用旧值（deepseek-chat/deepseek-reasoner），统一升级到当前有效模型
      const DEPRECATED_IDS = new Set(["deepseek-chat", "deepseek-reasoner"]);
      if (DEPRECATED_IDS.has(template.model)) {
        template = { ...template, label: "DeepSeek V4 Flash", model: "deepseek-v4-flash" };
      }
      const labelInput = document.getElementById("modelConfigLabel");
      const providerInput = document.getElementById("modelConfigProvider");
      const baseUrlInput = document.getElementById("modelConfigBaseUrl");
      const modelInput = document.getElementById("modelConfigModel");
      if (labelInput) labelInput.value = template.label || "";
      if (providerInput) providerInput.value = template.provider || "";
      if (baseUrlInput) baseUrlInput.value = template.baseURL || "";
      if (modelInput) modelInput.value = template.model || "";
    });
  }

  // 模型表单变更检测
  const modelInputs = [
    "modelConfigLabel", "modelConfigProvider", "modelConfigBaseUrl",
    "modelConfigModel", "modelConfigApiKey",
  ];
  for (const id of modelInputs) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => {
        updateModelEditState();
      });
    }
  }

  // 切换 API Key 可见性
  const toggleApiKeyVisibility = document.getElementById("toggleApiKeyVisibility");
  if (toggleApiKeyVisibility) {
    toggleApiKeyVisibility.addEventListener("click", () => {
      const apiKeyInput = document.getElementById("modelConfigApiKey");
      if (!apiKeyInput) return;
      const reveal = apiKeyInput.type === "password";
      apiKeyInput.type = reveal ? "text" : "password";
      // 图标随可见性切换：眼睛 ↔ 眼睛斜杠
      const icon = toggleApiKeyVisibility.querySelector("i");
      if (icon) {
        icon.classList.remove("ph-eye", "ph-eye-slash");
        icon.classList.add(reveal ? "ph-eye-slash" : "ph-eye");
        toggleApiKeyVisibility.title = reveal ? "隐藏密钥" : "显示密钥";
        toggleApiKeyVisibility.setAttribute("aria-label", reveal ? "隐藏密钥" : "显示密钥");
      }
    });
  }

  // 窗口 resize 时刷新会话列表
  window.addEventListener("resize", () => {
    renderSessions();
  });
}

// ─── 事件监听 ────────────────────────────────────────────

function bindEventListeners() {
  // 会话消息加载 → 渲染到聊天区
  on(EventNames.SESSION_MESSAGES_LOADED, ({ messages }) => {
    const chat = document.getElementById("chat");
    if (!chat) return;
    chat.innerHTML = "";
    if (!messages || messages.length === 0) {
      renderEmptyChat();
      updateContextUsage();
      return;
    }
    for (const msg of messages) {
      const el = appendMessage(msg.role || "user", msg.content || "");
      el?.render(msg.content || "");
      // 历史消息若带持久化的"查看过程"日志，回放渲染
      if (msg.role === "assistant" && Array.isArray(msg.process) && msg.process.length > 0 && el?.processEl) {
        for (const p of msg.process) {
          appendProcess(el.processEl, p.content || "", p.name || "step");
        }
      }
    }
    updateContextUsage();
  });

  // 会话切换 → 更新标题
  on(EventNames.SESSION_SWITCH, (sessionId) => {
    const session = getState("sessions").find((s) => s.id === sessionId);
    const title = document.getElementById("conversationTitle");
    if (title) {
      title.textContent = session?.title || "银狼 Agent";
    }
    renderSessions();
  });

  // 一条消息流式生成完成 → 刷新消息用量
  on(EventNames.MESSAGE_STREAM_COMPLETE, () => {
    updateContextUsage();
  });

  // 发送消息时立即刷新用量（包含刚发出的用户消息）
  on(EventNames.MESSAGE_SEND, () => {
    updateContextUsage();
  });

  // 模型激活 → 更新 UI
  on(EventNames.MODEL_ACTIVATE, (model) => {
    const importModel = model || {};
    updateActiveModelUI(importModel);
  });
}

// ─── 启动 ────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp);
} else {
  initializeApp().catch(showInitializationError);
}

export { initializeApp };
