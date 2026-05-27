import type { ChatModel, ChatMessage } from './chat-model.js';

// chunk size for streamCompose → fixed for determinism, small enough to guarantee multi-chunk
const STREAM_CHUNK_BYTES = 8;

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

  /** Stream same output compose() returns, sliced into deterministic fixed-size chunks. */
  async *streamCompose(messages: ChatMessage[]): AsyncIterable<string> {
    const full = await this.compose(messages);
    for (let i = 0; i < full.length; i += STREAM_CHUNK_BYTES) {
      yield full.slice(i, i + STREAM_CHUNK_BYTES);
    }
  }
}
