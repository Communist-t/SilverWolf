/**
 * ui/message-renderer.js — 消息渲染
 * 负责 Markdown 渲染、代码块、来源卡片、思考过程等
 */

import { emit, EventNames } from "../core/events.js";

const THINKING_START_PATTERNS = [
  /^<thinking>/i,
  /^<reasoning>/i,
  /^<think>/i,
  /^\<thinking\>/i,
  /^<thought>/i,
];

const META_REASONING_RE = [
  /^<thinking>/i,
  /^<reasoning>/i,
  /^<think>/i,
  /^\<thinking\>/i,
  /^<thought>/i,
];

// ─── 思考内容剥离 ────────────────────────────────────────

function feStartsWithThinking(text) {
  const t = text.trimStart();
  for (const p of THINKING_START_PATTERNS) { if (p.test(t)) return true; }
  return false;
}

function feContainsMetaReasoning(paragraph) {
  return META_REASONING_RE.some((r) => r.test(paragraph.trim()));
}

function feExtractQuotedDialog(text) {
  const patterns = [
    /["「『」】]([^"「』」]+)["」]/g,
    /"([^"]+)"/g,
    /'([^']+)'/g,
  ];
  const matches = [];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const c = m[1].trim();
      if (c.length > 2) matches.push(c);
    }
  }
  return matches;
}

function feStripThinkingContent(text) {
  let r = text;
  const thinkingPatterns = [
    /^<thinking>[\s\S]*?<\/thinking>/i,
    /^<reasoning>[\s\S]*?<\/reasoning>/i,
    /^<think>[\s\S]*?<\/think>/i,
  ];
  for (const tp of thinkingPatterns) {
    r = r.replace(tp, "");
  }
  if (r.trim().startsWith("<thinking>") || r.trim().startsWith("<think>")) {
    const paras = r.split(/\n{2,}/);
    let startIdx = -1;
    for (let i = paras.length - 1; i >= 0; i--) {
      const para = paras[i].trim();
      if (!feContainsMetaReasoning(para)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx >= 0) {
      const filtered = paras.slice(startIdx).join("\n\n").trim();
      if (filtered.length < r.trim().length * 0.5) {
        const extracted = feExtractQuotedDialog(r);
        if (extracted.length > 0) return extracted.join("\n");
      }
      return filtered;
    }
  }
  return r;
}

// ─── Markdown 渲染 ──────────────────────────────────────

function appendInlineMarkdown(container, source) {
  const normalized = source.replace(/\*\*\s*([^*\n]+?)\s*\*\*/g, "**$1**");
  const tokenPattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[([^\]\n]+)\]\(([^)\n]+)\)|https?:\/\/[^\s)<\]"'`\u00A0]+|www\.[^\s)<\]"'`\u00A0]+)/g;
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(normalized)) !== null) {
    if (match.index > cursor) {
      container.appendChild(document.createTextNode(normalized.slice(cursor, match.index)));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      container.appendChild(strong);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      container.appendChild(code);
    } else if (token.startsWith("[") && token.includes("](")) {
      const link = document.createElement("a");
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (parts) {
        link.href = parts[2];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = parts[1];
      }
      container.appendChild(link);
    } else {
      const href = token.startsWith("www.") ? `https://${token}` : token;
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = token;
      container.appendChild(link);
    }
    cursor = match.index + token.length;
  }

  if (cursor < normalized.length) {
    container.appendChild(document.createTextNode(normalized.slice(cursor)));
  }
}

function isMarkdownBlockStart(line) {
  return /^#{1,6}\s|^(- |\* |\d+\.)\s|^```|^---+$/i.test(line);
}

function formatCompactPython(source) {
  const code = source.trim();
  const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
  const formatted = [];
  const blockStack = [];
  for (const statement of statements) {
    const keyword = statement.match(/^([A-Za-z_]+)/)?.[1] ?? "";
    if (["try", "except", "if", "elif", "else", "for", "while", "with"].includes(keyword)) {
      blockStack.push(keyword);
    }
    const indent = "    ".repeat(blockStack.length);
    const line = `${indent}${statement}`;
    formatted.push(line);
  }
  return formatted.join("\n");
}

function formatCodeBlock(source, language) {
  const normalized = String(source ?? "").replace(/^\n+|\n+$/g, "");
  return normalized;
}

