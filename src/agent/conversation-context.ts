import type { Message } from "./memory.js";
import {
  currentChineseDateInChina,
  currentDateInChina,
  currentYearInChina,
} from "../current-date.js";
import { extractTravelDestination } from "../tools/tool-router.js";

export interface ConversationContext {
  topic: "hardware" | "news" | "general";
  facts: string[];
  keywords: string[];
  searchHints: string[];
  summaryText: string;
  userLocation?: string;
  weatherLocation?: string;
  travelDestination?: string;
}

const HARDWARE_PATTERN =
  /电脑|diy|装机|配置|显卡|cpu|处理器|主板|内存|固态|ssd|硬盘|电源|散热|机箱|预算|rtx|5070|5060|5080|5090|50\s*系|9600x|7500f|4060|6750|ddr5|nvme/i;

const HARDWARE_RESET_PATTERN = /政治|时政|新闻|热点|天气|汇率|股价|赛程/i;
const NEWS_PATTERN =
  /新闻|时政|热点|头条|高考|中东|伊朗|霍尔木兹|美股|股市|科技突破|国内|国际|财经|突发|来源[:：]|\[\d+\]/i;
const NEWS_FOLLOW_UP_PATTERN =
  /更详细|详细|展开|讲讲|细说|具体|继续|然后呢|还有呢|多说点|详细信息/i;
/** 当用户消息命中此模式且不含新闻关键词时，判定为话题已切换 */
const NEWS_RESET_PATTERN =
  /你好|你是谁|健身|锻炼|体重|身高|技能|插件|能力|宾至如归|反义词|同义词|近义词|英语|翻译|代码|编程|算法|数据库|服务器|部署|docker|配置文件|环境变量|端口|银狼|星穹铁道|崩坏|角色|游戏|技能列表|笨蛋|哈哈|谢谢|再见|拜拜|吃|喝|睡|玩|聊天|讲个|说个|唱|跳|rap|篮球/i;

function isHardwareText(text: string): boolean {
  return HARDWARE_PATTERN.test(text);
}

function normalizeHardwareKeyword(value: string): string {
  return value
    .replace(/r5[-\s]?9600x/i, "R5 9600X")
    .replace(/5070\s*ti/i, "RTX 5070 Ti")
    .replace(/50\s*系/i, "RTX 50 系列")
    .replace(/ddr5/i, "DDR5")
    .replace(/ssd|固态/i, "SSD")
    .trim();
}

function uniq(values: string[]): string[] {
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

function lastMatch(texts: string[], pattern: RegExp): string | undefined {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const match = texts[index]
      .match(pattern)?.[1]
      ?.replace(/^(?:那|那么|所以|然后)?(?:今天|今日|明天|后天|现在|当前)?/, "")
      .replace(/市$/, "")
      .trim();
    if (match) return match;
  }
  return undefined;
}

function extractLocationContext(
  messages: Message[],
  currentMessage: string
): Pick<
  ConversationContext,
  "userLocation" | "weatherLocation" | "travelDestination"
> {
  const userTexts = [
    ...messages
      .slice(-20)
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    currentMessage,
  ];
  const userLocation = lastMatch(
    userTexts,
    /(?:我|本人)(?:现在)?(?:在|住在|位于)\s*([\u4e00-\u9fa5]{2,20}?)(?:啊|呀|呢|吧|，|,|。|！|!|？|\?|$)/
  );
  const weatherLocation = lastMatch(
    userTexts.filter((text) =>
      /天气|气温|温度|下雨|降雨|多少度|几度|空气质量|湿度/.test(text)
    ),
    /([\u4e00-\u9fa5]{2,20}?)(?:今天|今日|明天|后天|现在|当前)?(?:的)?(?:天气|气温|温度|会下雨|下雨|降雨|多少度|几度|空气质量|湿度)/
  );
  const travelDestination = [...userTexts]
    .reverse()
    .map(extractTravelDestination)
    .find(Boolean);
  return { userLocation, weatherLocation, travelDestination };
}

function extractHardwareKeywords(text: string): string[] {
  const keywords: string[] = [];

  const patterns = [
    /r5[-\s]?9600x/gi,
    /rtx\s*5070\s*ti/gi,
    /5070\s*ti/gi,
    /rtx\s*50\s*系/gi,
    /50\s*系/gi,
    /ddr5/gi,
    /ssd|固态/gi,
    /内存/g,
    /显卡/g,
    /装机|配置/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      keywords.push(normalizeHardwareKeyword(match[0]));
    }
  }

  return uniq(keywords);
}

