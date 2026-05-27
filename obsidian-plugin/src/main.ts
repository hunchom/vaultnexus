import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VaultNexusSearchView, VIEW_TYPE_VAULTNEXUS_SEARCH } from './SearchView.js';

// Loopback daemon port → must match VAULTNEXUS_HTTP_PORT default in src/daemon/main.ts.
// Renderer runs in browser context → no process.env. Port override via settings tab, future work.
const DEFAULT_PORT = 38473;

export default class VaultNexusPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_VAULTNEXUS_SEARCH,
      (leaf: WorkspaceLeaf) => new VaultNexusSearchView(leaf, DEFAULT_PORT),
    );

    this.addCommand({
      id: 'vaultnexus-search',
      name: 'Search vault via VaultNexus',
      callback: () => this.activateView(),
    });

    this.addRibbonIcon('search', 'VaultNexus: search', () => this.activateView());
  }

  async onunload(): Promise<void> {
    // Obsidian auto-detaches views → no manual cleanup.
  }

  // Reuse existing leaf if open → else open in right sidebar.
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
