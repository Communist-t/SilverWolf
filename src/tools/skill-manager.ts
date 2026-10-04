/**
 * 技能管理器
 *
 * 统一管理所有技能（联网搜索、天气、新闻等）。
 * 每个技能有名称、描述和调用入口。
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { searchWeather as weatherSearch } from "./weather-skill.js";
import { searchWeb } from "./web-search.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 技能根目录（skills/ 文件夹）。
// 服务从项目根目录启动，使用 cwd 解析可同时兼容 tsx 开发与 dist 编译运行；
// 部署到其它位置时可用 SKILLS_ROOT 环境变量覆盖。
const SKILLS_ROOT = process.env.SKILLS_ROOT || resolve(process.cwd(), "skills");

// ── 技能定义 ─────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
}

export const SKILLS: SkillDefinition[] = [
  {
    name: "web-search",
    description: "通用联网搜索，多引擎自动降级",
    version: "1.0.0",
  },
  {
    name: "weather",
    description: "天气预报与空气质量查询",
    version: "1.0.0",
  },
  {
    name: "technology-news-search",
    description: "科技新闻搜索与今日热搜（聚合数据 API）",
    version: "2.0.0",
  },
];

// ── 技能扫描（从 skills/ 文件夹读取）──────────────────────────

/**
 * 解析 SKILL.md 的 YAML frontmatter（--- ... --- 之间的 key: value）。
 * 兼容：普通单行值、引号包裹值、`>-` / `|-` 折叠块（description 常用）。
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result: Record<string, string> = {};
  let currentKey = "";
  for (const raw of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (kv) {
      currentKey = kv[1].toLowerCase();
      const val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (val === ">-" || val === "|-") {
        result[currentKey] = "";
      } else if (val) {
        result[currentKey] = val;
      }
    } else if (currentKey && result[currentKey] !== undefined && /^\s+\S/.test(raw)) {
      const cont = raw.trim().replace(/^["']|["']$/g, "");
      if (cont) {
        result[currentKey] += result[currentKey] ? ` ${cont}` : cont;
      }
    }
  }
  return result;
}

/**
 * 扫描 skills/ 根目录下所有技能。
 * 每个顶层目录视为一个技能；在该目录或其一级子目录中查找 SKILL.md / skill.md
 * （兼容 skills/<name>/<name>/SKILL.md 这类嵌套布局与 skill.md 小写命名），
 * 解析 name / description / version，缺失时用目录名兜底。
 */
export function scanSkillsFromDisk(): SkillDefinition[] {
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const skills: SkillDefinition[] = [];
  for (const dirName of entries) {
    const dirPath = join(SKILLS_ROOT, dirName);
    let mdPath = "";

    for (const candidate of [join(dirPath, "SKILL.md"), join(dirPath, "skill.md")]) {
      if (existsSync(candidate)) {
        mdPath = candidate;
        break;
      }
    }
    if (!mdPath) {
      try {
        const subs = readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const sub of subs) {
          const p1 = join(dirPath, sub.name, "SKILL.md");
          const p2 = join(dirPath, sub.name, "skill.md");
          if (existsSync(p1)) {
            mdPath = p1;
            break;
          }
          if (existsSync(p2)) {
            mdPath = p2;
            break;
          }
        }
      } catch {
        // 目录不可读则跳过
      }
    }

    const meta = mdPath ? parseFrontmatter(readFileSync(mdPath, "utf8")) : {};
    // 以文件夹名作为技能名，与工具管道引用的路径保持一致（frontmatter 的 name 可能与文件夹名不一致）
    const name = dirName;
    const description = (meta.description?.trim() || `${dirName} 技能`)
      .replace(/\s+/g, " ")
      .slice(0, 120);
    const version = meta.version?.trim() || "1.0.0";
    skills.push({ name, description, version });
  }
  return skills;
}

// ── 技能调用 ─────────────────────────────────────────────────

