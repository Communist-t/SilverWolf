/**
 * 技能管理器
 *
 * 统一管理所有技能（联网搜索、天气、新闻等）。
 * 每个技能有名称、描述和调用入口。
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { searchWeather as weatherSearch } from "./weather-skill.js";
import { searchWeb } from "./web-search.js";
import { getFitnessProfile, upsertFitnessProfile, addMeal, getMeals, deleteMeal, addWorkout, getWorkouts, deleteWorkout, updateHydration, updateSleep, getDailyLog, getDailySummary, getWeeklyTrend, updateDailyNotes, getRecentWorkouts, getRecentMeals } from "./fitness-tracker.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 技能根目录（skills/ 文件夹）
const SKILLS_ROOT = resolve(__dirname, "..", "..", "skills");

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
  {
    name: "fitness",
    description: "健身追踪与营养管理 — 体成分、宏量营养素配比(30/35/35)、运动、睡眠与水分记录",
    version: "1.0.0",
  },
];

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

// ── 健身技能导出 ───────────────────────────────────────────────

/** 获取健身用户配置 */
export { getFitnessProfile };

/** 创建/更新健身用户配置 */
export { upsertFitnessProfile };

/** 添加饮食记录 */
export { addMeal };

/** 获取某日饮食记录 */
export { getMeals };

/** 删除饮食记录 */
export { deleteMeal };

/** 添加运动记录 */
export { addWorkout };

/** 获取某日运动记录 */
export { getWorkouts };

/** 删除运动记录 */
export { deleteWorkout };

/** 更新水分摄入 */
export { updateHydration };

/** 更新睡眠时长 */
export { updateSleep };

/** 获取每日日志 */
export { getDailyLog };

/** 获取每日简报 */
export { getDailySummary };

/** 获取近7日趋势 */
export { getWeeklyTrend };

/** 更新每日备注 */
export { updateDailyNotes };

/** 获取近期运动记录 */
export { getRecentWorkouts };

/** 获取近期饮食记录 */
export { getRecentMeals };

/** 获取所有技能列表 */
export function listSkills(): SkillDefinition[] {
  return [...SKILLS];
}
