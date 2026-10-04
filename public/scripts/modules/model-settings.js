/**
 * modules/model-settings.js — 模型设置模块（Developer Tool 风格重构版）
 * 模型配置 CRUD、测试、激活、模板填充
 */

import { apiFetch, apiDelete } from "../core/api-client.js";
import {
  getState, setModelSettings, setSelectedModelConfigId,
  setSelectedModelSnapshot, setActiveModel,
} from "../core/store.js";
import { emit, EventNames } from "../core/events.js";
import { showToast, showActionError, openActionDialog } from "../ui/dialogs.js";

/**
 * 服务商 → 常用模型 ID 建议（用于“模型类型”datalist）
 * 仅保留当前真实有效的官方模型。
 */
const MODEL_PRESET_GROUPS = {
  DeepSeek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  OpenAI: ["gpt-5.1", "gpt-5-mini"],
  Anthropic: ["claude-sonnet-4-5", "claude-opus-4-8"],
  Google: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

const FORM_INPUT_IDS = [
  "modelConfigLabel", "modelConfigProvider", "modelConfigBaseUrl",
  "modelConfigModel", "modelConfigApiKey",
];

// 服务商/模型 → motu 人物图标（圆形头像），用于列表左侧直观区分不同模型
const MOTU_ICON_MAP = [
  { re: /deepseek|yunxi|saas/, img: "mermaid" },
  { re: /minimax/, img: "minimax" },
  { re: /openai|gpt|davinci/, img: "dragon" },
  { re: /anthropic|claude/, img: "red" },
  { re: /gemini|google|bard/, img: "cat" },
  { re: /glm|zhipu|chatglm|bigmodel/, img: "zai" },
  { re: /kimi|moonshot/, img: "k" },
  { re: /baidu|wenxin|ernie|qianfan/, img: "medblue" },
  { re: /qwen|tongyi|dashscope/, img: "ancient" },
  { re: /doubao|bytedance|volcengine|ark|byteplus/, img: "seed" },
  { re: /groq|grok|x\.?ai/, img: "devil" },
];

// ─── 工具函数 ────────────────────────────────────────────

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 模型 → 专属图标 + 主题色（用于列表左侧，视觉区分不同模型/服务商）。
 * 按 provider / baseURL / model 关键词匹配；未命中回退到默认立方体 + 中性色。
 * @returns {string} 完整的 <span class="ms-item-icon ms-tint-*">…</span>
 */
function modelIconHtml(model) {
  const hay = ((model?.provider || "") + " " + (model?.baseURL || "") + " " + (model?.model || "")).toLowerCase();
  // 优先使用 motu 人物头像图标
  for (const m of MOTU_ICON_MAP) {
    if (m.re.test(hay)) {
      return `<span class="ms-item-icon ms-img"><img src="/assets/motu-icons/${m.img}.png" alt="" loading="lazy"></span>`;
    }
  }
  const rules = [
    { re: /deepseek|yunxi|saas/, icon: "ph-brain", tint: "blue" },
    { re: /minimax/, icon: "ph-lightning", tint: "orange" },
    { re: /openai|gpt|davinci/, icon: "ph-robot", tint: "green" },
    { re: /anthropic|claude/, icon: "ph-hand-fist", tint: "amber" },
    { re: /gemini|google|bard/, icon: "ph-gem", tint: "violet" },
    { re: /ollama/, icon: "ph-cpu", tint: "cyan" },
    { re: /kimi|moonshot/, icon: "ph-moon", tint: "violet" },
    { re: /qwen|tongyi|dashscope/, icon: "ph-sparkle", tint: "red" },
    { re: /glm|zhipu|chatglm/, icon: "ph-atom", tint: "blue" },
    { re: /groq|grok|x-?ai/, icon: "ph-rocket", tint: "orange" },
    { re: /meta|llama/, icon: "ph-paw-print", tint: "green" },
    { re: /mistral/, icon: "ph-wind", tint: "cyan" },
    { re: /azure/, icon: "ph-cloud", tint: "cyan" },
  ];
  for (const r of rules) {
    if (r.re.test(hay)) {
      return `<span class="ms-item-icon ms-tint-${r.tint}"><i class="ph ${r.icon}" aria-hidden="true"></i></span>`;
    }
  }
  return '<span class="ms-item-icon ms-tint-muted"><i class="ph ph-cube" aria-hidden="true"></i></span>';
}

function captureModelFormState() {
  return {
    label: document.getElementById("modelConfigLabel")?.value,
    provider: document.getElementById("modelConfigProvider")?.value,
    baseUrl: document.getElementById("modelConfigBaseUrl")?.value,
    model: document.getElementById("modelConfigModel")?.value,
    apiKey: document.getElementById("modelConfigApiKey")?.value,
  };
}

function markModelSnapshot() {
  setSelectedModelSnapshot({ ...captureModelFormState() });
}

function getSelectedModel() {
  const id = getState("selectedModelConfigId");
  if (!id) return null;
  const models = getState("modelSettings")?.models || [];
  return models.find((m) => m.id === id) || null;
}

function isSelectedBuiltIn() {
  return !!getSelectedModel()?.builtIn;
}

function isSelectedActive() {
  return !!getSelectedModel()?.active;
}

export function updateModelEditState() {
  const saveBtn = document.getElementById("saveModelConfig");
  if (!saveBtn) return;

  const selectedId = getState("selectedModelConfigId");
  if (!selectedId) {
    // 新建模型：字段已预填，允许保存（必填项由 required 校验）
    saveBtn.disabled = false;
    return;
  }
  if (isSelectedBuiltIn()) {
    saveBtn.disabled = true;
    return;
  }
  const current = captureModelFormState();
  const baseline = getState("selectedModelSnapshot");
  const isDirty = baseline && (
    current.label !== baseline.label ||
    current.provider !== baseline.provider ||
    current.baseUrl !== baseline.baseUrl ||
    current.model !== baseline.model ||
    current.apiKey !== baseline.apiKey
  );
  saveBtn.disabled = !isDirty;
}

function inferProviderName(provider, baseURL, model) {
  const explicitProvider = String(provider || "").replace(/\s+/g, " ").trim();
  const isGeneric = /^(openai\s*compatible|openai\s*兼容|兼容|openai)$/i.test(explicitProvider);
  const explicitSource = explicitProvider.toLowerCase();

  const providerSource = String(baseURL || "").toLowerCase();
  const modelSource = String(model || "").toLowerCase();

  if (explicitSource.includes("deepseek") || providerSource.includes("deepseek") || modelSource.includes("deepseek")) {
    return "DeepSeek";
  }
  if (modelSource.includes("claude") || providerSource.includes("anthropic")) {
    return "Anthropic";
  }
  if (providerSource.includes("google") || modelSource.includes("gemini")) {
    return "Google";
  }
  if (providerSource.includes("azure") || modelSource.includes("azure")) {
    return "Azure";
  }
  return isGeneric ? "OpenAI 兼容" : (explicitProvider || "未知");
}

/**
 * 根据“服务商”更新“模型类型”datalist 建议；
 * 支持自由输入任意服务商/模型类型（datalist 仅为建议）。
 */
function syncModelPresetOptions(value) {
  const providerEl = document.getElementById("modelConfigProvider");
  const provider = (providerEl?.value || "").trim();
  const dl = document.getElementById("msTypeOptions");
  if (!dl) return;

  const models = MODEL_PRESET_GROUPS[provider] || [];
  dl.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    dl.appendChild(opt);
  }

  const combo = document.getElementById("msTypeCombo");
  if (value !== undefined && combo) combo.value = value;
}

