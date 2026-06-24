import { containsCurrentChinaDate } from "../current-date.js";
import type { ConversationContext } from "../agent/conversation-context.js";
import type { WebSearchResult } from "./web-search.js";
import { extractWeatherCity } from "./tool-router.js";

export function isRelevantWebResult(
  result: WebSearchResult,
  context: ConversationContext,
  activeQuery: string,
  intent?: string
): boolean {
  const text = `${result.title} ${result.snippet} ${result.content}`.toLowerCase();
  const query = activeQuery.toLowerCase();

  if (intent === "weather") {
    const weatherSignals =
      /天气|气温|温度|降雨|下雨|暴雨|雷阵雨|湿度|空气质量|风力|风向|预报|weather|℃|°c/i;
    const newsNoise = /新闻|要闻|头条|时政|国际|国内|新闻联播|高考|世界杯/i;
    const location = extractWeatherCity(activeQuery);
    const resultText = `${result.title} ${result.snippet} ${result.content}`;
    return (
      weatherSignals.test(resultText) &&
      (!location || resultText.includes(location)) &&
      !newsNoise.test(result.title)
    );
  }

  if (intent === "news") {
    const noise =
      /百度百科|是什么年|是个什么年|节假日安排|新年贺词|全国两会专题|全国两会----|国务院办公厅关于.*节假日|放假安排/i;
    if (noise.test(`${result.title} ${result.snippet} ${result.url}`)) return false;

    const wantsToday =
      /今天|今日|最新|实时|today/i.test(query) || containsCurrentChinaDate(query);
    if (wantsToday) {
      const hasExactDate = containsCurrentChinaDate(
        `${result.title} ${result.snippet} ${result.content}`
      );
      const fromNewsIndex = /来自新闻首页/.test(result.snippet);
      const isLiveNewsIndex =
        /新闻频道|时政联播|中国新闻|今日新闻|news\.cctv|news\.cn|xinhuanet|chinanews|cnr\.cn/i.test(
          `${result.title} ${result.url}`
        ) && /新闻|时政|国内|国际|头条/.test(`${result.title} ${result.snippet}`);
      return hasExactDate || fromNewsIndex || isLiveNewsIndex;
    }
    return result.sourceType === "news" || /新闻|时政|国内|国际|头条/i.test(text);
  }

  if (context.topic !== "hardware") return true;

  const hardwareSignals = [
    "rtx", "geforce", "nvidia", "5070", "显卡", "9600x", "锐龙",
    "ryzen", "cpu", "ddr5", "内存", "ssd", "固态", "装机", "diy", "主板",
  ];
  const obviousNoise = ["佳能", "eos", "fifa", "节假日", "国务院", "央视网"];
  const hasSignal = hardwareSignals.some((signal) => text.includes(signal));
  const isNoise = obviousNoise.some((noise) => text.includes(noise.toLowerCase()));
  if (!hasSignal || isNoise) return false;
  if (/5070|50\s*系|rtx 50|geforce rtx 50/i.test(query)) {
    return /5070|50\s*系|rtx\s*50|geforce\s*rtx\s*50/i.test(text);
  }
  if (/9600x/i.test(query)) {
    return /9600x|ryzen\s*5\s*9600|锐龙\s*5\s*9600/i.test(text);
  }
  if (/ddr5|内存|ssd|固态/i.test(query)) {
    return /ddr5|内存|ssd|固态|颗粒|nand|dram/i.test(text);
  }
  return true;
}
