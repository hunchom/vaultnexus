import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VaultNexusSearchView, VIEW_TYPE_VAULTNEXUS_SEARCH } from './SearchView.js';
import { VaultNexusSettingsTab } from './SettingsTab.js';
import { DEFAULT_SETTINGS, type VaultNexusSettings } from './settings.js';

export default class VaultNexusPlugin extends Plugin {
  settings!: VaultNexusSettings;

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
  }

  async onunload(): Promise<void> { /* Obsidian auto-detaches views. */ }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<VaultNexusSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
