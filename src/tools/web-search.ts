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
import { fetch, ProxyAgent } from "undici";
import { logger } from "../logger.js";
import { config } from "../config.js";
import type { SearchIntent } from "./tool-router.js";
import { usAqiText } from "../utils/air-quality.js";
import {
  isSafePublicHttpUrl,
  readResponseText,
  resolvesToPublicHttpTarget,
} from "./network-safety.js";

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
  provider: "weather" | "tavily" | "brave" | "html";
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
const NEWS_INDEX_RESULTS = 12;
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

function getDispatcher(): ProxyAgent | undefined {
  const proxyURL =
    process.env.WEB_SEARCH_PROXY_URL || process.env.LLM_PROXY_URL || "";
  return proxyURL ? new ProxyAgent(proxyURL) : undefined;
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

function isNewsIndexQuery(queries: string[]): boolean {
  return /今天|今日|实时|头条|国内|国际|新闻联播|20\d{2}-\d{2}-\d{2}|20\d{2}年\d{2}月\d{2}日/i.test(
    queries.join(" ")
  );
}

function isNoisyNewsTitle(title: string): boolean {
  return /登录|注册|广告|专题|直播回放|客户端|更多|图片|视频|是什么年|节假日安排|新年贺词|全国两会专题|百度百科/i.test(
    title
  );
}

function scoreResult(
  result: Omit<WebSearchResult, "score">,
  intent: SearchIntent,
  queryTerms: string[]
): number {
  const hostname = getHostname(result.url);
  const combined = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    if (term && combined.includes(term.toLowerCase())) {
      score += 4;
    }
  }

  if (intent === "official" && result.sourceType === "official") score += 12;
  if (intent === "news" && result.sourceType === "news") score += 12;
  if (intent === "paper" && result.sourceType === "paper") score += 12;
  if (intent === "technical" && result.sourceType === "code") score += 10;
  if (intent === "product" && result.sourceType === "official") score += 8;

  if (/docs|documentation|文档|官网|official/.test(combined)) score += 5;
  if (/github\.com|bailongma\.top|nodejs\.org|openai\.com/.test(hostname)) score += 5;
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
  if (result.sourceType === "social") score -= 3;
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

async function fetchWithTimeout(
  url: URL | string,
  timeoutMs: number,
  init: Parameters<typeof fetch>[1] = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    return await fetch(url, {
      ...init,
      dispatcher: getDispatcher(),
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.search.retries; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === config.search.retries) throw error;
      logger.warn("web-search", "provider retry", {
        provider: label,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250 * (attempt + 1));
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    }
  }
  throw lastError;
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

interface OpenMeteoGeocodingResult {
  id?: number;
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
  timezone?: string;
}

interface OpenMeteoGeocodingResponse {
  results?: OpenMeteoGeocodingResult[];
}

interface OpenMeteoForecastResponse {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    rain?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
  };
}

interface OpenMeteoAirQualityResponse {
  current?: {
    time?: string;
    us_aqi?: number;
    pm2_5?: number;
    pm10?: number;
  };
}

function weatherCodeText(code?: number): string {
  if (code === undefined) return "未知";
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67].includes(code)) return "雨";
  if ([71, 73, 75, 77].includes(code)) return "雪";
  if ([80, 81, 82].includes(code)) return "阵雨";
  if ([85, 86].includes(code)) return "阵雪";
  if ([95, 96, 99].includes(code)) return "雷暴";
  return `天气代码 ${code}`;
}

