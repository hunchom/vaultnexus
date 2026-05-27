import type { ChatModel, ChatMessage } from './chat-model.js';

/** Deterministic offline stub → echoes user-role content. Tests + offline default. */
export class FakeChatModel implements ChatModel {
  readonly id = 'fake';

  async compose(messages: ChatMessage[]): Promise<string> {
    const user = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    // truncate → keeps fixture-driven tests bounded
    return `[fake-compose] ${user.slice(0, 2000)}`;
  }
}
