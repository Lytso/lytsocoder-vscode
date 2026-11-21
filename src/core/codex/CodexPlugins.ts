// Settings → Codex → Plugins (port of ui/codex/CodexPluginsPage.kt): Codex' own plugin commands over its app-server
// (`plugin/list`, `plugin/install`, `plugin/uninstall`, `marketplace/add|upgrade|remove`), the same as `codex
// plugin …`. A marketplace is a git repository with a plugin catalog: Codex reads its own format and Claude Code's.
// The app's tabs (Installed / Discover / Marketplaces) are a chip switch; a marketplace opens on its own page with its
// plugins. Codex' remote catalog has thousands of plugins, so Discover searches here and shows the first matches.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { Cached, unavailablePage } from '../agy/settingsKit';
import { setupWithAiItem } from '../skills';
import type { CodexBackend } from './CodexBackend';
import { arr, bool, errText, o, obj, str, type J } from './util';

/** One plugin of a marketplace, from Codex' `plugin/list`. */
interface CxPlugin {
  id: string;
  name: string;
  title: string;
  description: string;
  category: string | null;
  version: string | null;
  installed: boolean;
  enabled: boolean;
  marketplace: string;
  marketplacePath: string | null;
}

interface CxMarketplace {
  name: string;
  title: string;
  path: string | null;
  plugins: CxPlugin[];
}

interface CxPluginData {
  marketplaces: CxMarketplace[];
  loadErrors: string[];
  featured: Set<string>;
  all: CxPlugin[];
}

function parsePluginList(result: any): CxPluginData {
  const r = obj(result) ?? {};
  const marketplaces: CxMarketplace[] = [];
  for (const m of arr(r, 'marketplaces')) {
    const name = str(m, 'name');
    if (!name) continue;
    const path = str(m, 'path');
    const plugins: CxPlugin[] = [];
    for (const p of arr(m, 'plugins')) {
      const pName = str(p, 'name');
      if (!pName) continue;
      const ui = o(p, 'interface');
      plugins.push({
        id: str(p, 'id') ?? `${pName}@${name}`,
        name: pName,
        title: str(ui, 'displayName') ?? pName,
        description: str(ui, 'shortDescription') ?? str(ui, 'longDescription') ?? '',
        category: str(ui, 'category'),
        version: str(p, 'localVersion') ?? str(p, 'version'),
        installed: bool(p, 'installed') === true,
        enabled: bool(p, 'enabled') !== false,
        marketplace: name,
        marketplacePath: path,
      });
    }
    marketplaces.push({ name, title: str(o(m, 'interface'), 'displayName') ?? name, path, plugins });
  }
  const loadErrors = arr(r, 'marketplaceLoadErrors')
    .map((e) => str(e, 'message'))
    .filter((x): x is string => !!x);
  const featured = new Set(arr(r, 'featuredPluginIds').map(String));
  return { marketplaces, loadErrors, featured, all: marketplaces.flatMap((m) => m.plugins) };
}

/** "method not found" from an older Codex: the plugin commands came with newer versions. */
function friendly(e: unknown): string {
  const msg = errText(e) || 'Codex did not answer';
  return /method not found|unknown variant/i.test(msg) ? 'This Codex is too old to manage plugins. Update it in Settings → Codex → Account & CLI.' : msg;
}