function extractWeatherLocation(queries: string[]): string {
  const first = queries[0] ?? "";
  return first
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/今天|今日|明天|明日|后天|后日|现在|实时|天气预报|天气|气温|温度|空气质量/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function weatherForecastIndex(queries: string[]): number {
  const queryText = queries.join(" ");
  if (/后天|后日/.test(queryText)) return 2;
  if (/明天|明日/.test(queryText)) return 1;
  return 0;
}

async function searchOpenMeteoWeather(
  queries: string[],
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const location = extractWeatherLocation(queries);
  if (!location) {
    logger.warn("weather", "missing location", { queries });
    return [];
  }

  const geocodingURL = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodingURL.searchParams.set("name", location);
  geocodingURL.searchParams.set("count", "5");
  geocodingURL.searchParams.set("language", "zh");
  geocodingURL.searchParams.set("format", "json");

  const geocodingResponse = await fetchWithTimeout(geocodingURL, 12000, { signal });
  if (!geocodingResponse.ok) {
    throw new Error(`天气地点查询失败: HTTP ${geocodingResponse.status}`);
  }

  const geocoding = (await geocodingResponse.json()) as OpenMeteoGeocodingResponse;
  const candidates = geocoding.results ?? [];
  const place =
    candidates.find((item) => item.name === location && item.country === "中国") ??
    candidates.find((item) => item.country === "中国") ??
    candidates[0];

  if (!place?.name || place.latitude === undefined || place.longitude === undefined) {
    logger.warn("weather", "location not found", { location });
    return [];
  }

  const forecastURL = new URL("https://api.open-meteo.com/v1/forecast");
  forecastURL.searchParams.set("latitude", String(place.latitude));
  forecastURL.searchParams.set("longitude", String(place.longitude));
  forecastURL.searchParams.set("timezone", "auto");
  forecastURL.searchParams.set("forecast_days", "3");
  forecastURL.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m"
  );
  forecastURL.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max"
  );

  const forecastResponse = await fetchWithTimeout(forecastURL, 12000, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!forecastResponse.ok) {
    throw new Error(`天气预报查询失败: HTTP ${forecastResponse.status}`);
  }

  const forecast = (await forecastResponse.json()) as OpenMeteoForecastResponse;
  const current = forecast.current;
  const daily = forecast.daily;
  let airQuality: OpenMeteoAirQualityResponse["current"];
  if (/空气质量|aqi|pm\s*2[._]?5|pm10/i.test(queries.join(" "))) {
    try {
      const airQualityURL = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
      airQualityURL.searchParams.set("latitude", String(place.latitude));
      airQualityURL.searchParams.set("longitude", String(place.longitude));
      airQualityURL.searchParams.set("timezone", "auto");
      airQualityURL.searchParams.set("current", "us_aqi,pm2_5,pm10");
      const airQualityResponse = await fetchWithTimeout(airQualityURL, 12000, {
        signal,
        headers: { Accept: "application/json" },
      });
      if (airQualityResponse.ok) {
        airQuality = ((await airQualityResponse.json()) as OpenMeteoAirQualityResponse).current;
      } else {
        logger.warn("weather", "air quality query failed", {
          status: airQualityResponse.status,
          location,
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn("weather", "air quality query failed", {
        location,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const forecastIndex = weatherForecastIndex(queries);
  const forecastLabel = ["今日", "明日", "后日"][forecastIndex];
  const forecastDate = daily?.time?.[forecastIndex] ?? "未知日期";
  const displayName = [place.name, place.admin1, place.country]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("，");
  const summary = [
    `地点：${displayName}`,
    `观测时间：${current?.time ?? "未知"}（${forecast.timezone ?? place.timezone ?? "当地时区"}）`,
    forecastIndex === 0
      ? `当前：${weatherCodeText(current?.weather_code)}，${current?.temperature_2m ?? "未知"}°C，体感 ${current?.apparent_temperature ?? "未知"}°C，降水 ${current?.precipitation ?? 0} mm，风速 ${current?.wind_speed_10m ?? "未知"} km/h`
      : "",
    `${forecastLabel}（${forecastDate}）：${weatherCodeText(daily?.weather_code?.[forecastIndex])}，${daily?.temperature_2m_min?.[forecastIndex] ?? "未知"}~${daily?.temperature_2m_max?.[forecastIndex] ?? "未知"}°C`,
    `${forecastLabel}最高降水概率：${daily?.precipitation_probability_max?.[forecastIndex] ?? "未知"}%`,
    `${forecastLabel}预计降水量：${daily?.precipitation_sum?.[forecastIndex] ?? "未知"} mm，最大风速 ${daily?.wind_speed_10m_max?.[forecastIndex] ?? "未知"} km/h`,
    airQuality
      ? `空气质量（${airQuality.time ?? "当前"}）：美标 AQI ${airQuality.us_aqi ?? "未知"}（${usAqiText(airQuality.us_aqi)}），PM2.5 ${airQuality.pm2_5 ?? "未知"} μg/m³，PM10 ${airQuality.pm10 ?? "未知"} μg/m³`
      : "",
  ].filter(Boolean).join("；");

  logger.info("weather", "forecast completed", {
    requestedLocation: location,
    resolvedLocation: displayName,
    latitude: place.latitude,
    longitude: place.longitude,
    observationTime: current?.time,
  });

  return [
    {
      title:
        forecastIndex === 0
          ? `${place.name}实时天气与今日预报`
          : `${place.name}${forecastLabel}天气预报`,
      url: forecastURL.toString(),
      snippet: summary,
      content: summary,
      sourceType: "official",
      score: 100,
      metadata: {
        location: `${place.name}${place.admin1 ? `，${place.admin1}` : ""}${place.country ? `，${place.country}` : ""}`,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: forecast.timezone,
        observationTime: current?.time,
        forecastDate,
        forecastDayOffset: forecastIndex,
        usAqi: airQuality?.us_aqi,
        pm25: airQuality?.pm2_5,
        pm10: airQuality?.pm10,
        temperatureC: current?.temperature_2m,
        apparentTemperatureC: current?.apparent_temperature,
        precipitationMm: current?.precipitation,
        rainMm: current?.rain,
        windSpeedKmh: current?.wind_speed_10m,
        windDirection: current?.wind_direction_10m,
        weatherCode: current?.weather_code,
        minTemperatureC: daily?.temperature_2m_min?.[forecastIndex],
        maxTemperatureC: daily?.temperature_2m_max?.[forecastIndex],
        precipitationProbability:
          daily?.precipitation_probability_max?.[forecastIndex],
        precipitationSumMm: daily?.precipitation_sum?.[forecastIndex],
      },
    },
  ];
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

  const topic = intent === "news" ? "news" : "general";
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
  const duckResults = await searchDuckDuckGo(query, signal).catch((error) => {
    if (signal?.aborted) throw error;
    logger.warn("web-search", "duckduckgo query failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  if (duckResults.length >= 3) {
    return duckResults;
  }

  const bingResults = await searchBing(query, signal).catch((error) => {
    if (signal?.aborted) throw error;
    logger.warn("web-search", "bing query failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
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

async function fetchNewsIndexResults(signal?: AbortSignal): Promise<WebSearchResult[]> {
  const pages = [
    "https://news.cctv.com/",
    "https://www.news.cn/",
    "https://www.chinanews.com.cn/",
    "https://news.sina.com.cn/",
  ];

  const settled = await Promise.allSettled(
    pages.map(async (pageURL) => {
      const response = await fetchWithTimeout(pageURL, 12000, { signal });
      if (!response.ok) {
        return [];
      }

      const html = await readResponseText(
        response,
        MAX_SEARCH_HTML_BYTES,
        12000,
        signal
      );
      const $ = cheerio.load(html);
      const pageTitle = cleanText($("title").first().text());
      const results: WebSearchResult[] = [];

      $("a").each((_, element) => {
        if (results.length >= NEWS_INDEX_RESULTS) {
          return false;
        }

        const title = cleanText($(element).text());
        const href = $(element).attr("href") ?? "";
        if (title.length < 8 || title.length > 80 || isNoisyNewsTitle(title)) {
          return undefined;
        }

        let url = "";
        try {
          url = new URL(href, pageURL).toString();
        } catch {
          return undefined;
        }

        const hostname = getHostname(url);
        if (!/cctv|news\.cn|xinhuanet|chinanews|sina/.test(hostname)) {
          return undefined;
        }

        results.push({
          title,
          url,
          snippet: pageTitle ? `来自新闻首页：${pageTitle}` : "来自新闻首页",
          sourceType: "news",
          score: 30,
        });
        return undefined;
      });

      return results;
    })
  );

  const failures = settled.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    logger.warn("web-search", "news index fetch failed", {
      error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
    });
  }

  signal?.throwIfAborted();

  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
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

  if (intent === "weather") {
    const results = await withRetry(
      "weather",
      () => searchOpenMeteoWeather(queries, options.signal),
      options.signal
    );
    const response: WebSearchResponse = {
      query: queries[0] ?? "",
      queries,
      intent,
      results: results.map((result) => ({ ...result, confidence: resultConfidence(result) })),
      provider: "weather",
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
    cacheSearchResponse(key, response, Math.min(config.search.cacheTtlMs, 10 * 60_000));
    return response;
  }

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

  if (intent === "news" && isNewsIndexQuery(queries)) {
    rawResults.push(...(await fetchNewsIndexResults(options.signal)));
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

  const withContent = await Promise.all(
    rankedResults.map(async (result, index) => {
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
