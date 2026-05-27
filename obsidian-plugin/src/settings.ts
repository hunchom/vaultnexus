// VaultNexus plugin settings → persisted via loadData/saveData

export interface VaultNexusSettings {
  host: string;
  port: number;
  defaultK: number;
  showHeading: boolean;
  showScore: boolean;
  showPreview: boolean;
  previewLen: number;
}

export const DEFAULT_SETTINGS: VaultNexusSettings = {
  host: '127.0.0.1',
  port: 38473,
  defaultK: 10,
  showHeading: true,
  showScore: true,
  showPreview: true,
  previewLen: 200,
};
