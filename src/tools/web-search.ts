/**
 * 通用联网搜索工具。
 *
 * 默认使用 DuckDuckGo HTML 搜索，不需要 API Key。流程：
 * 1. 多 query 搜索
 * 2. 广告和无关结果过滤
 * 3. 按意图重排
 * 4. 抓取前几个网页正文片段
 */

import * as cheerio from "cheerio";
import { fetch } from "undici";
import { logger } from "../logger.js";
import { config } from "../config.js";
import type { SearchIntent } from "./tool-router.js";
import {
  isSafePublicHttpUrl,
  readResponseText,
  resolvesToPublicHttpTarget,
} from "./network-safety.js";
import { fetchWithTimeout, withRetry } from "./http-utils.js";
import { searchWeather } from "./weather-skill.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: "official" | "news" | "paper" | "code" | "social" | "general";
  score: number;
  content?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface WebSearchResponse {
  query: string;
  queries: string[];
  intent: SearchIntent;
  results: WebSearchResult[];
  provider: "tavily" | "brave" | "html";
  fetchedAt: string;
  fromCache: boolean;
}

export interface WebSearchOptions {
  signal?: AbortSignal;
  bypassCache?: boolean;
}

const DEFAULT_MAX_RESULTS = 6;
const SEARCH_RESULTS_PER_QUERY = 8;
const FETCH_CONTENT_RESULTS = 4;
const MAX_CONTENT_CHARS = 1800;
type SearchProvider = "auto" | "tavily" | "brave" | "html";
const searchCache = new Map<string, { expiresAt: number; value: WebSearchResponse }>();
const MAX_CACHE_ENTRIES = 200;
const MAX_SEARCH_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_HTML_BYTES = 2 * 1024 * 1024;

function cloneSearchResponse(value: WebSearchResponse): WebSearchResponse {
  return structuredClone(value);
}

function pruneSearchCache(): void {
  const timestamp = Date.now();
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= timestamp) searchCache.delete(key);
  }
  while (searchCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = searchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    searchCache.delete(oldestKey);
  }
}

function cacheSearchResponse(
  key: string,
  value: WebSearchResponse,
  ttlMs: number
): void {
  pruneSearchCache();
  searchCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value: cloneSearchResponse(value),
  });
}

export function getSearchCacheStats(): { entries: number; maxEntries: number } {
  pruneSearchCache();
  return { entries: searchCache.size, maxEntries: MAX_CACHE_ENTRIES };
}



