/**
 * 对话记忆模块
 *
 * 当前版本使用简易的滑动窗口记忆：
 * - 保留最近 N 轮对话
 * - 超出窗口的旧消息自动丢弃
 *
 * 后续可升级为摘要记忆（Summary Memory）：
 * - 旧消息自动压缩为摘要，保留关键信息
 * - 用户偏好、玩家ID 等长期信息持久化
 */

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export class ConversationMemory {
  private messages: Message[] = [];
  private maxTurns: number;

  constructor(maxTurns = 20) {
    this.maxTurns = maxTurns;
  }

  /** 从持久化记录恢复最近消息 */
  hydrate(messages: Message[]): void {
    this.messages = messages.filter(
      (message) => message.role === "user" || message.role === "assistant"
    );

    while (this.messages.length > this.maxTurns * 2) {
      this.messages.shift();
    }
  }

  /** 添加一轮对话 */
  add(userMessage: string, assistantMessage: string): void {
    this.messages.push({ role: "user", content: userMessage });
    this.messages.push({ role: "assistant", content: assistantMessage });

    // 超出窗口时裁剪最旧的 2 条（一轮）
    while (this.messages.length > this.maxTurns * 2) {
      this.messages.shift();
      this.messages.shift();
    }
  }

  /** 获取当前全部消息 */
  getAll(): Message[] {
    return [...this.messages];
  }

  /** 重置记忆 */
  reset(): void {
    this.messages = [];
  }

  /** 获取记忆摘要（供后续升级用） */
  getStats(): { turnCount: number; totalMessages: number } {
    return {
      turnCount: Math.floor(this.messages.length / 2),
      totalMessages: this.messages.length,
    };
  }
}
