/** One turn in a chat exchange. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Generation knobs → maxTokens caps output, temperature controls randomness. */
export interface ChatComposeOpts {
  maxTokens?: number;
  temperature?: number;
}

/** Provider-agnostic chat compose surface. id = stable string for telemetry. */
export interface ChatModel {
  readonly id: string;
  compose(messages: ChatMessage[], opts?: ChatComposeOpts): Promise<string>;
}
