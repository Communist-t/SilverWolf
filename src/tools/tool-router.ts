/**
 * 工具调用判断层。
 *
 * 负责判断用户问题是否需要联网，并把自然语言问题改写成更适合搜索的查询。
 */

import {
  currentChineseDateInChina,
  currentDateInChina,
  currentYearInChina,
} from "../current-date.js";

export type SearchIntent =
  | "weather"
  | "news"
  | "official"
  | "technical"
  | "paper"
  | "product"
  | "general";

export interface ToolDecision {
  useWebSearch: boolean;
  query: string;
  queries: string[];
  intent: SearchIntent;
  reason: string;
  /** 安全拦截标记 — 命中违规话题时 true，调用方应跳过所有搜索直接拒绝 */
  safetyBlocked?: boolean;
  safetyReason?: string;
}

export interface ToolConversationContext {
  topic?: "hardware" | "news" | "general";
  facts?: string[];
  keywords?: string[];
  searchHints?: string[];
  userLocation?: string;
  weatherLocation?: string;
  travelDestination?: string;
}

const WEB_SEARCH_TRIGGERS = [
  "联网",
  "搜索",
  "搜一下",
  "查一下",
  "帮我查",
  "查询",
  "插叙",
  "最新",
  "实时",
  "新闻",
  "热点",
  "头条",
  "快讯",
  "资讯",
  "价格",
  "多少钱",
  "天气",
  "汇率",
  "股价",
  "赛程",
  "结果",
  "端午",
  "节日",
  "节假日",
  "放假",
  "发布",
  "官网",
  "资料",
  "论文",
  "文档",
  "开源",
  "GitHub",
  "current",
  "latest",
  "today",
  "news",
  "search",
  "look up",
];

const DIRECT_SEARCH_PREFIXES = [
  "/search",
  "搜索",
  "搜一下",
  "帮我查询",
  "查下",
  "查一下",
  "查询一下",
  "查询",
  "帮我查",
  "联网查",
];

const FILLER_PATTERNS = [
  /^[，,。.!！?？、\s]+/,
  /^(oi|喂|你好啊|你好|哈喽|嗨|你可以|你能|能不能|可以不可以|帮我查下|帮我查一下|帮我|麻烦你|要不|要不咱|咱|先|所以|那|那么|现在|这次|这个|这些信息|直接|再|给我|我也要|爱你|谢谢你|谢谢|看看|了解一下|了解|查查|搜搜|帮忙)[，,。.!！?？、\s]*/i,
  /^(一下|下|有关|关于|一个叫|叫|一下一个叫|一个)/,
  /^(吧|呗|啊|呢|呀|嘛|啦)+/,
  /(好不好|行不行|可以吗|咋样|怎么样|如何|爱你|谢谢你|谢谢|！！！|!!|!|。|，|,|\?|\？)+$/g,
  /^(一下|下|有关|关于|一个叫|叫|一下一个叫|一个)/,
  /(是干什么的|是做什么的|干什么的|做什么的|是什么|介绍一下|给我看看)$/g,
];

// ── 安全拦截规则（最高优先级，命中后完全跳过搜索） ──────────────

/** 触及这些话题直接拒绝搜索，不发起任何网络检索 */
const SAFETY_BLOCKED_PATTERNS: RegExp[] = [
  /如何制作.*(?:炸弹|火药|毒品|冰毒|海洛因|氰化物|毒药|违禁药物)/i,
  /(?:黑客|入侵|破解).*(?:银行|服务器|政府|公安|国防)/i,
  /(?:银行卡|信用卡|密码|验证码).*(?:盗|骗|复制|破解)/i,
  /(?:儿童|未成年人).*(?:色情|性|裸)/i,
  /(?:暴力|恐怖|袭击).*(?:教学|教程|方法|指南)/i,
  /(?:军用|军事).*(?:机密|保密|绝密|涉密)/i,
  /(?:个人隐私|人肉|开盒|社工).*(?:查询|搜索|查找|获取)/i,
  /(?:枪支|弹药|军火).*(?:购买|制造|交易)/i,
];

function safetyCheck(input: string): { blocked: boolean; reason?: string } {
  for (const pattern of SAFETY_BLOCKED_PATTERNS) {
    if (pattern.test(input)) {
      return {
        blocked: true,
        reason: `安全拦截：消息命中安全规则（${pattern.source.slice(0, 30)}）`,
      };
    }
  }
  return { blocked: false };
}

