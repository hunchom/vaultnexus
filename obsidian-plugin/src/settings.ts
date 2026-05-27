// VaultNexus plugin settings → persisted via loadData/saveData.
// Connection + display are pure plugin-side. Chat config is plugin-side + pushed to daemon /configure-chat.

export type ChatProvider = 'fake' | 'anthropic' | 'openai' | 'openai-compatible';

export interface VaultNexusSettings {
  host: string;
  port: number;
  defaultK: number;
  showHeading: boolean;
  showScore: boolean;
  showPreview: boolean;
  previewLen: number;
  // Chat
  chatProvider: ChatProvider;
  chatKey: string;
  chatModel: string;
  chatBaseURL: string;
}

export const DEFAULT_SETTINGS: VaultNexusSettings = {
  host: '127.0.0.1',
  port: 38473,
  defaultK: 10,
  showHeading: true,
  showScore: true,
  showPreview: true,
  previewLen: 200,
  chatProvider: 'fake',
  chatKey: '',
  chatModel: '',
  chatBaseURL: '',
};
