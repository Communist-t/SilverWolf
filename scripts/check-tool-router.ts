import assert from "node:assert/strict";
import { decideTools, type ToolConversationContext } from "../src/tools/tool-router.js";

const generalContext: ToolConversationContext = {
  topic: "general",
  facts: [],
  keywords: [],
  searchHints: [],
};

const cases = [
  { input: "你好自我介绍一下", search: false, intent: "general" },
  { input: "自我介绍一下", search: false, intent: "general" },
  { input: "你好，你是谁？", search: false, intent: "general" },
  { input: "今天武汉天气", search: true, intent: "weather" },
  { input: "帮我看看今天武汉的天气呗", search: true, intent: "weather" },
  {
    input: "你好自我介绍一下，然后告诉我武汉的天气",
    search: true,
    intent: "weather",
    queryIncludes: "武汉",
  },
  { input: "帮我查一下今天的新闻", search: true, intent: "news" },
] as const;

for (const testCase of cases) {
  const decision = decideTools(testCase.input, generalContext);
  assert.equal(
    decision.useWebSearch,
    testCase.search,
    `${testCase.input} 的联网判断错误`
  );
  assert.equal(
    decision.intent,
    testCase.intent,
    `${testCase.input} 的意图判断错误`
  );
  if ("queryIncludes" in testCase) {
    assert.ok(
      decision.queries.some((query) => query.includes(testCase.queryIncludes)),
      `${testCase.input} 的查询词没有包含 ${testCase.queryIncludes}`
    );
  }
}

console.log(`工具路由测试通过：${cases.length} 个场景`);
