/**
 * 银狼技能执行器（function calling）
 *
 * 把系统真实可执行的技能封装成 OpenAI function calling 工具，
 * 让银狼在对话中能主动决定调用技能并真正执行（写文件、搜索、天气、新闻）。
 * 与前端"能力插件"（/settings/skills 扫描 skills/ 文件夹）同源，但这里只暴露
 * 有确定性执行器的技能，避免定义了却执行失败。
 */

import { isAbsolute, join, basename } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { searchWeather } from "./weather-skill.js";
import { searchWeb } from "./web-search.js";
import { searchTechnologyNews } from "./skill-manager.js";
import { generateDocument } from "./document-generator.js";

// ── 工具定义（OpenAI function calling schema）───────────────

export interface ExecutableSkill {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

/** 默认写文件目录：项目数据区（data/generated/），服务进程可写且可在 Web 端下载 */
function defaultOutputDir(): string {
  try {
    const generated = join(process.cwd(), "data", "generated");
    mkdirSync(generated, { recursive: true });
    return generated;
  } catch {
    return process.cwd();
  }
}

/**
 * 生成给模型的文件结果描述。
 * 提供绝对路径与相对下载链接（前端基于同一 origin 可直接下载 /files/<name>）。
 */
function describeGeneratedFile(outputPath: string, size: number): string {
  const name = basename(outputPath);
  return `已写入文件成功。\n文件路径：${outputPath}\n下载链接：/files/${encodeURIComponent(name)}\n文件大小：${size} 字节。`;
}

/** 路径安全校验：拒绝路径穿越和空文件名 */
function safeResolveOutput(directory: string | undefined, filename: string): string {
  const rawName = String(filename || "").trim();
  if (!rawName) throw new Error("文件名不能为空");
  const base = basename(rawName);
  if (base !== rawName || base === "." || base === "..") {
    throw new Error("文件名不能包含目录分隔符，请只传文件名（如 hello.md）");
  }
  const baseDir = directory && String(directory).trim()
    ? String(directory).trim()
    : defaultOutputDir();
  const parts = baseDir.split(/[\\/]/).filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("目录不能包含 '..' 路径穿越");
  }
  const finalDir = isAbsolute(baseDir) ? baseDir : join(defaultOutputDir(), baseDir);
  mkdirSync(finalDir, { recursive: true });
  return join(finalDir, base);
}

async function runWriteMarkdown(args: Record<string, unknown>): Promise<string> {
  const filename = String(args.filename ?? "").trim();
  const content = String(args.content ?? "");
  const directory = args.directory ? String(args.directory).trim() : undefined;
  const outputPath = safeResolveOutput(directory, filename);
  writeFileSync(outputPath, content, "utf-8");
  const size = Buffer.byteLength(content, "utf-8");
  return describeGeneratedFile(outputPath, size);
}

async function runWebSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("搜索关键词不能为空");
  const response = await searchWeb(query, 5, "general", { signal });
  if (response.results.length === 0) {
    return "搜索完成，但没有找到可用结果。";
  }
  return response.results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.snippet || r.content || "").slice(0, 200)}`
    )
    .join("\n");
}

async function runWeather(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const location = String(args.location ?? "").trim();
  if (!location) throw new Error("城市不能为空");
  const day = String(args.day ?? "今日").trim();
  const queries = [`${location} ${day}天气`, `${location} ${day}天气预报`];
  const results = await searchWeather(queries, signal);
  if (results.length === 0) {
    return `没有查询到 ${location} ${day} 的天气数据。`;
  }
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet || r.content || ""}`)
    .join("\n");
}

async function runNewsSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword) throw new Error("新闻关键词不能为空");
  const result = await searchTechnologyNews(keyword, { limit: 8, signal });
  if (result.total_found === 0) {
    return `没有找到关于"${keyword}"的新闻${result.error ? `：${result.error}` : ""}`;
  }
  return result.results
    .map((r, i) => `${i + 1}. ${r.title}（${r.source || "未知来源"}）\n   ${r.url}`)
    .join("\n");
}

// ── 文档技能（docx / pptx / pdf，纯 JS 生成器，不依赖 Python）─────

/** 校验文件名扩展名并解析输出路径 */
function resolveDocOutput(directory: string | undefined, filename: string, ext: string): string {
  const rawName = String(filename || "").trim().toLowerCase();
  if (!rawName) throw new Error("文件名不能为空");
  const targetExt = ext.startsWith(".") ? ext : `.${ext}`;
  let name = String(filename || "").trim();
  if (!name.toLowerCase().endsWith(targetExt)) {
    name = `${name}${targetExt}`;
  }
  return safeResolveOutput(directory, name);
}

async function runCreateDocx(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const output = resolveDocOutput(
    args.directory ? String(args.directory) : undefined,
    String(args.filename ?? ""),
    ".docx"
  );
  const content = String(args.content ?? "");
  if (!content.trim()) throw new Error("文档内容不能为空");
  const file = await generateDocument(
    "create_docx",
    {
      output,
      title: args.title ? String(args.title) : "",
      content,
    },
  );
  signal?.throwIfAborted();
  return describeGeneratedFile(file.path, file.size);
}