function toggleBuiltInLock() {
  const builtIn = isSelectedBuiltIn();
  for (const id of FORM_INPUT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (builtIn) {
      el.setAttribute("readonly", "readonly");
    } else {
      el.removeAttribute("readonly");
    }
  }
}

function updateDeleteButton() {
  const btn = document.getElementById("deleteCurrentModel");
  if (!btn) return;
  const selectedId = getState("selectedModelConfigId");
  const disabled = !selectedId || isSelectedBuiltIn() || isSelectedActive();
  btn.disabled = disabled;
  btn.title = disabled
    ? (!selectedId ? "请先选择一个模型" : isSelectedBuiltIn() ? "内置模型不可删除" : "正在使用的模型不可删除")
    : "";
}

function updateActivateButton() {
  const btn = document.getElementById("msActivate");
  if (!btn) return;
  // 始终显示"设为使用中"，仅在不可用时置灰，避免用户找不到启用入口
  btn.hidden = false;
  const selectedId = getState("selectedModelConfigId");
  const active = isSelectedActive();
  btn.disabled = !selectedId || active;
  btn.title = !selectedId
    ? "请先在左侧选择一个模型"
    : active
      ? "当前已是使用中的模型"
      : "";
}

function updateConfigTitle(title) {
  const el = document.getElementById("msConfigTitle");
  if (el) el.textContent = title || "-";
}