export function extractConversationContext(
  messages: Message[],
  currentMessage: string
): ConversationContext {
  const locationContext = extractLocationContext(messages, currentMessage);
  const recentUserText = [
    ...messages
      .slice(-16)
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    currentMessage,
  ]
    .join("\n")
    .trim();

  const currentStartsNewTopic =
    HARDWARE_RESET_PATTERN.test(currentMessage) && !isHardwareText(currentMessage);
  const isHardwareTopic = !currentStartsNewTopic && isHardwareText(recentUserText);
  if (!isHardwareTopic) {
    // 缩小回溯窗口：只看最近 6 条用户消息，避免新闻话题黏连过久
    const recentUserTextShort = [
      ...messages
        .slice(-6)
        .filter((message) => message.role === "user")
        .map((message) => message.content),
      currentMessage,
    ]
      .join("\n")
      .trim();

    const assistantNewsText = messages
      .slice(-8)
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n");

    // 话题重置检测：当前消息明显切换到非新闻话题时，不再延续新闻上下文
    const currentIsNewsRelated = NEWS_PATTERN.test(currentMessage) || NEWS_FOLLOW_UP_PATTERN.test(currentMessage);
    const topicReset = NEWS_RESET_PATTERN.test(currentMessage) && !currentIsNewsRelated;

    const isNewsTopic =
      !topicReset &&
      (NEWS_PATTERN.test(recentUserTextShort) ||
        (NEWS_FOLLOW_UP_PATTERN.test(currentMessage) && NEWS_PATTERN.test(assistantNewsText)));

    if (isNewsTopic) {
      const keywordCandidates = [
        /高考/.test(`${recentUserTextShort}\n${assistantNewsText}`) ? "高考" : "",
        /中东|伊朗|霍尔木兹/.test(`${recentUserTextShort}\n${assistantNewsText}`)
          ? "中东 伊朗 霍尔木兹"
          : "",
        /美股|股市|芯片/.test(`${recentUserTextShort}\n${assistantNewsText}`)
          ? "美股 芯片"
          : "",
        /科技|低碳|海工|船舶/.test(`${recentUserTextShort}\n${assistantNewsText}`)
          ? "国内 科技 突破"
          : "",
        /政治|时政/.test(`${recentUserTextShort}\n${assistantNewsText}`) ? "时政" : "",
      ];
      const keywords = uniq(keywordCandidates);
      const currentDate = currentDateInChina();
      const currentChineseDate = currentChineseDateInChina();
      const searchHints = uniq([
        ...keywords.map((keyword) => `${currentDate} ${keyword} 新闻 详情`),
        `${currentDate} 今日 新闻 头条 详情`,
        `${currentChineseDate} 今日 新闻 详情`,
      ]);

      return {
        topic: "news",
        facts: ["当前对话正在延续今天新闻/时政热点话题。"],
        keywords,
        searchHints,
        summaryText: [
          "当前对话主题是今天新闻/时政热点的连续追问。",
          keywords.length > 0 ? `新闻关键词：${keywords.join("、")}` : "",
          "玩家追问详细信息时，应继续围绕上一轮新闻主题展开；没有可靠联网来源就不要编细节。",
        ]
          .filter(Boolean)
          .join("\n"),
        ...locationContext,
      };
    }

    const locationFacts = [
      locationContext.userLocation
        ? `玩家明确表示自己当前在${locationContext.userLocation}。`
        : "",
      locationContext.weatherLocation
        ? `最近查询天气的地点是${locationContext.weatherLocation}。`
        : "",
      locationContext.travelDestination
        ? `此前讨论的旅行目的地是${locationContext.travelDestination}，不能据此推断玩家本人已经在那里。`
        : "",
      /^(?:我去)[那，,\s]?(?:今天|这|刚才|原来|还|也)/.test(currentMessage)
        ? `当前句首的“我去”是口语感叹，不表示玩家要前往${locationContext.travelDestination ?? "某地"}。`
        : "",
    ].filter(Boolean);
    return {
      topic: "general",
      facts: locationFacts,
      keywords: [],
      searchHints: [],
      summaryText: locationFacts.join("\n"),
      ...locationContext,
    };
  }

  const keywords = extractHardwareKeywords(recentUserText);
  const facts: string[] = [];
  const currentYear = currentYearInChina();

  if (recentUserText.includes(`${currentYear}年`) || recentUserText.includes(`${currentYear}-`)) {
    facts.push(`玩家已明确当前时间背景是 ${currentYear} 年。`);
  }

  if (/今年.*50\s*系|50\s*系列?.*发布.*一年/.test(recentUserText)) {
    facts.push("玩家指出 RTX 50 系列已经发布约一年，应按当前世代硬件处理。");
  }

  if (/r5[-\s]?9600x/i.test(recentUserText) && /5070\s*ti/i.test(recentUserText)) {
    facts.push("当前装机方向围绕 R5 9600X + RTX 5070 Ti 评估，不要退回旧的 RTX 4060 Ti / RX 6750 GRE 方案，除非玩家主动要求低预算替代。");
  }

  if (/内存.*涨价|固态.*涨价|ssd.*涨价|涨价.*内存|涨价.*固态/i.test(recentUserText)) {
    facts.push("玩家提醒最近内存和 SSD 价格上涨，配置和预算估算需要考虑这个趋势。");
  }

  if (/价格|行情|预算|多少钱|人民币|一套下来/.test(recentUserText)) {
    facts.push("玩家关心人民币落地价和近期硬件行情；没有实时平台报价时只能给区间估算。");
  }

  const searchHints = uniq([
    keywords.includes("R5 9600X") || /9600x/i.test(recentUserText)
      ? `R5 9600X RTX 5070 Ti ${currentYear} 装机 价格`
      : "",
    /5070\s*ti/i.test(recentUserText)
      ? `RTX 5070 Ti ${currentYear} 中国 价格 评测`
      : "",
    /内存|ddr5|固态|ssd/i.test(recentUserText)
      ? `${currentYear} DDR5 内存 SSD 固态 价格上涨 行情`
      : "",
    `${currentYear} 电脑 DIY 装机 硬件 价格 行情`,
  ]);

  const summaryText = [
    "当前对话主题是电脑 DIY/装机配置的连续讨论。",
    facts.length > 0 ? `已确认事实：${facts.join(" ")}` : "",
    keywords.length > 0 ? `关键词：${keywords.join("、")}` : "",
    "回答续问时要沿用这些信息，不能把每句话当成独立新问题。",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    topic: "hardware",
    facts,
    keywords,
    searchHints,
    summaryText,
    ...locationContext,
  };
}
