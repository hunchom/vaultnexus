import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';

export const VIEW_TYPE_VAULTNEXUS_SEARCH = 'vaultnexus-search';

interface SearchHit {
  notePath: string;
  headingPath: string[];
  byteStart: number;
  byteEnd: number;
  text: string;
  score: number;
}

export class VaultNexusSearchView extends ItemView {
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;

  constructor(leaf: WorkspaceLeaf, private readonly port: number) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_VAULTNEXUS_SEARCH; }
  getDisplayText(): string { return 'VaultNexus Search'; }
  getIcon(): string { return 'search'; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('vaultnexus-search-view');

    const title = root.createEl('h4', { text: 'VaultNexus Search' });
    title.style.marginTop = '0';

    this.inputEl = root.createEl('input', {
      type: 'text',
      placeholder: 'Search vault…',
    });
    this.inputEl.style.width = '100%';
    this.inputEl.style.marginBottom = '8px';

    this.resultsEl = root.createDiv({ cls: 'vaultnexus-results' });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this.runSearch();
    });
  }

  async onClose(): Promise<void> { /* nothing to release */ }

  // POST /search → render hits. Click → openLinkText jumps to the note.
  private async runSearch(): Promise<void> {
    const q = this.inputEl.value.trim();
    if (!q) return;
    this.resultsEl.empty();
    const loading = this.resultsEl.createEl('p', { text: 'Searching…' });

    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, k: 10 }),
      });
      loading.remove();

      if (!res.ok) {
        this.resultsEl.createEl('p', { text: `Daemon error: HTTP ${res.status}. Is the VaultNexus daemon running?` });
        return;
      }
      const hits = (await res.json()) as SearchHit[];
      if (hits.length === 0) {
        this.resultsEl.createEl('p', { text: 'No matches.' });
        return;
      }
      for (const h of hits) this.renderHit(h);
    } catch (err) {
      loading.remove();
      const msg = err instanceof Error ? err.message : String(err);
      this.resultsEl.createEl('p', { text: `Fetch failed: ${msg}` });
      new Notice('VaultNexus daemon unreachable on loopback.');
    }
  }

  private renderHit(h: SearchHit): void {
    const item = this.resultsEl.createDiv({ cls: 'vaultnexus-hit' });
    item.style.padding = '6px 0';
    item.style.borderBottom = '1px solid var(--background-modifier-border)';

    const link = item.createEl('a', { text: h.notePath, href: '#' });
    link.style.fontWeight = '600';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      this.app.workspace.openLinkText(h.notePath, '', false);
    });

    if (h.headingPath.length > 0) {
      item.createEl('div', { text: '> ' + h.headingPath.join(' / '), cls: 'vaultnexus-heading' })
        .style.fontSize = '0.85em';
    }

    const preview = item.createEl('div', { text: h.text.slice(0, 200), cls: 'vaultnexus-preview' });
    preview.style.fontSize = '0.85em';
    preview.style.color = 'var(--text-muted)';

    const score = item.createEl('div', { text: `score=${h.score.toFixed(3)}`, cls: 'vaultnexus-score' });
    score.style.fontSize = '0.75em';
    score.style.color = 'var(--text-faint)';
  }
}
