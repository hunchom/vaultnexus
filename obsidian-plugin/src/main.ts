import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VaultNexusSearchView, VIEW_TYPE_VAULTNEXUS_SEARCH } from './SearchView.js';
import { VaultNexusSettingsTab } from './SettingsTab.js';
import { DEFAULT_SETTINGS, type VaultNexusSettings } from './settings.js';

export default class VaultNexusPlugin extends Plugin {
  settings!: VaultNexusSettings;
  private autoApplyTimer?: number;
  private autoApplyCount = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_VAULTNEXUS_SEARCH,
      (leaf: WorkspaceLeaf) => new VaultNexusSearchView(leaf, () => this.settings),
    );

    this.addCommand({
      id: 'vaultnexus-search',
      name: 'Search vault via VaultNexus',
      callback: () => this.activateView(),
    });

    this.addRibbonIcon('search', 'VaultNexus: search', () => this.activateView());

    this.addSettingTab(new VaultNexusSettingsTab(this.app, this));

    // Daemon may not be up yet → retry the chat-config push up to 30× (5 minutes).
    // Idempotent: re-POST same config is fine. Stops on first success or non-fake settings absent.
    this.autoApplyTimer = window.setInterval(() => void this.maybeApplyChatConfig(), 10_000);
    void this.maybeApplyChatConfig();
  }

  async onunload(): Promise<void> {
    if (this.autoApplyTimer !== undefined) window.clearInterval(this.autoApplyTimer);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<VaultNexusSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    void this.maybeApplyChatConfig();
  }

  // Auto-sync chat config to daemon → user pastes key in settings, daemon adopts on next probe.
  private async maybeApplyChatConfig(): Promise<void> {
    const s = this.settings;
    if (s.chatProvider === 'fake') {
      this.stopAutoApply();
      return;
    }
    if (s.chatProvider !== 'openai-compatible' && !s.chatKey) return;
    if (s.chatProvider === 'openai-compatible' && (!s.chatModel || !s.chatBaseURL)) return;
    this.autoApplyCount += 1;
    if (this.autoApplyCount > 30) this.stopAutoApply();

    const body: Record<string, string> = { provider: s.chatProvider };
    if (s.chatKey) body.key = s.chatKey;
    if (s.chatModel) body.model = s.chatModel;
    if (s.chatBaseURL) body.baseURL = s.chatBaseURL;

    try {
      const r = await fetch(`http://${s.host}:${s.port}/configure-chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) this.stopAutoApply();
    } catch {
      // daemon down → keep retrying on the timer
    }
  }

  private stopAutoApply(): void {
    if (this.autoApplyTimer !== undefined) {
      window.clearInterval(this.autoApplyTimer);
      this.autoApplyTimer = undefined;
    }
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_VAULTNEXUS_SEARCH);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_VAULTNEXUS_SEARCH, active: true });
    workspace.revealLeaf(leaf);
  }
}