// 右侧"编辑当前模型"徽标：建立左侧选中模型 ↔ 右侧配置的强关联
function updateEditingBadge(model) {
  const badge = document.getElementById("msEditingBadge");
  if (!badge) return;
  const name = (model && (model.label || model.model)) || "";
  badge.hidden = !name;
  badge.textContent = name ? `编辑：${name}` : "";
}

// ─── 渲染模型列表 ────────────────────────────────────────

/**
 * 按服务商分组渲染模型列表。
 * 组头显示服务商；每项主行为等宽加粗的模型 ID，副行为自定义名称（label），
 * 右侧中文状态徽标（使用中 / 内置 / 无 Key），解决"分不清模型区别"的困扰。
 */
export function renderModelConfigs() {
  const list = document.getElementById("modelConfigList");
  if (!list) return;

  const models = getState("modelSettings")?.models || [];
  const selectedId = getState("selectedModelConfigId");

  if (models.length === 0) {
    list.innerHTML = '<div class="ms-empty">暂无模型配置，点击「新建模型」添加</div>';
    return;
  }

  list.innerHTML = "";

  // 按服务商分组，保持 models 原始顺序
  const groups = [];
  const groupOf = new Map();
  for (const model of models) {
    const groupName = inferProviderName(model.provider, model.baseURL, model.model);
    let g = groupOf.get(groupName);
    if (!g) {
      g = { name: groupName, models: [] };
      groupOf.set(groupName, g);
      groups.push(g);
    }
    g.models.push(model);
  }

  for (const group of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "ms-group";
    const head = document.createElement("div");
    head.className = "ms-group-head";
    head.textContent = group.name;
    groupEl.appendChild(head);

    for (const model of group.models) {
      groupEl.appendChild(buildModelItem(model, selectedId));
    }
    list.appendChild(groupEl);
  }
}

/** 构造单个模型列表项（主行 = 模型 ID，副行 = 自定义名称，右侧状态徽标） */
function buildModelItem(model, selectedId) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "ms-item"
    + (model.id === selectedId ? " selected" : "")
    + (model.active ? " is-active" : "");

  const badges = [];
  if (model.active) badges.push('<span class="ms-item-badge ms-badge-active">使用中</span>');
  else if (model.builtIn) badges.push('<span class="ms-item-badge ms-badge-builtin">内置</span>');
  if (!model.hasApiKey) badges.push('<span class="ms-item-badge ms-badge-warn">无 Key</span>');

  const builtinMark = model.builtIn
    ? '<i class="ph ph-lock ms-lock" title="内置模型，不可编辑/删除"></i>'
    : "";

  item.innerHTML =
    modelIconHtml(model)
    + '<span class="ms-item-copy">'
    + '<span class="ms-item-name">' + esc(model.model || "未命名") + builtinMark + '</span>'
    + '<span class="ms-item-sub">' + esc(model.label || "未命名") + '</span>'
    + '</span>'
    + badges.join("");

  const itemIconImg = item.querySelector(".ms-item-icon img");
  if (itemIconImg) {
    itemIconImg.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openModelIconPreview(itemIconImg.src, item.querySelector(".ms-item-name")?.textContent || "");
    });
  }
  item.addEventListener("click", () => selectModelConfig(model));
  return item;
}

