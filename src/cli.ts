/**
 * 银狼 Agent 命令行聊天入口
 *
 * 启动方式：
 *   npm run chat
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateConfig } from "./config.js";

async function runCli(): Promise<void> {
  try {
    validateConfig();
  } catch (error) {
    console.error(
      `启动失败> ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
    return;
  }

  const { closeDatabase, initDatabase } = await import("./db/conversation-store.js");
  try {
    await initDatabase();
    const { clearSession, sendMessage } = await import("./agent/chat-agent.js");
    const sessionId = process.env.SESSION_ID ?? "cli";
    const rl = createInterface({ input, output });

    console.log("\n银狼 Agent 命令行模式");
    // 模型配置与密钥统一存于数据库 llm_model_configs，此处读取当前激活模型
    let modelLabel = "（数据库配置）";
    try {
      const { getActiveLlmModelConfig } = await import("./llm/model-configs.js");
      const active = await getActiveLlmModelConfig();
      modelLabel = `${active.label} / ${active.model}`;
    } catch {
      // 无可用配置时保持默认提示
    }
    console.log(`模型: ${modelLabel}`);
    console.log("输入 exit / quit 退出，输入 clear 清空本轮会话记忆。\n");

    try {
      while (true) {
        const answer = await rl.question("玩家> ").catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ERR_USE_AFTER_CLOSE"
          ) {
            return null;
          }
          throw error;
        });

        if (answer === null) break;
        const message = answer.trim();
        if (!message) continue;

        if (["exit", "quit", "退出"].includes(message.toLowerCase())) {
          console.log("银狼> 下线了？行吧，记得下次带点有意思的副本来。");
          break;
        }

        if (["clear", "reset", "清空"].includes(message.toLowerCase())) {
          await clearSession(sessionId);
          console.log("银狼> 存档清掉了。别后悔，玩家。");
          continue;
        }

        try {
          const { reply, webSearch } = await sendMessage(message, sessionId);
          console.log(`银狼> ${reply}\n`);
          if (webSearch?.used && webSearch.results.length > 0) {
            const sources = webSearch.results
              .slice(0, 3)
              .map(
                (result, index) =>
                  `[${index + 1}] ${result.title} - ${result.url}`
              )
              .join("\n");
            console.log(`来源>\n${sources}\n`);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "未知错误";
          console.error(`错误> ${errorMessage}\n`);
        }
      }
    } finally {
      rl.close();
    }
  } finally {
    await closeDatabase();
  }
}

try {
  await runCli();
} catch (error) {
  console.error(
    `命令行初始化失败> ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
