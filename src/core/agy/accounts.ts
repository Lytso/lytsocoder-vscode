// Antigravity account switcher (port of the app's data/remote/AgyAccounts.kt). The bridge does the work: it keeps copies
// of agy's login file in ~/.gemini/antigem-accounts and swaps them in (bridge/pkg/handlers/agy_accounts.go). The host
// only gets emails and dates, never tokens. Linux only: elsewhere agy keeps its login in the system keychain and the
// bridge answers supported: false.
//
// The bridge's own WebSocket (/ws) says when the signed-in login changed from outside (the Agy Accounts mini app, a
// terminal, a new sign-in): the backend re-checks the sign-in then (the app's AgyBridgeService.agyAccountEvents).
/* eslint-disable @typescript-eslint/no-explicit-any */
import WebSocket from 'ws';
import type { BridgeManager } from '../bridge/BridgeManager';
import type { Logger } from '../types';

export interface AgyAccount {
  name: string;
  email: string;
  authMethod: string;
  savedAt: number;
  usedAt: number;
  /** agy is signed in with this login now. */
  active: boolean;
}

export interface AgyAccountsState {
  supported: boolean;
  current: { signedIn: boolean; email: string; saved: boolean; error: string | null };
  accounts: AgyAccount[];
}

/** The signed-in login has no saved copy: the caller asks to save it first or to go on without it. */
export class AgyAccountNotSaved extends Error {
  constructor(readonly email: string) {
    super(`${email || 'This account'} isn't saved`);
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parse(o: any): AgyAccountsState {
  const cur = o?.current ?? {};
  return {
    supported: o?.supported !== false,
    current: { signedIn: cur.signedIn === true, email: String(cur.email ?? ''), saved: cur.saved === true, error: cur.error ? String(cur.error) : null },
    accounts: (Array.isArray(o?.accounts) ? o.accounts : []).map((a: any) => ({
      name: String(a?.name ?? ''),
      email: String(a?.email ?? ''),
      authMethod: String(a?.authMethod ?? ''),
      savedAt: Number(a?.savedAt ?? 0),
      usedAt: Number(a?.usedAt ?? 0),
      active: a?.active === true,
    })),
  };
}

export class AgyAccounts {
  state: AgyAccountsState | null = null;
  error: string | null = null;
  /** The action running (one at a time): which account (null = the signed-in one / none) and its label. */
  busy: { email: string | null; label: string } | null = null;
  /**
   * After "Add account" cleared the login: the next account that signs in is saved on its own. Only for that sign-in;
   * forgotten once used.
   */
  saveNextSignIn = false;
  private loading: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private wsTimer: NodeJS.Timeout | null = null;
  private wsBackoff = 1000;
  private debounce: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private bridge: BridgeManager,
    private hooks: {
      /** The state or the busy mark changed (the settings page is built again). */
      changed: () => void;
      /** agy's login was swapped from outside (the bridge's watcher): re-check sign-in, limits, models. */
      accountChanged: () => void;
      log: Logger;
    },
  ) {}

  private async call(action: string | null, body?: object): Promise<AgyAccountsState> {
    const p = action ? `/api/agy/accounts/${action}` : '/api/agy/accounts';
    const res = await this.bridge.fetch(p, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {});
    const text = await res.text();
    if (res.status === 404 && !action) throw new Error('The bridge is older than LytsoCoder (no account switching). Restart the bridge.');
    let o: any;
    try {
      o = JSON.parse(text);
    } catch {
      throw new Error(`The bridge answered HTTP ${res.status}`);
    }
    if (res.status === 409 && o?.error === 'current_not_saved') throw new AgyAccountNotSaved(String(o.email ?? ''));
    if (!res.ok || o?.success !== true) throw new Error(o?.error || `The bridge answered HTTP ${res.status}`);
    return parse(o);
  }

  /** Reads the saved accounts again (a read already running is shared). */
  refresh(): Promise<void> {
    if (!this.loading) {
      this.loading = this.call(null)
        .then(
          (s) => {
            const changed = JSON.stringify(s) !== JSON.stringify(this.state) || this.error != null;
            this.state = s;
            this.error = null;
            if (changed) this.hooks.changed();
          },
          (e) => {
            const was = this.error;
            this.error = errText(e);
            if (was !== this.error) this.hooks.changed();
          },
        )
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  /** One action on the bridge, one at a time. Throws AgyAccountNotSaved when the signed-in login would be lost. */
  private async perform(action: string, body: object, busy: { email: string | null; label: string }): Promise<void> {
    if (this.busy) throw new Error('Wait for the account change that is running');
    this.busy = busy;
    this.hooks.changed();
    try {
      this.state = await this.call(action, body);
      this.error = null;
    } catch (e) {
      if (!(e instanceof AgyAccountNotSaved)) this.error = errText(e);
      // the bridge's view is the truth (the login may have changed meanwhile)
      void this.refresh();
      throw e;
    } finally {
      this.busy = null;
      this.hooks.changed();
    }
  }

  saveCurrent(): Promise<void> {
    return this.perform('save', {}, { email: null, label: 'Saving…' });
  }

  /** `saveCurrent`: save the signed-in login first; `force`: go on without saving it. */
  switchTo(email: string, saveCurrent = false, force = false): Promise<void> {
    return this.perform('switch', { email, saveCurrent, force }, { email, label: 'Switching…' });
  }

  /** Add account: agy is signed out here (no logout call, so saved copies stay valid), ready for another sign-in. */
  async clearForNewSignIn(saveCurrent = false, force = false): Promise<void> {
    await this.perform('clear', { saveCurrent, force }, { email: null, label: 'Signing out…' });
    this.saveNextSignIn = true;
  }

  delete(email: string): Promise<void> {
    return this.perform('delete', { email }, { email, label: 'Deleting…' });
  }

  // ------------------------------------------------------------------ the bridge's /ws (agy_account_changed)

  /** Follows the bridge's broadcasts (idempotent; the bridge's watcher runs while agy's hub is online). */
  listen() {
    if (this.disposed || this.ws || this.wsTimer) return;
    if (this.bridge.suspended || this.bridge.state !== 'running') {
      this.retryLater(10_000);
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.bridge.wsUrl('/ws'), { headers: this.bridge.authHeaders() });
    } catch (e) {
      this.hooks.log(`[agy] accounts events: ${errText(e)}`);
      this.retryLater(this.wsBackoff);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.wsBackoff = 1000;
    });
    ws.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m?.type !== 'agy_account_changed') return;
      // a burst (the file is written, renamed, chmod-ed) becomes one check
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.debounce = null;
        if (!this.disposed) this.hooks.accountChanged();
      }, 300);
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.disposed) return;
      const delay = this.wsBackoff;
      this.wsBackoff = Math.min(this.wsBackoff * 2, 30_000);
      this.retryLater(delay);
    });
  }

  private retryLater(ms: number) {
    if (this.disposed || this.wsTimer) return;
    this.wsTimer = setTimeout(() => {
      this.wsTimer = null;
      this.listen();
    }, ms);
  }

  dispose() {
    this.disposed = true;
    if (this.wsTimer) clearTimeout(this.wsTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.wsTimer = null;
    this.debounce = null;
    this.ws?.close();
    this.ws = null;
  }
}