function getSearchProvider(): SearchProvider {
  const provider = (process.env.WEB_SEARCH_PROVIDER ?? "auto").toLowerCase();
  if (["auto", "tavily", "brave", "html"].includes(provider)) {
    return provider as SearchProvider;
  }
  return "auto";
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function resolveDuckDuckGoURL(rawURL: string): string {
  if (!rawURL) {
    return rawURL;
  }

  try {
    const url = new URL(rawURL, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return rawURL;
  }
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isLikelyAd(title: string, url: string): boolean {
  return (
    url.includes("duckduckgo.com/y.js") ||
    url.includes("ad_domain=") ||
    url.includes("ad_provider=") ||
    title.toLowerCase().includes("sponsored")
  );
}

function classifySource(url: string): WebSearchResult["sourceType"] {
  const hostname = getHostname(url);

  if (/github\.com|gitlab\.com|npmjs\.com|pypi\.org/.test(hostname)) {
    return "code";
  }

  if (/arxiv\.org|doi\.org|acm\.org|ieee\.org|nature\.com|science\.org/.test(hostname)) {
    return "paper";
  }

  if (
    /news|sina\.cn|sina\.com|huxiu\.com|36kr\.com|thepaper\.cn|reuters\.com|bloomberg\.com|techcrunch\.com/.test(
      hostname
    )
  ) {
    return "news";
  }

  if (/douyin\.com|bilibili\.com|youtube\.com|x\.com|twitter\.com|weibo\.com|zhihu\.com/.test(hostname)) {
    return "social";
  }

  if (/\.org$|\.edu$|docs\.|developer\.|download|official/.test(hostname)) {
    return "official";
  }

  return "general";
}





/** 来源分级：给不同站点赋予权威性权重 */
function sourceAuthority(url: string): number {
  const hostname = getHostname(url);
  // 政府官网 — 最高权威
  if (/\.gov\.cn$|\.gov$/.test(hostname)) return 20;
  // 教育机构
  if (/\.edu\.cn$|\.edu$/.test(hostname)) return 15;
  // 百科
  if (/baike\.baidu\.com|wikipedia\.org|zh\.wikipedia/.test(hostname)) return 14;
  // 学术
  if (/arxiv\.org|scholar\.google\.com|doi\.org|acm\.org|ieee\.org|nature\.com|science\.org/.test(hostname)) return 13;
  // 国际权威媒体
  if (/reuters\.com|bloomberg\.com|apnews\.com|bbc\.com|nytimes\.com/.test(hostname)) return 10;
  // 国内权威媒体
  if (/people\.com\.cn|xinhuanet\.com|cctv\.com|chinanews\.com|gmw\.cn|ce\.cn|youth\.cn/.test(hostname)) return 10;
  // 专业领域平台
  if (/36kr\.com|huxiu\.com|thepaper\.cn|geekpark\.net|infoq\.cn|oschina\.net|csdn\.net|zhihu\.com/.test(hostname)) return 6;
  // 一般媒体
  if (/sina\.com\.cn|sina\.cn|sohu\.com|163\.com|qq\.com|ifeng\.com/.test(hostname)) return 4;
  // 官方文档/代码托管
  if (/github\.com|gitlab\.com|npmjs\.com|pypi\.org|docs\.|developer\./.test(hostname)) return 8;
  // 社交 — 低权威
  if (/bilibili\.com|douyin\.com|youtube\.com|x\.com|twitter\.com|weibo\.com|xiaohongshu\.com/.test(hostname)) return 1;
  return 3;
}

/** 检测营销/推广内容 */
function isSponsoredContent(title: string, snippet: string, url: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  const hostname = getHostname(url);

  // 营销关键词检测
  const sponsorPatterns = [
    /广告|推广|sponsored|promoted/i,
    /限时.*(?:优惠|折扣|抢购|秒杀)/i,
    /点击.*(?:购买|下单|领取)/i,
    /满.*减|优惠券|代金券/i,
    /(?:免费|0元).*(?:领取|获取|试用)/i,
    /(?:立即|马上).*(?:购买|抢购|下单)/i,
    /推荐.*(?:产品|商品|好物).*(?:购买|链接)/i,
    /(?:最后|仅剩).*(?:几天|名额|机会)/i,
  ];

  let matchCount = 0;
  for (const p of sponsorPatterns) {
    if (p.test(text)) matchCount++;
  }

  // 3 条以上营销特征 → 判定为推广内容
  return matchCount >= 3;
}

function scoreResult(
  result: Omit<WebSearchResult, "score">,
  intent: SearchIntent,
  queryTerms: string[]
): number {
  const hostname = getHostname(result.url);
  const combined = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  let score = 0;

  // 关键词匹配
  for (const term of queryTerms) {
    if (term && combined.includes(term.toLowerCase())) {
      score += 4;
    }
  }

  // 来源权威性（核心新增）
  score += sourceAuthority(result.url);

  // intent 匹配加权
  if (intent === "official" && result.sourceType === "official") score += 12;
  if (result.sourceType === "news") score += 12;
  if (intent === "paper" && result.sourceType === "paper") score += 12;
  if (intent === "technical" && result.sourceType === "code") score += 10;
  if (intent === "product" && result.sourceType === "official") score += 8;
  if (intent === "news" && /people\.com\.cn|xinhuanet\.com|reuters|bloomberg/.test(hostname)) score += 6;

  // 内容信号
  if (/docs|documentation|文档|官网|official/.test(combined)) score += 5;
  if (/github\.com|bailongma\.top|nodejs\.org|openai\.com/.test(hostname)) score += 5;

  // 时效性匹配
  for (const term of queryTerms) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(term)) {
      const [year, month, day] = term.split("-");
      const chineseDate = `${year}年${month}月${day}日`;
      const dottedDate = `${year}.${month}.${day}`;
      const compactDate = `${year}${month}${day}`;
      if (
        combined.includes(term) ||
        combined.includes(chineseDate.toLowerCase()) ||
        combined.includes(dottedDate) ||
        combined.includes(compactDate)
      ) {
        score += 8;
      }

      const otherDatePattern =
        /20\d{2}[-年.]\d{1,2}[-月.]\d{1,2}日?|20\d{6}/g;
      const datesInResult = combined.match(otherDatePattern) ?? [];
      const desiredDates = new Set([
        term,
        chineseDate.toLowerCase(),
        dottedDate,
        compactDate,
      ]);
      for (const date of datesInResult) {
        if (!desiredDates.has(date.toLowerCase())) {
          score -= 10;
        }
      }
    }
  }

  // 降权
  if (result.sourceType === "social") score -= 3;
  if (isSponsoredContent(result.title, result.snippet, result.url)) score -= 15;
  if (/login|signin|账户|广告/.test(combined)) score -= 5;

  return score;
}

function extractQueryTerms(queries: string[]): string[] {
  const joinedQueries = queries.join(" ");
  const dates = joinedQueries.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  return Array.from(
    new Set(
      joinedQueries
        .split(/[\s,，。！？?;；:："'“”‘’()（）[\]{}<>《》/\\|+-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .concat(dates)
        .slice(0, 20)
    )
  );
}

function getRequiredResultPattern(queries: string[]): RegExp | null {
  const joinedQueries = queries.join(" ");
  if (/政治|时政/i.test(joinedQueries)) {
    return /政治|时政|外交|政府|国会|议会|选举|白宫|总统|总理|首相|部长|国务院|人大|政协|国际关系|地缘|policy|politics|government|election/i;
  }

  if (/ai|人工智能/i.test(joinedQueries) && /新闻|热点|资讯|today|latest/i.test(joinedQueries)) {
    return /(^|[^a-z])ai([^a-z]|$)|人工智能|大模型|openai|anthropic|agent|算力|芯片/i;
  }

  if (/bailongma/i.test(joinedQueries)) {
    return /bailongma|白龙马.*(agent|智能体|ai|官网|文档)|白龙马ai/i;
  }

  if (joinedQueries.includes("银狼")) {
    return /银狼|silver wolf/i;
  }

  return null;
}





function cacheKey(queries: string[], intent: SearchIntent, maxResults: number): string {
  return JSON.stringify([queries.map((query) => query.toLowerCase()), intent, maxResults]);
}

function resultConfidence(result: WebSearchResult): number {
  const typeBase = {
    official: 0.94,
    paper: 0.9,
    code: 0.82,
    news: 0.78,
    general: 0.62,
    social: 0.45,
  }[result.sourceType];
  return Math.max(0.1, Math.min(0.99, typeBase + Math.min(result.score, 40) / 200));
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const searchURL = new URL("https://duckduckgo.com/html/");
  searchURL.searchParams.set("q", query);

  const response = await fetchWithTimeout(searchURL, 12000, { signal });
  if (!response.ok) {
    throw new Error(`联网搜索失败: HTTP ${response.status}`);
  }

  const html = await readResponseText(response, MAX_SEARCH_HTML_BYTES, 12000, signal);
  const $ = cheerio.load(html);
  const results: WebSearchResult[] = [];

  $(".result").each((_, element) => {
    if (results.length >= SEARCH_RESULTS_PER_QUERY) {
      return false;
    }

    const titleElement = $(element).find(".result__a").first();
    const title = cleanText(titleElement.text());
    const url = resolveDuckDuckGoURL(titleElement.attr("href") ?? "");
    const snippet = cleanText($(element).find(".result__snippet").text());

    if (title && url && !isLikelyAd(title, url)) {
      results.push({
        title,
        url,
        snippet,
        sourceType: classifySource(url),
        score: 0,
      });
    }

    return undefined;
  });

  return results;
}

async function searchBing(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const searchURL = new URL("https://www.bing.com/search");
  searchURL.searchParams.set("q", query);
  searchURL.searchParams.set("setlang", "zh-CN");

  const response = await fetchWithTimeout(searchURL, 12000, { signal });
  if (!response.ok) {
    throw new Error(`Bing 搜索失败: HTTP ${response.status}`);
  }

  const html = await readResponseText(response, MAX_SEARCH_HTML_BYTES, 12000, signal);
  const $ = cheerio.load(html);
  const results: WebSearchResult[] = [];

  $("#b_results .b_algo").each((_, element) => {
    if (results.length >= SEARCH_RESULTS_PER_QUERY) {
      return false;
    }

    const titleElement = $(element).find("h2 a").first();
    const title = cleanText(titleElement.text());
    const url = titleElement.attr("href") ?? "";
    const snippet = cleanText($(element).find(".b_caption p").first().text());

    if (title && url && !isLikelyAd(title, url)) {
      results.push({
        title,
        url,
        snippet,
        sourceType: classifySource(url),
        score: 0,
      });
    }

    return undefined;
  });

  return results;
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

async function searchTavily(
  queries: string[],
  maxResults: number,
  intent: SearchIntent,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    logger.debug("web-search", "skip tavily: missing api key");
    return [];
  }

  const topic = "general";
  const settled = await Promise.allSettled(
    queries.map(async (query) => {
      const response = await withRetry("tavily-query", () => fetchWithTimeout(
        "https://api.tavily.com/search",
        config.search.timeoutMs,
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query,
            topic,
            search_depth: "basic",
            max_results: maxResults,
            include_answer: false,
            include_raw_content: "text",
          }),
        }
      ), signal);

      if (!response.ok) {
        throw new Error(`Tavily 搜索失败: HTTP ${response.status}`);
      }

      const data = (await response.json()) as TavilySearchResponse;
      return (data.results ?? []).flatMap((result): WebSearchResult[] => {
        if (!result.title || !result.url) {
          return [];
        }

        return [
          {
            title: cleanText(result.title),
            url: result.url,
            snippet: cleanText(result.content ?? ""),
            content: result.raw_content
              ? truncate(cleanText(result.raw_content), MAX_CONTENT_CHARS)
              : undefined,
            sourceType: classifySource(result.url),
            score: Math.round((result.score ?? 0) * 100),
          },
        ];
      });
    })
  );

  const failures = settled.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    logger.warn("web-search", "tavily query failed", {
      error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
    });
  }

  signal?.throwIfAborted();

  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