function stripSearchPrefix(input: string): string {
  let normalized = input.trim().replace(/插叙/g, "查询");
  for (const prefix of DIRECT_SEARCH_PREFIXES) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }

  for (let index = 0; index < 3; index += 1) {
    for (const pattern of FILLER_PATTERNS) {
      normalized = normalized.replace(pattern, "").trim();
    }
  }

  return normalized;
}

function cleanSearchQuery(value: string): string {
  return value
    .replace(/插叙/g, "查询")
    .replace(/\boi\b/gi, " ")
    .replace(/你好啊|你好|喂|哈喽|嗨|帮我查下|帮我查一下|帮我|查下|查一下|查询|我也要|了解一下|了解|最新的|最新|今天|今日|新闻|热点|吧|了|的/g, " ")
    .replace(/[，,。.!！?？、]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function currentDateForSearch(): string {
  return currentDateInChina();
}

function currentChineseDateForSearch(): string {
  return currentChineseDateInChina();
}

export function extractWeatherCity(input: string): string {
  const cleaned = input
    .replace(/\boi\b/gi, " ")
    .replace(
      /你帮我|帮我|麻烦你|请问|查一下|查下|查查|查询|搜一下|看看|看下|告诉我|我想知道|想知道|你好|自我介绍一下|介绍一下|然后|顺便|另外|再|一下|下/g,
      " "
    )
    .replace(/今天|今日|现在|当前|实时|明天|后天/g, " ")
    .replace(/天气预报|天气|气温|温度|多少度|几度|降雨|下雨|湿度|空气质量|预报/g, " ")
    .replace(/我在|人在|当地|这边|那边|会不会|会|怎么样|咋样|如何|吗|么/g, " ")
    .replace(/[的呀啊呢吧呗嘛啦哦哟哈]+/g, " ")
    .replace(/[，,。.!！?？、\s]+/g, " ")
    .trim();

  // 常见非城市短词黑名单
  const NON_CITY_WORDS = new Set(["一下", "下", "一下下", "这个", "那个", "哪个", "什么"]);
  const candidates = (cleaned.match(/[\u4e00-\u9fa5]{2,12}/g) ?? [])
    .filter((w) => !NON_CITY_WORDS.has(w));
  const city = candidates.at(-1) ?? "";
  if (city) return city.replace(/市$/, "");
  return cleaned.match(/[a-z][a-z .'-]{1,40}/i)?.[0]?.trim() ?? "";
}

function weatherDayLabel(input: string): "今日" | "明日" | "后日" {
  if (/后天/.test(input)) return "后日";
  if (/明天/.test(input)) return "明日";
  return "今日";
}

function detectIntent(input: string, query: string): SearchIntent {
  const text = `${input.replace(/插叙/g, "查询")} ${query}`.toLowerCase();

  if (
    /天气|气温|温度|多少度|几度|降雨|下雨|暴雨|雷阵雨|湿度|空气质量|weather/.test(text)
  ) {
    return "weather";
  }

  if (/新闻|热点|头条|快讯|资讯|热搜|国内|国际|财经|时政|news|headline/.test(text)) {
    return "news";
  }

  if (/官网|官方|文档|docs|official/.test(text)) {
    return "official";
  }

  if (/端午|节日|节假日|放假|假期/.test(text)) {
    return "official";
  }

  if (/论文|paper|arxiv|研究|benchmark|基准/.test(text)) {
    return "paper";
  }

  if (/代码|开源|github|api|sdk|框架|技术|报错/.test(text)) {
    return "technical";
  }

  if (/价格|多少钱|评测|产品|下载|agent|工具|软件|app|电脑|装机|显卡|内存|固态|ssd|cpu|主板|rtx|50\s*系|5070|5080|5090/.test(text)) {
    return "product";
  }

  return "general";
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase().trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isHardwareContext(context?: ToolConversationContext): boolean {
  return context?.topic === "hardware";
}

function buildHardwareQueries(
  input: string,
  query: string,
  context?: ToolConversationContext
): string[] {
  const text = `${input} ${query} ${(context?.keywords ?? []).join(" ")}`;
  const currentText = `${input} ${query}`;
  const queries: string[] = [];
  const currentYear = currentYearInChina();
  const hasSelectedBuild = /9600x|5070\s*ti/i.test(text);

  if (/内存|ddr5|固态|ssd|涨价/i.test(currentText)) {
    queries.push(`${currentYear} DDR5 内存 SSD 固态 价格上涨 行情`);
    queries.push(`${currentYear} 装机 内存 固态 价格 行情`);
  }

  if (/50\s*系|5070\s*ti|发布.*一年/i.test(currentText)) {
    queries.push(`RTX 5070 Ti ${currentYear} 中国 价格`);
    queries.push("RTX 50 系列 5070 Ti 发布 评测 价格");
  }

  if (hasSelectedBuild && /配置|装机|清单|一套|预算|人民币|多少钱|行情|价格/.test(currentText)) {
    queries.push("R5 9600X RTX 5070 Ti DDR5 SSD 装机 清单 价格");
  }

  if (/配置|装机|清单|一套|预算|人民币|多少钱|行情|价格/.test(currentText)) {
    queries.push(`${currentYear} 电脑 DIY 装机 硬件 价格 行情`);
  }

  if (hasSelectedBuild) {
    queries.push(`R5 9600X RTX 5070 Ti ${currentYear} 装机 价格`);
    queries.push("R5 9600X RTX 5070 Ti 搭配 评测");
  }

  if (/5070\s*ti|50\s*系/i.test(text)) {
    queries.push(`RTX 5070 Ti ${currentYear} 中国 价格`);
    queries.push("RTX 50 系列 5070 Ti 发布 评测 价格");
  }

  if (/内存|ddr5|固态|ssd|涨价/i.test(text)) {
    queries.push(`${currentYear} DDR5 内存 SSD 固态 价格上涨 行情`);
    queries.push(`${currentYear} 装机 内存 固态 价格 行情`);
  }

  if (hasSelectedBuild && /配置|装机|清单|一套|预算|人民币|多少钱|行情|价格/.test(text)) {
    queries.push(`${currentYear} 电脑 DIY 装机 硬件 价格 行情`);
    queries.push("R5 9600X RTX 5070 Ti DDR5 SSD 装机 清单 价格");
  }

  queries.push(...(context?.searchHints ?? []));
  queries.push(query);

  return dedupe(queries).slice(0, 6);
}

/** 判断一个 query 是否偏技术性，需要同时生成英文搜索词 */
function needsEnglishQuery(input: string, intent: SearchIntent): boolean {
  if (intent === "paper" || intent === "technical") return true;
  if (intent === "product" && /[a-zA-Z]/.test(input)) return true;
  return false;
}

/** 从输入中提取英文关键词供搜索用 */
function extractEnglishTerms(input: string): string[] {
  const terms = input.match(/[a-zA-Z][a-zA-Z0-9 .\-+#]+/g) ?? [];
  return terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^(the|is|are|for|and|with|that|this|how|what|why|when|where)$/i.test(t))
    .slice(0, 3);
}

/** 为 technical / product 意图生成补充英文 query */
function buildEnglishQueries(input: string, coreQuery: string): string[] {
  const terms = extractEnglishTerms(input);
  if (terms.length === 0) return [];
  const engQuery = terms.join(" ");
  if (engQuery === coreQuery) return [];
  return [engQuery, `${engQuery} documentation`, `${engQuery} tutorial`];
}

/** 为指定意图添加 site: 限定后缀 */
function addSiteDirectives(queries: string[], intent: SearchIntent): string[] {
  const result = [...queries];
  if (intent === "official") {
    if (result.some((q) => /政策|法规|社保|医保|政府|国务院|税务局|人社局/.test(q))) {
      result.push(`${result[0]} site:gov.cn`);
    }
    result.push(`${result[0]} site:baike.baidu.com`);
  }
  if (intent === "paper") {
    result.push(`${result[0]} site:arxiv.org`);
    result.push(`${result[0]} site:scholar.google.com`);
  }
  if (intent === "technical") {
    result.push(`${result[0]} site:github.com`);
    result.push(`${result[0]} site:stackoverflow.com`);
    result.push(`${result[0]} site:docs.oracle.com`);
  }
  return result;
}

function buildQueries(input: string, query: string, intent: SearchIntent): string[] {
  const currentDate = currentDateForSearch();
  const queries: string[] = [];
  const normalizedInput = input.replace(/插叙/g, "查询");

  // ── 基础 query ──
  if (intent !== "weather") queries.push(query);

  // ── 天气 ──
  if (intent === "weather") {
    const city = extractWeatherCity(normalizedInput) || extractWeatherCity(query);
    if (!city) return [];
    const location = city;
    const dayLabel = weatherDayLabel(normalizedInput);
    const airQualitySuffix = /空气质量|aqi|pm\s*2[._]?5|pm10/i.test(normalizedInput)
      ? " 空气质量"
      : "";
    queries.push(
      `${location} ${dayLabel}天气${airQualitySuffix}`,
      `${location} ${currentDate} ${dayLabel}天气${airQualitySuffix}`,
      `${location} ${dayLabel}天气预报${airQualitySuffix}`
    );
  }

  // ── 产品查询 — 多角度：参数/评测/价格/对比 ──
  if (intent === "product") {
    queries.push(`${query} 参数 配置`);
    queries.push(`${query} 评测`);
    queries.push(`${query} 价格`);
    queries.push(`${query} 对比`);
    queries.push(`${query} 官网`);
    queries.push(`${query} 文档`);
    queries.push(`${query} GitHub`);
  }

  // ── 官方查询 ──
  if (intent === "official") {
    queries.push(`${query} 官网`);
    queries.push(`${query} official docs`);
    if (/端午|节日|节假日|放假|假期/.test(input)) {
      const currentYear = currentYearInChina();
      queries.unshift(`${currentYear} 端午节 日期 官方`);
      queries.unshift(`${currentYear}年端午节放假安排 国务院`);
    }
  }

  // ── 新闻 — 优先覆盖权威新闻源，兼顾自然语言 query ──
  if (intent === "news") {
    const chineseDate = currentChineseDateInChina();
    let newsQuery = cleanSearchQuery(query);
    if (/ai|人工智能/i.test(normalizedInput) && !/ai|人工智能/i.test(newsQuery)) {
      newsQuery = `${newsQuery} AI 人工智能`.trim();
    }
    const core = newsQuery || "今日";
    if (/政治|时政/i.test(normalizedInput)) {
      queries.push(
        `${currentDate} 中国 时政 新闻`,
        `${currentDate} 国际 政治 新闻`,
        `${chineseDate} 时政 新闻`,
        `${core} 今日 新闻`,
        `${core} 最新 资讯`
      );
    } else if (/ai|人工智能/i.test(normalizedInput)) {
      queries.push(
        `${currentDate} ${newsQuery} 新闻`,
        `${chineseDate} ${newsQuery} 新闻`,
        `${currentDate} AI 国内外新闻`,
        `${chineseDate} AI 热点`,
        `${newsQuery} 今日 热点`,
        `${newsQuery} 最新 资讯`
      );
    } else {
      queries.push(
        `${currentDate} 新闻`,
        `${chineseDate} 今日 新闻 头条`,
        `${currentDate} 国内 国际 新闻`,
        `${core} 最新 新闻`,
        `${core} 今日 热点`
      );
    }
  }

  // ── 技术查询 — 多角度：文档/教程/对比/基准 ──
  if (intent === "technical") {
    queries.push(`${query} GitHub`);
    queries.push(`${query} docs`);
    queries.push(`${query} 技术文档`);
    queries.push(`${query} 教程`);
    queries.push(`${query} 对比`);
    queries.push(`${query} benchmark`);
  }

  // ── 论文 ──
  if (intent === "paper") {
    queries.push(`${query} paper`);
    queries.push(`${query} arxiv`);
    queries.push(`${query} 论文`);
    queries.push(`${query} review`);
  }

  // ── 旅游 ──
  if (isTravelRequest(input)) {
    const destination = extractTravelDestination(input) || query;
    queries.unshift(`${destination} 文旅局 官方 景点`);
    queries.unshift(`${destination} 旅游 攻略 门票 交通`);
    queries.unshift(`${destination} 景点 推荐 一日游`);
  }

  // ── 白龙马 / 银狼 特殊 ──
  if (input.includes("白龙马") && input.toLowerCase().includes("agent")) {
    queries.unshift("白龙马 BaiLongma Agent 官网 文档");
    queries.unshift("BaiLongma Agent");
  }
  if (input.includes("银狼")) {
    queries.unshift("银狼 LV.999 同人作品");
    queries.unshift("银狼 同人");
    queries.unshift("崩坏星穹铁道 银狼 二创 bilibili");
    queries.unshift("崩铁 银狼 同人 故事");
    queries.unshift("崩铁 银狼 二创");
  }

  // ── 英文补充 query（技术/产品/论文类） ──
  if (needsEnglishQuery(input, intent)) {
    const engQueries = buildEnglishQueries(input, query);
    queries.push(...engQueries);
  }

  // ── site: 限定补充 ──
  const withSite = addSiteDirectives(queries, intent);

  return dedupe(withSite).slice(0, 8);
}

function isTravelRequest(input: string): boolean {
  if (/^(?:我去)[那，,\s]?(?:今天|这|刚才|原来|还|也)/.test(input)) {
    return false;
  }
  return (
    /旅游|旅行|景点|攻略|去哪玩|哪里好玩|哪儿好玩|有什么好玩|值得去|一日游|两日游/.test(input) ||
    /(?:去|到)[\u4e00-\u9fa5]{2,10}(?:玩|游玩|旅游|旅行|逛)/.test(input) ||
    /[\u4e00-\u9fa5]{2,10}(?:怎么玩|适合玩什么|有哪些玩的)/.test(input)
  );
}

export function extractTravelDestination(input: string): string {
  if (/^(?:我去)[那，,\s]?(?:今天|这|刚才|原来|还|也)/.test(input.trim())) {
    return "";
  }
  const normalized = input
    .replace(
      /^(?:你)?(?:帮我|麻烦)?(?:查一下|查查|看看|看下|推荐一下)?/,
      ""
    )
    .replace(/[，,。.!！?？、]+$/g, "")
    .trim();
  const patterns = [
    /^(?:我)?(?:准备|打算|想|想要|要)?(?:去|到)\s*([\u4e00-\u9fa5]{2,20}?)(?:玩什么|怎么玩|玩|游玩|旅游|旅行|逛|一日游|两日游)/,
    /^([\u4e00-\u9fa5]{2,20}?)(?:有什么好玩的?|哪里好玩|哪儿好玩|有哪些景点|景点推荐|旅游攻略|旅行攻略|游玩攻略|旅游|旅行|景点|攻略|一日游|两日游)/,
  ];
  for (const pattern of patterns) {
    const destination = normalized.match(pattern)?.[1]?.trim();
    if (destination) return destination;
  }
  return "";
}

export function decideTools(
  userInput: string,
  context?: ToolConversationContext
): ToolDecision {
  const input = userInput.trim().replace(/插叙/g, "查询");

  // ⛔ 安全拦截 — 最高优先级，完全跳过搜索流程
  const safety = safetyCheck(input);
  if (safety.blocked) {
    return {
      useWebSearch: false,
      query: "",
      queries: [],
      intent: "general",
      reason: "safety-blocked",
      safetyBlocked: true,
      safetyReason: safety.reason,
    };
  }

  const query = stripSearchPrefix(input) || input;

  if (!input) {
    return {
      useWebSearch: false,
      query: "",
      queries: [],
      intent: "general",
      reason: "empty-input",
    };
  }

  const lowerInput = input.toLowerCase();
  const matchedTrigger = WEB_SEARCH_TRIGGERS.find((trigger) =>
    lowerInput.includes(trigger.toLowerCase())
  );
  const weatherRequest =
    /天气|气温|温度|多少度|几度|降雨|下雨|暴雨|雷阵雨|湿度|空气质量|weather/i.test(input);
  if (weatherRequest && !extractWeatherCity(input)) {
    return {
      useWebSearch: false,
      query: input,
      queries: [],
      intent: "weather",
      reason: "weather-location-missing",
    };
  }
  const travelRequest = isTravelRequest(input);
  const newsContextFollowUp =
    context?.topic === "news" &&
    /第?\s*(?:\d+|[一二三四五六])\s*(?:条|个|项)|更详细|详细|展开|讲讲|细说|具体|继续|然后呢|还有呢|多说点|详细信息/.test(input);

  const useHardwareContext =
    isHardwareContext(context) && !weatherRequest && !newsContextFollowUp;

  const hardwareProductFollowUp =
    useHardwareContext &&
    /9600x|5070\s*ti|50\s*系|显卡|cpu|处理器|内存|固态|ssd|配置|装机|清单|这套|这个配置|这配置|整机|一套/i.test(input) &&
    /咋样|怎么样|如何|推荐|合理|清单|配置|价格|行情|多少钱|人民币/.test(input);

  if (
    matchedTrigger ||
    weatherRequest ||
    travelRequest ||
    hardwareProductFollowUp ||
    newsContextFollowUp
  ) {
    const intent = useHardwareContext
      ? "product"
      : newsContextFollowUp
        ? "news"
      : detectIntent(input, query);
    const queries = newsContextFollowUp && context?.searchHints?.length
      ? context.searchHints
      : useHardwareContext
      ? buildHardwareQueries(input, query, context)
      : buildQueries(input, query, intent);
    return {
      useWebSearch: !newsContextFollowUp || !/第?\s*(?:\d+|[一二三四五六])\s*(?:条|个|项)/.test(input),
      query: queries[0] ?? query,
      queries,
      intent,
      reason: matchedTrigger
        ? `matched-trigger:${matchedTrigger}`
        : weatherRequest
          ? "weather-signal"
        : travelRequest
          ? "travel-signal"
        : newsContextFollowUp
          ? "news-context-follow-up"
        : "hardware-follow-up",
    };
  }

  return {
    useWebSearch: false,
    query: input,
    queries: [],
    intent: "general",
    reason: "no-web-trigger",
  };
}