/** 调用新闻搜索技能 */
export async function searchTechnologyNews(
  keyword: string,
  options: {
    limit?: number;
    maxAgeDays?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{
  keyword: string;
  total_found: number;
  search_time: string;
  elapsed_seconds: number;
  results: Array<{ title: string; url: string; summary: string; source: string }>;
  error?: string;
}> {
  const { limit = 15, maxAgeDays = 7, signal } = options;
  const newsScript = resolve(SKILLS_ROOT, "technology-news-search", "scripts", "search_news.js");
  const startTime = Date.now();

  if (!existsSync(newsScript)) {
    return {
      keyword,
      total_found: 0,
      search_time: new Date().toISOString(),
      elapsed_seconds: 0,
      results: [],
      error: `新闻技能脚本不存在: ${newsScript}`,
    };
  }

  // 处理非 ASCII 关键词：写临时文件传参
  const tmpFile = resolve(tmpdir(), `news-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  let apiResults: Array<{ title: string; url: string; summary: string; source: string }> = [];
  let apiError: string | undefined;

  try {
    mkdirSync(dirname(tmpFile), { recursive: true });
    writeFileSync(tmpFile, keyword, "utf-8");

    const nodePath = process.execPath;
    const { stdout } = await execFileAsync(nodePath, [
      newsScript,
      `@${tmpFile}`,
      `--limit`, String(limit),
      `--max-age`, String(maxAgeDays),
    ], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
      env: { ...process.env, SKILLS_ROOT },
    });

    // 解析 stdout 中的 JSON（脚本最后一行输出 JSON）
    const lines = stdout.trim().split("\n");
    const jsonLine = lines.find((line) => line.startsWith("{"));
    if (!jsonLine) {
      apiError = "新闻脚本输出格式异常";
    } else {
      const data = JSON.parse(jsonLine);
      apiResults = (data.results ?? []).map((r: { title?: string; url?: string; summary?: string; source?: string }) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        summary: r.summary ?? "",
        source: r.source ?? "",
      }));
    }
  } catch (error) {
    apiError = error instanceof Error ? error.message : String(error);
    logger.error("skill-manager", "news search failed", { keyword, error: apiError });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  // 兜底：聚合数据 API 结果不足时，用 web-search 补充
  if (apiResults.length < 3) {
    try {
      logger.info("skill-manager", "news api results insufficient, using web-search fallback", {
        keyword,
        apiResults: apiResults.length,
      });
      const searchResponse = await searchWeb(keyword, 5, "news", { signal });
      const webResults = searchResponse.results.map((r) => ({
        title: r.title,
        url: r.url,
        summary: r.snippet || r.content || "",
        source: r.sourceType === "news" ? "Web News" : "Web Search",
      }));
      // 去重后合并
      const existingUrls = new Set(apiResults.map((r) => r.url));
      for (const wr of webResults) {
        if (!existingUrls.has(wr.url)) {
          apiResults.push(wr);
          existingUrls.add(wr.url);
        }
      }
      logger.info("skill-manager", "web-search fallback completed", {
        keyword,
        webResults: webResults.length,
        totalAfterMerge: apiResults.length,
      });
    } catch (fallbackError) {
      logger.warn("skill-manager", "web-search fallback failed", {
        keyword,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  return {
    keyword,
    total_found: apiResults.length,
    search_time: new Date().toISOString(),
    elapsed_seconds: Math.round(elapsed * 10) / 10,
    results: apiResults.slice(0, limit),
    error: apiResults.length === 0 ? (apiError || "未找到相关新闻") : undefined,
  };
}

/** 查询天气预报（委托给 weather-skill） */
export { weatherSearch };

/** 通用联网搜索（委托给 web-search） */
export { searchWeb };

// ── 技能导出 ─────────────────────────────────────────────────

/** 获取所有技能列表（从 skills/ 文件夹实时扫描） */
export function listSkills(): SkillDefinition[] {
  return scanSkillsFromDisk();
}