// ─── 代码块下载：语言映射文件扩展名 ─────────────────────
function getCodeFileExtension(language) {
  const lang = String(language || "").toLowerCase().trim();
  const map = {
    html: ".html", htm: ".html",
    css: ".css",
    javascript: ".js", js: ".js", jsx: ".jsx",
    typescript: ".ts", ts: ".ts", tsx: ".tsx",
    python: ".py", py: ".py",
    json: ".json",
    yaml: ".yml", yml: ".yml",
    xml: ".xml",
    sql: ".sql",
    bash: ".sh", sh: ".sh", shell: ".sh",
    java: ".java",
    c: ".c", cpp: ".cpp", "c++": ".cpp",
    csharp: ".cs", cs: ".cs",
    go: ".go",
    rust: ".rs", rs: ".rs",
    php: ".php",
    ruby: ".rb", rb: ".rb",
    swift: ".swift",
    kotlin: ".kt", kt: ".kt",
    scala: ".scala",
    r: ".r",
    perl: ".pl",
    lua: ".lua",
    dart: ".dart",
    vue: ".vue",
    markdown: ".md", md: ".md",
    plaintext: ".txt", text: ".txt", txt: ".txt",
    csv: ".csv",
    ini: ".ini", conf: ".conf", config: ".conf",
    dockerfile: ".dockerfile",
  };
  return map[lang] || ".txt";
}
function appendCodeBlock(container, language, source) {
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-code-block";

  const header = document.createElement("div");
  header.className = "markdown-code-header";
  const langSpan = document.createElement("span");
  langSpan.className = "code-lang";
  langSpan.textContent = language || "code";
  header.appendChild(langSpan);

  const copyBtn = document.createElement("button");
  copyBtn.className = "code-copy-btn";
  copyBtn.type = "button";
  copyBtn.textContent = "复制";
  copyBtn.addEventListener("click", async () => {
    const markCopied = () => {
      copyBtn.textContent = "已复制";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "复制";
        copyBtn.classList.remove("copied");
      }, 1500);
    };
    const markFailed = () => {
      copyBtn.textContent = "复制失败";
      setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
    };
    // 优先用 Clipboard API
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(source);
        markCopied();
        return;
      } catch { /*  fall through to fallback */ }
    }
    // 兜底：临时 textarea + execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = source;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) { markCopied(); } else { markFailed(); }
    } catch {
      markFailed();
    }
  });
  header.appendChild(copyBtn);

  // 下载按钮
  const downloadBtn = document.createElement("button");
  downloadBtn.className = "code-download-btn";
  downloadBtn.type = "button";
  downloadBtn.textContent = "下载";
  downloadBtn.addEventListener("click", () => {
    const ext = getCodeFileExtension(language);
    const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloadBtn.textContent = "已下载";
    downloadBtn.classList.add("downloaded");
    setTimeout(() => {
      downloadBtn.textContent = "下载";
      downloadBtn.classList.remove("downloaded");
    }, 1500);
  });
  header.appendChild(downloadBtn);
  wrapper.appendChild(header);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const safeLanguage = language.replace(/[^A-Za-z0-9_+-]/g, "");
  code.className = `language-${safeLanguage}`;
  code.textContent = source;
  pre.appendChild(code);
  wrapper.appendChild(pre);

  container.appendChild(wrapper);
}

/**
 * 渲染助手 Markdown 消息到容器
 * @param {HTMLElement} container - 目标容器
 * @param {string} source - Markdown 文本
 * @returns {HTMLElement} - 返回创建的 article 元素
 */
export function renderAssistantMarkdown(container, source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trimEnd();

    if (!line) { index++; continue; }

    // 代码块
    const fenceMatch = line.match(/^\s*```([^\s`]*)[ \t]*(.*)$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || "code";
      const openingRemainder = fenceMatch[2] ?? "";
      const codeLines = [];
      if (openingRemainder) codeLines.push(openingRemainder);
      index++;
      while (index < lines.length) {
        const candidate = lines[index];
        const closingMatch = candidate.match(/^(.*?)```\s*$/);
        if (closingMatch) {
          if (closingMatch[1].trim()) codeLines.push(closingMatch[1]);
          index++;
          break;
        }
        codeLines.push(candidate);
        index++;
      }
      const codeSource = codeLines.join("\n");
      appendCodeBlock(container, language, codeSource);
      continue;
    }

    // 标题
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const heading = document.createElement(`h${Math.min(headingMatch[1].length + 1, 4)}`);
      appendInlineMarkdown(heading, headingMatch[2]);
      container.appendChild(heading);
      index++;
      continue;
    }

    // 列表
    const unorderedMatch = line.match(/^\s*[-*•]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+[.)、]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const candidate = lines[index].trimEnd();
        const itemMatch = ordered
          ? candidate.match(/^\s*\d+[.)、]\s+(.+)$/)
          : candidate.match(/^\s*[-*•]\s+(.+)$/);
        if (!itemMatch) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemMatch[1]);
        list.appendChild(item);
        index++;
      }
      container.appendChild(list);
      continue;
    }

    // 段落
    const paragraphLines = [line.trim()];
    while (index + 1 < lines.length && lines[index + 1].trim() && !isMarkdownBlockStart(lines[index + 1])) {
      index++;
      paragraphLines.push(lines[index].trim());
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    container.appendChild(paragraph);
    index++;
  }

  return container;
}

/**
 * 从 Markdown 文本中提取纯文本（用于会话标题等）
 */
export function compactConversationText(value, fallback) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 80) + "…" : (text || fallback);
}

/**
 * 尝试剥离思考内容，返回用户可见文本
 */
export function stripThinkingContent(text) {
  if (!text || !feStartsWithThinking(text)) return text;
  return feStripThinkingContent(text);
}