async function searchBrave(
  queries: string[],
  maxResults: number,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    logger.debug("web-search", "skip brave: missing api key");
    return [];
  }

  const settled = await Promise.allSettled(
    queries.map(async (query) => {
      const searchURL = new URL("https://api.search.brave.com/res/v1/web/search");
      searchURL.searchParams.set("q", query);
      searchURL.searchParams.set("count", String(Math.min(maxResults, 10)));
      searchURL.searchParams.set("search_lang", "zh-hans");
      searchURL.searchParams.set("safesearch", "moderate");

      const response = await withRetry("brave-query", () => fetchWithTimeout(searchURL, config.search.timeoutMs, {
        signal,
        headers: {
          "X-Subscription-Token": apiKey,
          Accept: "application/json",
        },
      }), signal);

      if (!response.ok) {
        throw new Error(`Brave 搜索失败: HTTP ${response.status}`);
      }

      const data = (await response.json()) as BraveSearchResponse;
      return (data.web?.results ?? []).flatMap((result): WebSearchResult[] => {
        if (!result.title || !result.url) {
          return [];
        }

        return [
          {
            title: cleanText(result.title),
            url: result.url,
            snippet: cleanText(result.description ?? ""),
            sourceType: classifySource(result.url),
            score: 0,
          },
        ];
      });
    })
  );

  const failures = settled.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    logger.warn("web-search", "brave query failed", {
      error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
    });
  }

  signal?.throwIfAborted();

  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
}

