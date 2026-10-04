/**
 * modules/chat-ui.js — 聊天 UI 辅助函数
 * 消息 DOM 创建与追加（不处理业务逻辑，只负责渲染）
 */

import { renderAssistantMarkdown } from "../ui/message-renderer.js";

/**
 * 追加一条消息到聊天区
 * @param {"user"|"assistant"} role
 * @param {string} text
 * @param {string} [customLabel]
 * @returns {{ container: HTMLElement, rawText: string, render: Function }}
 */
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachments(container, attachments) {
  if (!attachments || attachments.length === 0) return;
  const wrap = document.createElement("div");
  wrap.className = "message-attachments";
  for (const file of attachments) {
    const item = document.createElement("div");
    item.className = "msg-attachment";
    if (IMAGE_MIME.has(file.type)) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.className = "msg-attachment-img";
      item.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "msg-attachment-icon";
      icon.textContent = "📄";
      item.appendChild(icon);
    }
    const meta = document.createElement("div");
    meta.className = "msg-attachment-meta";
    const name = document.createElement("span");
    name.className = "msg-attachment-name";
    name.textContent = file.name;
    meta.appendChild(name);
    const size = document.createElement("small");
    size.className = "msg-attachment-size";
    size.textContent = formatFileSize(file.size);
    meta.appendChild(size);
    item.appendChild(meta);
    wrap.appendChild(item);
  }
  container.appendChild(wrap);
}

export function appendMessage(role, text = "", customLabel = "", attachments = null) {
  const chat = document.getElementById("chat");
  if (!chat) return null;

  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.role = role;

  // 标签
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = customLabel || (role === "user" ? "玩家" : "银狼");
  article.appendChild(label);

  // 内容容器（同时挂 content 类以复用现有 markdown 排版样式）
  const content = document.createElement("div");
  content.className = "content message-content";
  article.appendChild(content);

  // 思考过程容器
  const process = role === "assistant" ? document.createElement("div") : null;
  if (process) {
    process.className = "process-container";
    article.appendChild(process);
  }

  chat.appendChild(article);

  // 滚动到底部
  chat.scrollTop = chat.scrollHeight;

  // 返回渲染对象
  return {
    container: article,
    contentEl: content,
    processEl: process,
    rawText: "",
    render(newText) {
      if (role === "assistant") {
        // 助手消息用 Markdown 排版（安全 DOM 构建）
        content.replaceChildren();
        renderAssistantMarkdown(content, newText);
      } else {
        content.replaceChildren();
        // 用户消息：先显示附件，再显示文字
        renderAttachments(content, attachments);
        if (newText) {
          const textEl = document.createElement("div");
          textEl.className = "message-text";
          textEl.textContent = newText;
          content.appendChild(textEl);
        }
      }
    },
  };
}

/**
 * 渲染空聊天区（新对话欢迎页）
 */
export function renderEmptyChat() {
  const chat = document.getElementById("chat");
  if (!chat) return;

  const empty = document.createElement("div");
  empty.className = "empty-state";

  // 角色头像
  const avatarWrap = document.createElement("div");
  avatarWrap.className = "welcome-avatar";
  const avatarImg = document.createElement("img");
  avatarImg.src = "/assets/silver-wolf-avatar.png?v=1";
  avatarImg.alt = "银狼";
  avatarImg.draggable = false;
  avatarWrap.appendChild(avatarImg);
  empty.appendChild(avatarWrap);

  // 标题
  const title = document.createElement("h2");
  title.className = "welcome-title";
  title.textContent = "和银狼打个招呼吧";
  empty.appendChild(title);

  // 副标题
  const subtitle = document.createElement("p");
  subtitle.className = "welcome-subtitle";
  subtitle.textContent = "星核猎手的天才骇客 · 破解规则，随时在线";
  empty.appendChild(subtitle);

  // 快捷提问
  const suggestions = [
    "介绍一下你自己",
    "帮我规划一个学习计划",
    "用通俗的话解释一个概念",
    "帮我写一段代码",
  ];
  const chipsWrap = document.createElement("div");
  chipsWrap.className = "welcome-suggestions";
  for (const text of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggestion-chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      const input = document.getElementById("input");
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      }
    });
    chipsWrap.appendChild(chip);
  }
  empty.appendChild(chipsWrap);

  chat.appendChild(empty);
}

/**
 * 追加进程步骤
 */
export function appendProcess(container, text, type = "step") {
  const entry = document.createElement("div");
  entry.className = `process-entry ${type}`;
  entry.textContent = text;
  container?.appendChild(entry);
}

/**
 * 追加来源卡片
 */
export function appendSource(container, source) {
  const entry = document.createElement("div");
  entry.className = "source-card";

  try {
    const url = new URL(source.url);
    entry.textContent = `${url.hostname} — ${source.title}`;
  } catch {
    entry.textContent = source.title || source.url;
  }

  if (source.url) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看来源";
    entry.appendChild(link);
  }

  container?.appendChild(entry);
}