async function runCreatePptx(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const output = resolveDocOutput(
    args.directory ? String(args.directory) : undefined,
    String(args.filename ?? ""),
    ".pptx"
  );
  const slides = Array.isArray(args.slides)
    ? args.slides.map((s) => ({
        title: String((s as any)?.title ?? ""),
        points: Array.isArray((s as any)?.points)
          ? ((s as any).points as unknown[]).map((p) => String(p))
          : [],
      }))
    : [];
  if (slides.length === 0) throw new Error("至少需要一页幻灯片");
  const file = await generateDocument(
    "create_pptx",
    {
      output,
      title: args.title ? String(args.title) : "",
      slides,
    },
  );
  signal?.throwIfAborted();
  return describeGeneratedFile(file.path, file.size);
}

async function runCreatePdf(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const output = resolveDocOutput(
    args.directory ? String(args.directory) : undefined,
    String(args.filename ?? ""),
    ".pdf"
  );
  const content = String(args.content ?? "");
  if (!content.trim()) throw new Error("文档内容不能为空");
  const file = await generateDocument(
    "create_pdf",
    {
      output,
      title: args.title ? String(args.title) : "",
      content,
    },
  );
  signal?.throwIfAborted();
  return describeGeneratedFile(file.path, file.size);
}

/** 银狼可主动调用的技能列表（真实可执行） */
export const SKILL_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "write_markdown",
      description:
        "把文本内容写入一个 Markdown 或普通文本文件（如 .md/.txt），保存到本地磁盘。当玩家要求“写一个文件”“保存成 md 文档”“把内容生成文件”时使用。",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "文件名，必须带扩展名，例如 hello.md、notes.txt，不要包含路径" },
          content: { type: "string", description: "要写入文件的完整文本内容" },
          directory: { type: "string", description: "可选。目标目录（绝对路径），默认保存到项目 data/generated 并可通过下载链接获取" },
        },
        required: ["filename", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "通用联网搜索。当玩家需要实时信息、产品价格、技术文档、论文、新闻等而你现有知识不够用时使用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather",
      description: "查询某个城市的实时天气、气温、降雨和空气质量。",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "城市名，如 武汉、北京" },
          day: { type: "string", enum: ["今日", "明日", "后日"], description: "查询哪一天，默认今日" },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "news_search",
      description: "搜索科技新闻与今日热点，返回带来源的新闻条目。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "新闻关键词，如 AI、芯片、新能源汽车" },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_docx",
      description:
        "生成 Word 文档（.docx）。正文默认使用宋体，标题使用加粗标题样式。内容支持 Markdown 风格：以 # 开头的行作为标题，- 开头的行作为项目符号。生成后给出下载链接。当玩家要求“生成 Word 文档”“写一份 docx”“做个文档”时使用。",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "文件名，如 报告.docx、会议纪要.docx，不要包含路径" },
          title: { type: "string", description: "可选。文档大标题" },
          content: { type: "string", description: "文档正文内容，可用 # 标题、- 列表、普通段落" },
          directory: { type: "string", description: "可选。目标目录（绝对路径），默认保存到项目 data/generated 并可通过下载链接获取" },
        },
        required: ["filename", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pptx",
      description:
        "生成 PowerPoint 演示文稿（.pptx）。通过 slides 参数传入多页内容，每页含标题和要点列表，中文字体使用微软雅黑。生成后给出下载链接。当玩家要求“做一个 PPT”“生成演示文稿”“做课件”时使用。",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "文件名，如 汇报.pptx，不要包含路径" },
          title: { type: "string", description: "可选。演示主题" },
          slides: {
            type: "array",
            description: "幻灯片列表",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "本页标题" },
                points: {
                  type: "array",
                  items: { type: "string" },
                  description: "本页要点列表",
                },
              },
              required: ["title", "points"],
            },
          },
          directory: { type: "string", description: "可选。目标目录（绝对路径），默认保存到项目 data/generated 并可通过下载链接获取" },
        },
        required: ["filename", "slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pdf",
      description:
        "生成 PDF 文档。内容支持 Markdown 风格的标题与段落，中文使用系统中文字体渲染。生成后给出下载链接。当玩家要求“生成 PDF”“导出成 PDF”“做个 PDF 文档”时使用。",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "文件名，如 说明.pdf，不要包含路径" },
          title: { type: "string", description: "可选。文档大标题" },
          content: { type: "string", description: "文档正文内容，可用 # 标题、普通段落" },
          directory: { type: "string", description: "可选。目标目录（绝对路径），默认保存到项目 data/generated 并可通过下载链接获取" },
        },
        required: ["filename", "content"],
      },
    },
  },
];

const EXECUTORS: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>> = {
  write_markdown: runWriteMarkdown,
  web_search: runWebSearch,
  weather: runWeather,
  news_search: runNewsSearch,
  create_docx: runCreateDocx,
  create_pptx: runCreatePptx,
  create_pdf: runCreatePdf,
};

/** 执行一个技能调用，返回给模型的文本结果 */
export async function executeSkill(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const executor = EXECUTORS[name];
  if (!executor) {
    throw new Error(`未知技能: ${name}`);
  }
  return executor(args, signal);
}

/** 构建传给 LLM 的 tools 参数（按需过滤已自动执行的技能） */
export function buildSkillTools(options?: { exclude?: string[] }): ChatCompletionTool[] {
  const exclude = new Set(options?.exclude ?? []);
  return SKILL_TOOLS.filter((tool) => !exclude.has(tool.function.name));
}