async function searchOneQuery(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  // 并行搜索 DuckDuckGo 和 Bing，避免 DuckDuckGo 不可达时等待超时
  const [duckSettled, bingSettled] = await Promise.allSettled([
    searchDuckDuckGo(query, signal),
    searchBing(query, signal),
  ]);

  if (duckSettled.status === "rejected" && duckSettled.reason !== null) {
    const error = duckSettled.reason instanceof Error ? duckSettled.reason : new Error(String(duckSettled.reason));
    if (!signal?.aborted) {
      logger.warn("web-search", "duckduckgo query failed", {
        query,
        error: error.message,
      });
    }
  }

  if (bingSettled.status === "rejected" && bingSettled.reason !== null) {
    const error = bingSettled.reason instanceof Error ? bingSettled.reason : new Error(String(bingSettled.reason));
    if (!signal?.aborted) {
      logger.warn("web-search", "bing query failed", {
        query,
        error: error.message,
      });
    }
  }

  const duckResults = duckSettled.status === "fulfilled" ? duckSettled.value : [];
  const bingResults = bingSettled.status === "fulfilled" ? bingSettled.value : [];
  return [...duckResults, ...bingResults];
}

async function fetchReadableContent(url: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    if (!(await resolvesToPublicHttpTarget(url))) {
      logger.warn("web-search", "blocked unsafe content URL", { url });
      return undefined;
    }

    let currentUrl = url;
    let response: Awaited<ReturnType<typeof fetchWithTimeout>> | undefined;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      response = await fetchWithTimeout(currentUrl, 10000, {
        signal,
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) return undefined;
      const nextUrl = new URL(location, currentUrl).toString();
      if (
        !isSafePublicHttpUrl(nextUrl) ||
        !(await resolvesToPublicHttpTarget(nextUrl))
      ) {
        logger.warn("web-search", "blocked unsafe content redirect", {
          from: currentUrl,
          to: nextUrl,
        });
        return undefined;
      }
      currentUrl = nextUrl;
      response = undefined;
    }
    if (!response) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/html")) {
      return undefined;
    }

    const html = await readResponseText(
      response,
      MAX_ARTICLE_HTML_BYTES,
      10000,
      signal
    );
    const $ = cheerio.load(html);
    $("script, style, noscript, svg, nav, footer, header, aside, form").remove();

    const title = cleanText($("title").first().text());
    const metaDescription = cleanText(
      $('meta[name="description"]').attr("content") ?? ""
    );
    const mainText = cleanText(
      $("article").text() || $("main").text() || $("body").text()
    );
    const content = cleanText([title, metaDescription, mainText].join("\n"));
    return content ? truncate(content, MAX_CONTENT_CHARS) : undefined;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    logger.debug("web-search", "fetch readable content failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function dedupeAndRank(
  results: WebSearchResult[],
  queries: string[],
  intent: SearchIntent,
  maxResults: number
): WebSearchResult[] {
  const queryRequiresBaiLongma = /白龙马|bailongma/i.test(queries.join(" "));
  const requiredPattern = getRequiredResultPattern(queries);
  const byUrl = new Map<string, WebSearchResult>();
  const queryTerms = extractQueryTerms(queries);

  const rejectedByRequiredPattern: WebSearchResult[] = [];

  for (const result of results) {
    const normalizedURL = result.url.replace(/#.*$/, "");
    const combinedText = `${result.title} ${result.url} ${result.snippet}`;
    if (queryRequiresBaiLongma && !/白龙马|bailongma/i.test(combinedText)) {
      continue;
    }
    if (requiredPattern && !requiredPattern.test(combinedText)) {
      rejectedByRequiredPattern.push(result);
      continue;
    }

    const scored: WebSearchResult = {
      ...result,
      url: normalizedURL,
      score: scoreResult(result, intent, queryTerms),
    };
    const existing = byUrl.get(normalizedURL);
    if (!existing || scored.score > existing.score) {
      byUrl.set(normalizedURL, scored);
    }
  }

  let ranked = Array.from(byUrl.values())
    .filter((result) => !requiredPattern || result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (ranked.length === 0 && requiredPattern) {
    const fallbackByUrl = new Map<string, WebSearchResult>();
    for (const result of rejectedByRequiredPattern) {
      const normalizedURL = result.url.replace(/#.*$/, "");
      const combinedText = `${result.title} ${result.url} ${result.snippet}`;
      if (!/bilibili|douyin|nga|sohu|163|github|bailongma|pixiv|ihuaben|fanqienovel/i.test(combinedText)) {
        continue;
      }
      const scored = {
        ...result,
        url: normalizedURL,
        score: scoreResult(result, intent, queryTerms) - 4,
      };
      const existing = fallbackByUrl.get(normalizedURL);
      if (!existing || scored.score > existing.score) {
        fallbackByUrl.set(normalizedURL, scored);
      }
    }

    ranked = Array.from(fallbackByUrl.values())
      .filter((result) => {
        if (queries.join(" ").includes("银狼")) {
          return /银狼|silver wolf/i.test(
            `${result.title} ${result.url} ${result.snippet}`
          );
        }
        return result.score > 0;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  return ranked;
}

// ── 冲突信息校验 ────────────────────────────────────────────────

/** 从文本中提取数值型事实（价格、年份、百分比、规格参数） */
function extractFactualClaims(text: string): string[] {
  const claims: string[] = [];
  // 价格
  const prices = text.match(/\d{1,6}\s*(?:元|块|美金|美元|欧元|¥|\$|欧元)/g);
  if (prices) claims.push(...prices);
  // 年份
  const years = text.match(/20\d{2}\s*年/g);
  if (years) claims.push(...years);
  // 百分比
  const pcts = text.match(/\d+(?:\.\d+)?%/g);
  if (pcts) claims.push(...pcts);
  // 规格数值（GB/TB/GHz/cm/kg）
  const specs = text.match(/\d+(?:\.\d+)?\s*(?:GB|TB|GHz|MHz|cm|kg|mm|英寸)/g);
  if (specs) claims.push(...specs);
  return claims;
}

/** 合并互相矛盾的结果 — 优先保留官方/最新/高置信度来源 */
function reconcileConflicts(results: WebSearchResult[]): WebSearchResult[] {
  if (results.length < 2) return results;

  // 按页面主体内容分组（取出标题核心词，去掉来源名称）
  const groups = new Map<string, WebSearchResult[]>();
  for (const r of results) {
    // 取标题中的实体关键词作为分组依据
    const titleKey = r.title
      .replace(/[-–—|·•]\s*.*$/, "")        // 去掉后缀来源
      .replace(/[\s\-–—|·•]/g, "")
      .slice(0, 12);
    if (!titleKey) continue;
    const existing = groups.get(titleKey) ?? [];
    existing.push(r);
    groups.set(titleKey, existing);
  }

  const reconciled: WebSearchResult[] = [];

  for (const [, group] of groups) {
    if (group.length <= 1) {
      reconciled.push(...group);
      continue;
    }

    // 提取事实断言
    const allClaims = group.map((r) => ({
      result: r,
      claims: extractFactualClaims(`${r.title} ${r.snippet} ${r.content ?? ""}`),
    }));

    // 检测矛盾：同一分组内出现同一量纲但数值不同
    const hasConflict = (() => {
      const allPriceClaims = allClaims.flatMap((c) => c.claims);
      if (allPriceClaims.length < 2) return false;
      // 价格矛盾检测
      const prices = allPriceClaims
        .map((c) => c.match(/(\d+(?:\.\d+)?)/)?.[1])
        .filter(Boolean)
        .map(Number);
      if (prices.length >= 2) {
        const max = Math.max(...prices);
        const min = Math.min(...prices);
        if (max > 0 && min > 0 && max / min > 1.1) return true; // 超过10%差异
      }
      return false;
    })();

    if (!hasConflict) {
      reconciled.push(...group);
      continue;
    }

    // 有冲突时按权威性+时效性排序，取 top
    const scored = group.map((r) => ({
      result: r,
      authority: sourceAuthority(r.url),
      hasRecentDate: /\b202[5-9]\b/.test(`${r.title} ${r.snippet}`) ? 5 : 0,
      hasContent: r.content ? 3 : 0,
    }));
    scored.sort((a, b) => (b.authority + b.hasRecentDate + b.hasContent) - (a.authority + a.hasRecentDate + a.hasContent));
    // 取第一名权威来源，再加一个补充来源（如果存在不同角度的）
    reconciled.push(scored[0].result);
    if (scored.length > 1) {
      // 找第二个源：与第一名权威性差异 >5 且非同一域名
      const second = scored.find(
        (s) => (scored[0].authority - s.authority) <= 5 && getHostname(s.result.url) !== getHostname(scored[0].result.url)
      );
      if (second) reconciled.push(second.result);
    }
  }

  return reconciled;
}

export async function searchWeb(
  queryOrQueries: string | string[],
  maxResults = DEFAULT_MAX_RESULTS,
  intent: SearchIntent = "general",
  options: WebSearchOptions = {}
): Promise<WebSearchResponse> {
  const queries = (Array.isArray(queryOrQueries) ? queryOrQueries : [queryOrQueries])
    .map((query) => query.trim())
    .filter(Boolean);

  if (queries.length === 0) {
    return { query: "", queries: [], intent, results: [], provider: "html", fetchedAt: new Date().toISOString(), fromCache: false };
  }

  const key = cacheKey(queries, intent, maxResults);
  pruneSearchCache();
  const cached = searchCache.get(key);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) {
    logger.info("web-search", "cache hit", { intent, queries });
    const cachedValue = cloneSearchResponse(cached.value);
    cachedValue.fromCache = true;
    return cachedValue;
  }

  options.signal?.throwIfAborted();

  const provider = getSearchProvider();
  let usedProvider: WebSearchResponse["provider"] = "html";
  let rawResults: WebSearchResult[] = [];
  logger.info("web-search", "search started", {
    provider,
    intent,
    maxResults,
    queries,
    proxyEnabled: Boolean(process.env.WEB_SEARCH_PROXY_URL || process.env.LLM_PROXY_URL),
  });

  if (provider === "tavily" || provider === "auto") {
    rawResults = await withRetry("tavily", () => searchTavily(queries, maxResults, intent, options.signal), options.signal);
    if (rawResults.length > 0) usedProvider = "tavily";
    logger.info("web-search", "tavily completed", {
      results: rawResults.length,
    });
  }

  if (rawResults.length === 0 && (provider === "brave" || provider === "auto")) {
    rawResults = await withRetry("brave", () => searchBrave(queries, maxResults, options.signal), options.signal);
    if (rawResults.length > 0) usedProvider = "brave";
    logger.info("web-search", "brave completed", {
      results: rawResults.length,
    });
  }

  if (rawResults.length === 0 && (provider === "html" || provider === "auto")) {
    const settledSearches = await Promise.allSettled(
      queries.map((query) => searchOneQuery(query, options.signal))
    );
    usedProvider = "html";
    rawResults = settledSearches.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    );
    options.signal?.throwIfAborted();
    logger.info("web-search", "html search completed", {
      results: rawResults.length,
      failedQueries: settledSearches.filter((result) => result.status === "rejected").length,
    });
  }

  const rankedResults = dedupeAndRank(rawResults, queries, intent, maxResults);
  logger.info("web-search", "search ranked", {
    rawResults: rawResults.length,
    rankedResults: rankedResults.length,
    topResults: rankedResults.map((result) => ({
      title: result.title,
      url: result.url,
      type: result.sourceType,
      score: result.score,
    })),
  });

  // 冲突信息校验 — 矛盾时择优保留
  const reconciledResults = reconcileConflicts(rankedResults);
  if (reconciledResults.length !== rankedResults.length) {
    logger.info("web-search", "conflict reconciliation applied", {
      before: rankedResults.length,
      after: reconciledResults.length,
    });
  }

  const withContent = await Promise.all(
    reconciledResults.map(async (result, index) => {
      if (index >= FETCH_CONTENT_RESULTS) {
        return result;
      }

      const content = await fetchReadableContent(result.url, options.signal);
      return content ? { ...result, content } : result;
    })
  );

  const response: WebSearchResponse = {
    query: queries[0] ?? "",
    queries,
    intent,
    results: withContent.map((result) => ({ ...result, confidence: resultConfidence(result) })),
    provider: usedProvider,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
  cacheSearchResponse(key, response, config.search.cacheTtlMs);
  return response;
}