/** Codex' own catalog (cached under .tmp/plugins) can't be removed. */
const builtIn = (m: CxMarketplace) => !!m.path && m.path.replace(/\\/g, '/').includes('/.tmp/plugins/');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Rows shown at once in a search (Codex' remote catalog alone has thousands). */
const MAX_ROWS = 60;

const TABS = [
  { value: 'installed', label: 'Installed' },
  { value: 'discover', label: 'Discover' },
  { value: 'markets', label: 'Marketplaces' },
];

const MARKET_PAGE = 'codex.plugins.m:';
const FOOT = 'Plugins are loaded when a chat starts: start a new chat after installing or removing one.';

export class CodexPlugins {
  private data: Cached<CxPluginData>;
  private tab = 'installed';
  private query = '';
  /** Per marketplace: the filter of its plugin list. */
  private marketQuery = new Map<string, string>();
  /** plugin id / 'm:' + marketplace name → the running action ('install', 'uninstall', 'update', 'remove'). */
  private ops = new Map<string, string>();
  /** A repository Codex couldn't add as a marketplace: the "Set up with AI" button for it. */
  private lastFailed: { source: string; why: string } | null = null;

  constructor(
    private b: CodexBackend,
    /** Why Codex can't be asked now (null = it can). */
    private blocked: () => Promise<string | null>,
    private changed: () => void,
  ) {
    this.data = new Cached(
      () => this.b.client.rpc('plugin/list', {}, 90_000).then(parsePluginList),
      () => this.changed(),
      60_000,
    );
  }

  /** The pages of this provider: 'codex.plugins' and one per marketplace. */
  static owns(page: string): boolean {
    return page === 'codex.plugins' || page.startsWith(MARKET_PAGE);
  }

  // ------------------------------------------------------------------ pages

  async page(id: string): Promise<SettingsPage> {
    const title = id === 'codex.plugins' ? 'Plugins' : this.marketTitle(id.slice(MARKET_PAGE.length));
    const why = await this.blocked();
    if (why) return unavailablePage(id, title, 'CODEX', why, { page: 'codex.cli', label: 'Account & CLI', description: 'Install Codex, or see why it can’t be used' });
    const done = await this.data.ensure(10_000);
    const d = this.data.value;
    if (!d) {
      if (!done) return { id, title, sections: [{ id: 'loading', title: '', agent: 'CODEX', items: [{ kind: 'info', id: 'loading', label: 'Loading plugins…', value: '', tone: 'muted' }] }], loading: true };
      return { id, title, sections: [], error: friendly(this.data.error) };
    }
    const page = id === 'codex.plugins' ? this.mainPage(d) : this.marketPage(id, d);
    return { ...page, loading: !done || this.data.loading || undefined };
  }

  private marketTitle(name: string): string {
    return this.data.value?.marketplaces.find((m) => m.name === name)?.title ?? name;
  }

  /** The error lines: the last read failed, a marketplace could not be read. */
  private errorItems(d: CxPluginData): SettingItem[] {
    const items: SettingItem[] = [];
    if (this.data.error) items.push({ kind: 'info', id: 'error', label: 'Could not read the plugins', value: '', description: friendly(this.data.error), tone: 'error' });
    d.loadErrors.forEach((e, i) => items.push({ kind: 'info', id: `loadError${i}`, label: 'A marketplace could not be read', value: '', description: e, tone: 'error' }));
    return items;
  }

  private progress(op: string): string {
    return op === 'install' ? 'Installing…' : op === 'uninstall' || op === 'remove' ? 'Removing…' : op === 'update' ? 'Updating…' : 'Working…';
  }

  /** PluginCard as a row: title, "v1.2 · category · marketplace", description, its action. */
  private row(p: CxPlugin, showMarket = true): SettingListRow {
    const op = this.ops.get(p.id);
    const meta = [p.version ? `v${p.version}` : null, p.category, showMarket ? p.marketplace : null, p.installed && !p.enabled ? 'disabled' : null].filter(Boolean).join(' · ');
    const desc = p.description.trim();
    return {
      id: p.id,
      title: p.title,
      subtitle: [meta || null, desc ? (desc.length > 240 ? `${desc.slice(0, 240)}…` : desc) : null].filter(Boolean).join('\n') || null,
      status: op ? this.progress(op) : p.installed ? 'Installed' : null,
      statusTone: op ? 'warn' : p.installed ? 'ok' : null,
      actions: op
        ? []
        : p.installed
          ? [{ id: 'uninstall', label: 'Uninstall', danger: true, confirm: `Uninstall ${p.title}?` }]
          : [{ id: 'install', label: 'Install' }],
    };
  }

  private search(list: CxPlugin[], q: string, withMarket: boolean): CxPlugin[] {
    const t = q.trim().toLowerCase();
    if (!t) return list;
    return list.filter((p) => `${p.title}\n${p.name}\n${p.description}\n${p.category ?? ''}${withMarket ? `\n${p.marketplace}` : ''}`.toLowerCase().includes(t));
  }

  private mainPage(d: CxPluginData): SettingsPage {
    const items: SettingItem[] = [{ kind: 'select', id: 'tab', label: 'Show', value: this.tab, options: TABS }, ...this.errorItems(d)];
    const installed = d.all.filter((p) => p.installed);
    const available = d.all.filter((p) => !p.installed);
    if (this.tab === 'discover') {
      // featured ones first while nothing is typed (the catalog's own order otherwise)
      const ordered = this.query.trim() ? available : [...available.filter((p) => d.featured.has(p.id)), ...available.filter((p) => !d.featured.has(p.id))];
      const results = this.search(ordered, this.query, true);
      items.push(
        { kind: 'text', id: 'query', label: 'Search', value: this.query, placeholder: `Search ${available.length} plugins` },
        {
          kind: 'list',
          id: 'discover',
          label: 'Plugins',
          description: results.length > MAX_ROWS ? `${plural(results.length, 'plugin')} · the first ${MAX_ROWS} shown: search to narrow` : `${results.length} plugin(s)`,
          rows: results.slice(0, MAX_ROWS).map((p) => this.row(p)),
          emptyText: this.query.trim() ? `No plugin matches “${this.query.trim()}”` : 'No plugins to install. Add a marketplace from GitHub.',
        },
      );
    } else if (this.tab === 'markets') {
      items.push(
        {
          kind: 'button',
          id: 'addMarket',
          label: 'Add a marketplace',
          style: 'primary',
          description: 'GitHub owner/repo, owner/repo@branch, or a git URL',
          form: [{ id: 'source', label: 'Marketplace', kind: 'text', placeholder: 'owner/repo', required: true }],
        },
        ...(this.lastFailed ? [setupWithAiItem('CODEX', this.lastFailed.source, this.lastFailed.why)] : []),
      );
    } else {
      items.push({
        kind: 'list',
        id: 'installed',
        label: 'Installed plugins',
        rows: installed.map((p) => this.row(p)),
        emptyText: 'No plugins installed. Find some in Discover, or add a marketplace from GitHub.',
      });
    }
    const sections: SettingsSection[] = [{ id: 'plugins', title: '', agent: 'CODEX', description: this.tab === 'markets' ? null : FOOT, items }];
    if (this.tab === 'markets') {
      sections.push({
        id: 'markets',
        title: '',
        agent: 'CODEX',
        description:
          "A marketplace is a git repository with a plugin catalog. Codex reads its own catalogs and Claude Code's (.claude-plugin/marketplace.json). Tap one to see its plugins and install them here; Discover lists the plugins of every marketplace.",
        items: d.marketplaces.map((m) => {
          const op = this.ops.get(`m:${m.name}`);
          return {
            kind: 'page' as const,
            id: MARKET_PAGE + m.name,
            label: m.title,
            icon: 'extension',
            description: [plural(m.plugins.length, 'plugin'), builtIn(m) ? 'built into Codex' : null, m.title !== m.name ? m.name : null].filter(Boolean).join(' · '),
            badge: op ? this.progress(op) : String(m.plugins.length),
          };
        }),
      });
      sections.push({ id: 'foot', title: '', agent: 'CODEX', description: FOOT, items: [] });
    }
    return { id: 'codex.plugins', title: 'Plugins', sections };
  }

  private marketPage(id: string, d: CxPluginData): SettingsPage {
    const name = id.slice(MARKET_PAGE.length);
    const m = d.marketplaces.find((x) => x.name === name);
    if (!m) return { id, title: name, sections: [], error: `${name} is not a Codex marketplace (any more).` };
    const op = this.ops.get(`m:${m.name}`);
    const items: SettingItem[] = [...this.errorItems(d)];
    items.push({ kind: 'button', id: 'upgrade', label: op === 'update' ? 'Updating…' : 'Update catalog', disabled: !!op });
    if (!builtIn(m)) items.push({ kind: 'button', id: 'removeMarket', label: op === 'remove' ? 'Removing…' : 'Remove', style: 'danger', disabled: !!op, confirm: `Remove the marketplace ${m.title}?` });
    // its plugins, to install right here (the same as from Discover)
    const plugins = [...m.plugins].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    const q = this.marketQuery.get(m.name) ?? '';
    if (plugins.length > 8) items.push({ kind: 'text', id: 'query', label: 'Search', value: q, placeholder: `Search ${plugins.length} plugins in ${m.title}` });
    const shown = this.search(plugins, q, false);
    items.push({
      kind: 'list',
      id: 'plugins',
      label: 'Plugins',
      description: shown.length > MAX_ROWS ? `${plural(shown.length, 'plugin')} · the first ${MAX_ROWS} shown: search to narrow` : null,
      rows: shown.slice(0, MAX_ROWS).map((p) => this.row(p, false)),
      emptyText: plugins.length ? `No plugin matches “${q.trim()}”` : 'No plugins in this marketplace yet. Update it if it was just added.',
    });
    return {
      id,
      title: m.title,
      sections: [
        {
          id: 'market',
          title: '',
          agent: 'CODEX',
          description: [plural(m.plugins.length, 'plugin'), builtIn(m) ? 'built into Codex' : null, m.title !== m.name ? m.name : null, m.path].filter(Boolean).join(' · '),
          items,
        },
        { id: 'foot', title: '', agent: 'CODEX', description: FOOT, items: [] },
      ],
    };
  }

  // ------------------------------------------------------------------ edits

  change(page: string, id: string, value: unknown) {
    if (page === 'codex.plugins' && id === 'tab') this.tab = TABS.some((t) => t.value === value) ? String(value) : 'installed';
    else if (page === 'codex.plugins' && id === 'query') this.query = String(value ?? '');
    else if (page.startsWith(MARKET_PAGE) && id === 'query') this.marketQuery.set(page.slice(MARKET_PAGE.length), String(value ?? ''));
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    if (id === 'addMarket') return this.addMarket((values?.source ?? '').trim());
    if (page.startsWith(MARKET_PAGE)) {
      const name = page.slice(MARKET_PAGE.length);
      const title = this.marketTitle(name);
      if (id === 'upgrade')
        return this.run(`m:${name}`, 'update', 'marketplace/upgrade', { marketplaceName: name }, (res) => {
          const errs = arr(res, 'errors')
            .map((e) => str(e, 'message'))
            .filter(Boolean);
          return errs.length ? `${title}: ${errs[0]}` : `${title} is up to date`;
        });
      if (id === 'removeMarket') return this.run(`m:${name}`, 'remove', 'marketplace/remove', { marketplaceName: name }, () => `${title} removed`);
    }
    if (!rowId || (actionId !== 'install' && actionId !== 'uninstall')) return;
    const p = this.data.value?.all.find((x) => x.id === rowId);
    if (!p) throw new Error('That plugin is not in the list any more: refresh the page');
    if (actionId === 'uninstall') return this.run(p.id, 'uninstall', 'plugin/uninstall', { pluginId: p.id }, () => `${p.title} uninstalled`);
    return this.run(
      p.id,
      'install',
      'plugin/install',
      { pluginName: p.name, ...(p.marketplacePath ? { marketplacePath: p.marketplacePath } : { remoteMarketplaceName: p.marketplace }) },
      (res) => {
        const apps = arr(res, 'appsNeedingAuth')
          .map((a) => str(a, 'name'))
          .filter(Boolean);
        return `${p.title} installed. Start a new chat to use it.${apps.length ? ` Sign in to ${apps.join(', ')} when Codex asks.` : ''}`;
      },
    );
  }

  /** One plugin / marketplace change: marked busy, then the list is read again and the "/" menu reads its skills. */
  private async run(key: string, op: string, method: string, params: J, done: (res: any) => string): Promise<string> {
    if (this.ops.has(key)) throw new Error('Already working on it');
    this.ops.set(key, op);
    this.changed();
    try {
      const res = await this.b.client.rpc(method, params, 300_000);
      // a plugin brings skills: the "/" menu reads them again
      void this.b.refreshSkills(true);
      return done(res);
    } catch (e) {
      throw new Error(friendly(e));
    } finally {
      this.ops.delete(key);
      await this.data.reload(15_000);
      this.changed();
    }
  }

  private async addMarket(source: string): Promise<string> {
    if (!source) throw new Error('Enter the marketplace (owner/repo)');
    const key = `add:${source}`;
    if (this.ops.has(key)) throw new Error('Already adding it');
    this.ops.set(key, 'add');
    try {
      const res = await this.b.client.rpc('marketplace/add', { source }, 300_000);
      const name = str(res, 'marketplaceName') ?? source;
      this.lastFailed = null;
      this.tab = 'markets';
      return bool(res, 'alreadyAdded') === true ? `${name} was already added` : `Added ${name}: pick its plugins below.`;
    } catch (e) {
      // a repository Codex can't add as a marketplace: an AI agent may set it up
      this.lastFailed = { source, why: friendly(e) };
      throw new Error(friendly(e));
    } finally {
      this.ops.delete(key);
      await this.data.reload(15_000);
      void this.b.refreshSkills(true);
      this.changed();
    }
  }
}