// ─── 数据加载 ────────────────────────────────────────────

export async function loadModelSettings() {
  try {
    const response = await apiFetch("/settings/models", { cache: "no-store" });
    const data = await response.json();
    const settings = {
      models: data.models || [],
      activeModel: data.activeModel || null,
      templates: data.templates || {},
    };
    setModelSettings(settings);

    const activeOrFirst = settings.models.find((m) => m.active) || settings.models[0] || null;
    setActiveModel(activeOrFirst);
    renderModelConfigs();
    updateActiveModelUI(activeOrFirst);
  } catch (e) {
    showActionError(e);
  }
}

// ─── 弹窗操作 ────────────────────────────────────────────

export async function openModelSettingsDialog(skipReset = false) {
  const dialog = document.getElementById("modelSettingsDialog");
  if (!dialog) return;

  dialog.hidden = false;

  if (!skipReset) {
    // 新建模型：重置表单为空，不预填任何内容
    setSelectedModelConfigId(null);
    setSelectedModelSnapshot(null);
    const form = document.getElementById("modelConfigForm");
    if (form) form.reset();
    const apiKeyInput = document.getElementById("modelConfigApiKey");
    if (apiKeyInput) { apiKeyInput.value = ""; apiKeyInput.placeholder = "sk-... 必填"; apiKeyInput.type = "password"; }
    updateConfigTitle("新建模型");
    updateEditingBadge(null);
  }

  syncModelPresetOptions(document.getElementById("modelConfigModel")?.value || "");
  toggleBuiltInLock();
  updateModelEditState();
  updateDeleteButton();
  updateActivateButton();
  renderModelConfigs();
  bindConfigIconInputs();
  updateConfigIcon();
}

export function closeModelSettingsDialog() {
  const dialog = document.getElementById("modelSettingsDialog");
  if (dialog) dialog.hidden = true;
  setSelectedModelConfigId(null);
  setSelectedModelSnapshot(null);
}

export function selectModelConfig(model) {
  if (!model) return;
  setSelectedModelConfigId(model.id);
  setSelectedModelSnapshot(captureModelFormState());

  const labelInput = document.getElementById("modelConfigLabel");
  const providerInput = document.getElementById("modelConfigProvider");
  const baseUrlInput = document.getElementById("modelConfigBaseUrl");
  const modelInput = document.getElementById("modelConfigModel");
  const apiKeyInput = document.getElementById("modelConfigApiKey");

  if (labelInput) labelInput.value = model.label || "";
  if (providerInput) providerInput.value = model.provider || "";
  if (baseUrlInput) baseUrlInput.value = model.baseURL || "";
  if (modelInput) modelInput.value = model.model || "";
  if (apiKeyInput) {
    // 明文显示已保存的密钥；默认 password 掩码，点眼睛可显示
    apiKeyInput.value = model.apiKey || "";
    apiKeyInput.type = "password";
    apiKeyInput.placeholder = model.apiKey ? "sk-... 明文已回填，修改请直接编辑" : "sk-... 必填";
  }
  updateConfigTitle(model.model || model.label || "未命名");
  updateEditingBadge(model);
  syncModelPresetOptions(model.model || "");
  markModelSnapshot();
  toggleBuiltInLock();
  openModelSettingsDialog(true);
  updateConfigIcon();
}

// ─── 激活/删除模型 ───────────────────────────────────────

export async function activateModelConfig(modelId) {
  try {
    const response = await apiFetch(`/settings/models/${encodeURIComponent(modelId)}/activate`, {
      method: "POST",
    });
    const data = await response.json();
    setActiveModel(data.activeModel || null);
    emit(EventNames.MODEL_ACTIVATE, data.activeModel || null);
    await loadModelSettings();
    showToast("模型已设为使用中");
  } catch (e) {
    showActionError(e);
  }
}

export async function deleteModelConfig(modelId, label) {
  const confirmed = await openActionDialog({
    title: "删除模型",
    message: `确定删除「${label || modelId}」吗？`,
    confirmText: "删除",
    danger: true,
  });

  if (confirmed === true || confirmed === "true") {
    try {
      await apiDelete(`/settings/models/${encodeURIComponent(modelId)}`);
      setSelectedModelConfigId(null);
      await loadModelSettings();
      openModelSettingsDialog();
      showToast("模型已删除");
    } catch (e) {
      showActionError(e);
    }
  }
}

