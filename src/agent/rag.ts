/**
 * RAG 知识检索模块
 *
 * 银狼需要掌握的背景知识：
 * - 个人历史、朋克洛德设定
 * - 崩坏星穹铁道世界观基础（命途、星神、阵营、关键地点）
 * - 同伴关系细节
 *
 * 当前版本使用内存检索（基于关键词匹配）。
 * 后续可替换为向量数据库（LanceDB / Qdrant）实现语义检索。
 */

import { FEW_SHOTS, type FewShotExample } from "./few-shots.js";

/* ========== 世界观知识库 ========== */

interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
}

const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    id: "punklorde",
    title: "朋克洛德",
    content:
      `银狼的故乡，一颗充斥着光污染的星球。全宇宙最顶尖的骇客都来自这里。银狼管它叫"新手村"——新手熟悉规则、提升实力的地方。朋克洛德精神的核心是：反叛权威、追求自由、DIY、挑战既定规则。`,
    tags: ["出身", "朋克洛德", "背景"],
  },
  {
    id: "stellaron-hunters",
    title: "星核猎手",
    content:
      `星核猎手是一个神秘组织，成员包括艾利欧（命运的奴隶）、卡芙卡、刃、流萤（萨姆）和银狼。银狼是最后加入的成员。他们按照艾利欧预见的"剧本"行动，目的与星核有关。`,
    tags: ["星核猎手", "阵营", "组织"],
  },
  {
    id: "silver-wolf-history",
    title: "银狼个人经历",
    content:
      `银狼童年只有几台陈旧的游戏机，日复一日玩着摇杆。没有合法名字，没有身份编号。"银狼"只是一个游戏账号名。曾与天才俱乐部成员螺丝咕姆进行数据攻防战，未能攻破对方防御但全身而退，这次交锋成为骇客界的传说。悬赏金 61 亿信用点。`,
    tags: ["银狼", "背景", "经历", "个人"],
  },
  {
    id: "paths-and-aeons",
    title: "命途与星神",
    content:
      `命途是宇宙中的哲学概念，代表不同的存在方式。星神是命途的化身。银狼的命途是"虚无"（认为一切终将归于虚无，但虚无本身也是一种力量），战斗属性为量子。同伴中卡芙卡也是虚无命途，刃是毁灭命途，流萤是毁灭命途。`,
    tags: ["命途", "星神", "世界观", "设定"],
  },
  {
    id: "screwllum",
    title: "螺丝咕姆",
    content:
      "天才俱乐部成员，机械生命体。曾与银狼在信息领域交锋，银狼未能攻破他的防御系统，螺丝咕姆也没有阻止她离开。银狼认为这是自己的一次失败，一直想再战一场。",
    tags: ["螺丝咕姆", "对手", "天才俱乐部"],
  },
];

/* ========== 检索逻辑 ========== */

interface RetrievalResult {
  knowledge: KnowledgeEntry[];
  fewShots: FewShotExample[];
}

/**
 * 基于用户输入关键词进行简易检索。
 * 返回相关的知识条目和最匹配的 few-shot 示例。
 */
export function retrieveRelevantContext(userInput: string): RetrievalResult {
  const input = userInput.toLowerCase();
  const normalizedInput = input.replace(/\s+/g, "");

  // 知识库匹配
  const knowledge = KNOWLEDGE_BASE.filter(
    (entry) =>
      entry.tags.some((tag) => input.includes(tag)) ||
      entry.content.toLowerCase().includes(input.split(/\s+/)[0])
  ).slice(0, 3);

  // Few-shot 匹配（取最相关的 2 条）
  const fewShots = FEW_SHOTS.map((shot) => {
    const tagScore = shot.tags.filter(
      (tag) => input.includes(tag) || normalizedInput.includes(tag)
    ).length;
    const userScore =
      shot.user.includes(input.slice(0, 8)) ||
      normalizedInput.includes(shot.user.replace(/\s+/g, "").slice(0, 8))
        ? 2
        : 0;
    return { shot, score: tagScore + userScore };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.shot)
    .slice(0, 2);

  return { knowledge, fewShots };
}
