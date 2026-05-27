import type { ChatModel } from '../core/chat-model.js';
import { FakeChatModel } from '../core/fake-chat-model.js';
import {
  createAnthropicChatModel,
  createOpenAIChatModel,
  createOpenAICompatibleChatModel,
} from './ai-chat-model.js';

type Env = Record<string, string | undefined>;

/** Plugin /configure-chat payload → temporary Env map for selectChatModel. */
export interface ChatConfig {
  provider?: 'fake' | 'anthropic' | 'openai' | 'openai-compatible';
  key?: string;
  model?: string;
  baseURL?: string;
}

/** Translate ChatConfig → Env-shape map. Empty fields stay undefined → selectChatModel throws as usual. */
export function chatConfigToEnv(cfg: ChatConfig): Env {
  return {
    VAULTNEXUS_CHAT_PROVIDER: cfg.provider,
    VAULTNEXUS_CHAT_KEY: cfg.key,
    VAULTNEXUS_CHAT_MODEL: cfg.model,
    VAULTNEXUS_CHAT_URL: cfg.baseURL,
  };
}

/** Pick chat model from env. default → FakeChatModel. Explicit provider w/o required envs → throw. */
export function selectChatModel(env: Env = process.env): ChatModel {
  const provider = env.VAULTNEXUS_CHAT_PROVIDER ?? 'fake';

  if (provider === 'fake') return new FakeChatModel();

  if (provider === 'anthropic') {
    const apiKey = need(env, 'VAULTNEXUS_CHAT_KEY', provider);
    return createAnthropicChatModel({ apiKey, model: env.VAULTNEXUS_CHAT_MODEL });
  }

  if (provider === 'openai') {
    const apiKey = need(env, 'VAULTNEXUS_CHAT_KEY', provider);
    return createOpenAIChatModel({ apiKey, model: env.VAULTNEXUS_CHAT_MODEL });
  }

  if (provider === 'openai-compatible') {
    const baseURL = need(env, 'VAULTNEXUS_CHAT_URL', provider);
    const apiKey = need(env, 'VAULTNEXUS_CHAT_KEY', provider);
    const model = need(env, 'VAULTNEXUS_CHAT_MODEL', provider);
    return createOpenAICompatibleChatModel({ baseURL, apiKey, model });
  }

  throw new Error(`unknown VAULTNEXUS_CHAT_PROVIDER: ${provider}`);
}

function need(env: Env, name: string, provider: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} required for VAULTNEXUS_CHAT_PROVIDER=${provider}`);
  return v;
}