// ─── 保存模型 ────────────────────────────────────────────

export async function saveModelConfig() {
  const payload = modelConfigPayload();
  const modelId = getState("selectedModelConfigId");

  try {
    let response;
    if (modelId) {
      const patch = { ...payload };
      if (!patch.apiKey) delete patch.apiKey; // 留空保持不变
      response = await apiFetch(`/settings/models/${encodeURIComponent(modelId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    } else {
      response = await apiFetch("/settings/models", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    const data = await response.json().catch(() => ({}));
    await loadModelSettings();
    if (data.model) {
      selectModelConfig(data.model);
    } else {
      openModelSettingsDialog();
    }
    showToast(modelId ? "模型已更新" : "模型已添加");
  } catch (e) {
    showActionError(e);
  }
}

// ─── 测试模型 ────────────────────────────────────────────

export async function testModelConfig() {
  const payload = modelConfigPayload();
  const statusEl = document.getElementById("modelTestStatus");
  const feedbackEl = document.getElementById("modelSettingsFeedback");

  if (statusEl) {
    statusEl.innerHTML = '<i class="ph ph-circle-notch ph-spin" aria-hidden="true"></i><span>测试中...</span>';
    statusEl.className = "ms-status testing";
  }
  if (feedbackEl) feedbackEl.hidden = true;

  try {
    const response = await apiFetch("/settings/models/test", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));

    if (statusEl) {
      statusEl.innerHTML = data.ok
        ? '<i class="ph ph-check-circle" aria-hidden="true"></i><span>Configuration valid</span>'
        : '<i class="ph ph-x-circle" aria-hidden="true"></i><span>连接失败</span>';
      statusEl.className = `ms-status ${data.ok ? "" : "error"}`;
    }
    if (feedbackEl) {
      feedbackEl.hidden = false;
      feedbackEl.textContent = data.ok
        ? `模型可用${data.replyPreview ? `：${data.replyPreview}` : ""}`
        : `错误: ${data.error || "未知错误"}`;
      feedbackEl.className = `ms-feedback ${data.ok ? "success" : "error"}`;
    }
  } catch (e) {
    if (statusEl) {
      statusEl.innerHTML = '<i class="ph ph-x-circle" aria-hidden="true"></i><span>连接失败</span>';
      statusEl.className = "ms-status error";
    }
    if (feedbackEl) {
      feedbackEl.hidden = false;
      feedbackEl.textContent = `错误: ${e.message}`;
      feedbackEl.className = "ms-feedback error";
    }
  }
}

function modelConfigPayload() {
  const modelIdField = document.getElementById("modelConfigModel")?.value?.trim() || "";
  const typeCombo = document.getElementById("msTypeCombo")?.value?.trim() || "";
  return {
    label: document.getElementById("modelConfigLabel")?.value?.trim() || "",
    provider: document.getElementById("modelConfigProvider")?.value?.trim() || "",
    baseURL: document.getElementById("modelConfigBaseUrl")?.value?.trim() || "",
    model: modelIdField || typeCombo,
    apiKey: document.getElementById("modelConfigApiKey")?.value || "",
  };
}

// ─── 激活模型 UI 更新 ────────────────────────────────────

export function updateActiveModelUI(activeModel) {
  const activeModelName = document.getElementById("activeModelName");
  const activeModelProvider = document.getElementById("activeModelProvider");
  const activeModelId = document.getElementById("activeModelId");

  if (activeModelName) activeModelName.textContent = activeModel?.label || activeModel?.model || "未设置";
  if (activeModelProvider) activeModelProvider.textContent = activeModel
    ? inferProviderName(activeModel.provider, activeModel.baseURL, activeModel.model)
    : "-";
  if (activeModelId) activeModelId.textContent = activeModel?.model || "-";
  // 更新侧边栏“模型设置”标签
  const navLabel = document.getElementById("activeModelNavLabel");
  if (navLabel) navLabel.textContent = activeModel?.model || "未设置";
}

// ─── 模块级事件绑定（仅在导入时执行一次） ────────────────

function bindModelSettingsEvents() {
  // 服务商变化 → 更新“模型类型”datalist
  const providerInput = document.getElementById("modelConfigProvider");
  if (providerInput) {
    providerInput.addEventListener("input", () => syncModelPresetOptions());
    providerInput.addEventListener("change", () => syncModelPresetOptions());
  }

  // 模型类型（datalist）→ 实时同步到“模型 ID”
  const typeCombo = document.getElementById("msTypeCombo");
  const modelInput = document.getElementById("modelConfigModel");
  if (typeCombo) {
    typeCombo.addEventListener("input", () => {
      if (modelInput && typeCombo.value.trim()) modelInput.value = typeCombo.value.trim();
    });
    typeCombo.addEventListener("change", () => {
      if (modelInput && typeCombo.value.trim()) modelInput.value = typeCombo.value.trim();
    });
  }

  // 设为使用中
  const activateBtn = document.getElementById("msActivate");
  if (activateBtn) {
    activateBtn.addEventListener("click", async () => {
      const modelId = getState("selectedModelConfigId");
      if (!modelId) return;
      await activateModelConfig(modelId);
    });
  }

  // 列表底部“添加模型”
  const addModelBtn = document.getElementById("msAddModel");
  if (addModelBtn) {
    addModelBtn.addEventListener("click", () => openModelSettingsDialog());
  }
}

bindModelSettingsEvents();

// ─── 模型图标 · 点击查看大图 ────────────────────────────────
let _iconPreviewEl = null;

function openModelIconPreview(src, title) {
  if (!_iconPreviewEl) {
    _iconPreviewEl = document.createElement("div");
    _iconPreviewEl.className = "model-icon-preview";
    _iconPreviewEl.setAttribute("role", "dialog");
    _iconPreviewEl.innerHTML =
      '<div class="mip-card">'
      + '<button type="button" class="mip-close" aria-label="关闭">&times;</button>'
      + '<img class="mip-img" alt="模型图标预览">'
      + '<div class="mip-title"></div>'
      + '</div>';
    _iconPreviewEl.addEventListener("click", (e) => {
      if (e.target === _iconPreviewEl || e.target.classList.contains("mip-close")) closeModelIconPreview();
    });
    document.body.appendChild(_iconPreviewEl);
  }
  _iconPreviewEl.querySelector(".mip-img").src = src;
  _iconPreviewEl.querySelector(".mip-title").textContent = title || "";
  _iconPreviewEl.hidden = false;
  document.addEventListener("keydown", _iconPreviewKey);
}

function _iconPreviewKey(e) {
  if (e.key === "Escape") closeModelIconPreview();
}

function closeModelIconPreview() {
  if (_iconPreviewEl) {
    _iconPreviewEl.hidden = true;
    document.removeEventListener("keydown", _iconPreviewKey);
  }
}

// ─── 右侧配置 · 当前模型图标展示 ────────────────────────────
let _configIconBound = false;

function currentFormModel() {
  return {
    provider: document.getElementById("modelConfigProvider")?.value || "",
    baseURL: document.getElementById("modelConfigBaseUrl")?.value || "",
    model: document.getElementById("modelConfigModel")?.value || "",
  };
}

function updateConfigIcon() {
  const el = document.getElementById("msConfigIcon");
  if (!el) return;
  const html = modelIconHtml(currentFormModel());
  const m = html.match(/\/assets\/motu-icons\/([a-z]+)\.png/);
  if (m) {
    el.innerHTML = `<span class="ms-config-avatar"><img src="/assets/motu-icons/${m[1]}.png" alt="" loading="lazy"></span>`;
  } else {
    el.innerHTML = `<span class="ms-config-avatar ms-config-vector">${html}</span>`;
  }
}

function bindConfigIconInputs() {
  if (_configIconBound) return;
  _configIconBound = true;
  ["modelConfigProvider", "modelConfigBaseUrl", "modelConfigModel"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateConfigIcon);
  });
}