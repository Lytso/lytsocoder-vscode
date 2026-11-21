// Agent memory (port of the app's data/memory/AgentMemory.kt and MemorySync.kt): memories every agent keeps across
// chats, and a cleaned copy of every chat they can look up. The bridge keeps both next to the agents
// (~/.antigem/memory, its pkg/memory). Off by default; when on, it can still be off for single agents. Never for
// Jarvis chats.
//
// - A chat's first message (and its first after the chat was compacted) carries the memory text the bridge builds:
//   the "always" memories in full, the most relevant others by name, where the past chats are, and how to save a
//   memory (an ```antigem-memory block in the reply).
// - After every finished turn (any agent, chat on screen or not) and when a chat is opened, the chat goes to the
//   bridge, which applies the replies' new memory blocks and rewrites the chat's history file.
import { createHash } from 'node:crypto';
import type { AgentKind, ChatMessage } from '../../../shared/model';
import type { HostToView } from '../../../shared/protocol';
import { uriToPath } from '../paths';
import { cleanTitle, hiddenBlock } from '../text';
import type { ChatState, KeyValueStore, Logger, SendRequest } from '../types';
import { blockKey, MemoryClient, type MemoryBridge } from './client';
import { MemorySettings } from './settings';
import { turnsOf } from './turns';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MEMORY_AGENTS, type MemoryHooks, type MemoryHostApi, type MemoryRequestMsg } from './types';

/** Chats remembered for "send the memory text again" and their compaction count. */
const MAX_REMEMBERED = 600;
/** How long a first message waits for the memory text before it goes without it (the bridge runs on this machine). */
const WAIT_MS = 1_500;
/** Idle this long (and still idle) = the turn is over. */
const SETTLE_MS = 1_500;

export interface AgentMemoryOptions {
  bridge: MemoryBridge;
  store: KeyValueStore;
  log: Logger;
}

interface Tracked {
  agent: AgentKind;
  unsub: () => void;
  /** It worked since the send. */
  saw: boolean;
  last: ChatState | null;
  settle?: NodeJS.Timeout;
  giveUp?: NodeJS.Timeout;
}

const running = (s: ChatState) => s.isStreaming || !!s.messages[s.messages.length - 1]?.isStreaming || !!s.conversation?.isRunning;
const waiting = (s: ChatState) => s.approvals.length > 0 || !!s.question;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AgentMemory implements MemoryHooks {
  readonly client: MemoryClient;
  readonly settings: MemorySettings;
  api: MemoryHostApi | null = null;
  private store: KeyValueStore;
  private log: Logger;
  /** chat id → what was sent last time (the same again: nothing to send). */
  private lastSent = new Map<string, string>();
  /** One sync at a time. */
  private lock: Promise<void> = Promise.resolve();
  /** chat id → its message being sent (the next one waits for it: messages go in order). */
  private queues = new Map<string, Promise<void>>();
  /** Chats sent from a view, followed until their turn is over. */
  private tracked = new Map<string, Tracked>();
  /** The chat lists: chats seen working (ChatCompletionMonitor) and their settle timers. */
  private busy = new Set<string>();
  private settling = new Map<string, NodeJS.Timeout>();
  private timers = new Set<NodeJS.Timeout>();
  private unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(opts: AgentMemoryOptions) {
    this.client = new MemoryClient(opts.bridge);
    this.store = opts.store;
    this.log = opts.log;
    this.settings = new MemorySettings(this);
  }

  bind(api: MemoryHostApi) {
    this.api = api;
    for (const b of api.allBackends()) this.unsubs.push(b.onChange((w) => w === 'conversations' && this.scan()));
    this.scan();
  }

  // ------------------------------------------------------------------ settings (AgentMemory.kt)

  enabled(): boolean {
    return this.store.get<boolean>('memory.enabled') === true;
  }
  setEnabled(on: boolean) {
    this.store.set('memory.enabled', on);
    this.changed();
  }

  /** The agents memory is on for (while enabled). */
  agents(): AgentKind[] {
    return this.store.get<AgentKind[]>('memory.agents') ?? MEMORY_AGENTS;
  }
  setAgents(list: AgentKind[]) {
    this.store.set('memory.agents', MEMORY_AGENTS.filter((a) => list.includes(a)));
  }

  /** How many memories a new chat gets listed by name, besides the "always" ones. */
  listLimit(): number {
    const n = Number(this.store.get<number>('memory.listLimit') ?? DEFAULT_LIST_LIMIT);
    return Number.isFinite(n) ? Math.max(0, Math.min(MAX_LIST_LIMIT, Math.round(n))) : DEFAULT_LIST_LIMIT;
  }
  setListLimit(n: number) {
    this.store.set('memory.listLimit', Math.max(0, Math.min(MAX_LIST_LIMIT, Math.round(n))));
  }

  /** Keep a cleaned copy of every chat the agents can look up. */
  saveHistory(): boolean {
    return this.store.get<boolean>('memory.saveHistory') !== false;
  }
  setSaveHistory(on: boolean) {
    this.store.set('memory.saveHistory', on);
  }

  isOnFor(agent: AgentKind | null | undefined): boolean {
    return !!agent && this.enabled() && this.agents().includes(agent);
  }

  /** Memories changed (a reply saved one, an Undo, the settings pages): chips ask again, pages reload. */
  changed() {
    this.api?.broadcast({ type: 'memoryChanged', enabled: this.enabled() });
    this.api?.refreshPages();
  }

  // ------------------------------------------------------------------ "send the memory text again"

  private resendList(): string[] {
    return this.store.get<string[]>('memory.resend') ?? [];
  }

  /** The chat lost its memory text (it was compacted): its next message carries it again. */
  forget(chatId: string) {
    if (!chatId) return;
    const list = [...this.resendList().filter((x) => x !== chatId), chatId];
    this.store.set('memory.resend', list.slice(-MAX_REMEMBERED));
  }

  /** The chat got its memory text. */
  private markSent(chatId: string) {
    const list = this.resendList();
    if (list.includes(chatId)) this.store.set('memory.resend', list.filter((x) => x !== chatId));
  }

  /**
   * A new summary in the chat (Claude compacted it; Codex and OpenCode show their compactions the same way): the
   * first message's memory text was summarized away, so the next message carries it again.
   */
  private noteSummaries(chatId: string, messages: ChatMessage[]) {
    const n = messages.filter((m) => m.role === 'SUMMARY' && !m.isStreaming).length;
    const map = { ...(this.store.get<Record<string, number>>('memory.summaries') ?? {}) };
    const seen = map[chatId];
    if (seen === n) return;
    if (seen !== undefined && n > seen) this.forget(chatId);
    delete map[chatId];
    map[chatId] = n;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete map[k];
    this.store.set('memory.summaries', map);
  }

  // ------------------------------------------------------------------ sending (ChatViewModel.sendMessage)

  async send(req: SendRequest, agent: AgentKind, typed: string, dispatch: (req: SendRequest) => Promise<void>): Promise<void> {
    const id = req.conversationId;
    const before = this.queues.get(id);
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.queues.set(id, mine);
    try {
      if (before) await before;
      const memory = await this.memoryFor(req, agent, typed);
      // follow the turn: when it is over the chat goes to the bridge
      if (this.isOnFor(agent)) this.track(id, agent);
      const sending = dispatch(memory ? { ...req, text: withMemory(req.text, memory) } : req);
      if (memory) this.markSent(id);
      // the next message of this chat may go now (after this one)
      release();
      await sending;
    } finally {
      release();
      if (this.queues.get(id) === mine) this.queues.delete(id);
    }
  }

  /** The memory text this message carries, or null (not wanted, memory empty, bridge slow or unreachable). */
  private async memoryFor(req: SendRequest, agent: AgentKind, typed: string): Promise<string | null> {
    if (!this.isOnFor(agent)) return null;
    if (!req.isNew && !this.resendList().includes(req.conversationId)) return null;
    const conv = this.api?.conversations().find((c) => c.id === req.conversationId);
    // not an Antigravity cloud chat: it runs in Google's cloud and cannot read the memory files
    if (conv?.cloudProjectId) return null;
    const uri = conv ? conv.workspaceUri : req.workspaceUri;
    try {
      const text = await Promise.race([
        this.client.context(uri ? uriToPath(uri) : null, agent, typed, this.listLimit(), this.saveHistory(), WAIT_MS),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timed out')), WAIT_MS + 500)),
      ]);
      return text.trim() ? text : null;
    } catch (e) {
      this.log(`[memory] no memory text for this message: ${errText(e)}`);
      return null;
    }
  }

  // ------------------------------------------------------------------ after a turn (MemorySync.kt)

  /** Follows a chat sent from a view until its turn is over, then syncs it. */
  private track(id: string, agent: AgentKind) {
    const b = this.api?.backend(agent);
    if (!b) return;
    let t = this.tracked.get(id);
    if (!t) {
      const nt: Tracked = { agent, unsub: () => undefined, saw: false, last: null };
      this.tracked.set(id, nt);
      nt.unsub = b.subscribe(id, (s) => this.onState(id, nt, s));
      t = nt;
    }
    clearTimeout(t.giveUp);
    const tr = t;
    // a send that never started (it failed, a local command) is let go
    tr.giveUp = setTimeout(() => !tr.saw && this.untrack(id), 3 * 60_000);
  }

  private onState(id: string, t: Tracked, s: ChatState) {
    if (this.tracked.get(id) !== t) return;
    t.last = s;
    if (running(s)) {
      t.saw = true;
      clearTimeout(t.settle);
      t.settle = undefined;
      return;
    }
    if (!t.saw || waiting(s) || s.queued.length || t.settle) return;
    t.settle = setTimeout(() => {
      t.settle = undefined;
      const now = t.last;
      if (!now || running(now) || waiting(now) || now.queued.length) return;
      this.untrack(id);
      void this.syncChat(id, t.agent);
    }, SETTLE_MS);
  }

  private untrack(id: string) {
    const t = this.tracked.get(id);
    if (!t) return;
    this.tracked.delete(id);
    clearTimeout(t.settle);
    clearTimeout(t.giveUp);
    t.unsub();
  }

  /**
   * Any chat that stops working (shown as running in the chat list and no longer is, for a moment: the app's
   * ChatCompletionMonitor), on screen or not: Jarvis' task chats, chats of other windows.
   */
  private scan() {
    const api = this.api;
    if (!api || this.disposed) return;
    if (!this.enabled()) {
      this.busy.clear();
      return;
    }
    const isBusy = (c: { agent: AgentKind; isRunning: boolean; notFullyIdle: boolean }) => c.isRunning || (c.agent === 'AGY' && c.notFullyIdle);
    for (const c of api.conversations()) {
      if (isBusy(c)) {
        this.busy.add(c.id);
        clearTimeout(this.settling.get(c.id));
        this.settling.delete(c.id);
        continue;
      }
      if (!this.busy.has(c.id) || this.settling.has(c.id)) continue;
      // Antigravity's running flag can blink off between steps
      this.settling.set(
        c.id,
        setTimeout(() => {
          this.settling.delete(c.id);
          const now = this.api?.conversations().find((x) => x.id === c.id);
          if (now && isBusy(now)) return;
          this.busy.delete(c.id);
          // its messages settle first
          this.later(1_500, () => void this.syncChat(c.id, c.agent));
        }, c.agent === 'AGY' ? 1_200 : 300),
      );
    }
  }

  opened(conversationId: string, agent: AgentKind) {
    if (!this.isOnFor(agent)) return;
    // its messages load first; only while it is still shown
    this.later(2_500, () => {
      if (this.api?.isShown(conversationId)) void this.syncChat(conversationId, agent);
    });
  }

  onChatDeleted(conversationId: string) {
    this.lastSent.delete(conversationId);
    this.untrack(conversationId);
    if (!conversationId) return;
    // also with memory off: it must not come back when memory is turned on (memories it saved stay)
    this.client.deleteHistory(conversationId).catch((e) => this.log(`[memory] history of ${conversationId} not deleted: ${errText(e)}`));
  }

  /** Sends the chat to the bridge (nothing when memory is off for its agent or nothing changed). */
  async syncChat(id: string, agent: AgentKind): Promise<void> {
    const api = this.api;
    if (!api || this.disposed || !id || !this.isOnFor(agent) || api.isJarvisChat(id)) return;
    const st = await this.stateOf(id, agent);
    if (!st || this.disposed) return;
    this.noteSummaries(id, st.messages);
    const conv = st.conversation ?? api.conversations().find((c) => c.id === id) ?? null;
    // the chat's start date names its history file
    const turns = turnsOf(st.messages, conv?.createdAt || st.messages[0]?.createdAt || Date.now());
    if (!turns.length) return;
    const history = this.saveHistory();
    // history off: only replies with a memory block need the bridge
    if (!history && !turns.some((t) => t.role === 'assistant' && t.text.includes('antigem-memory'))) return;
    const title = cleanTitle(conv?.title ?? '');
    const project = conv?.workspaceUri ? uriToPath(conv.workspaceUri) : null;
    const fp = createHash('sha1')
      .update(JSON.stringify([turns.map((t) => [t.role, t.text]), history, title, project]))
      .digest('hex');
    if (this.lastSent.get(id) === fp) return;
    const run = this.lock.then(async () => {
      if (this.lastSent.get(id) === fp || this.disposed) return;
      try {
        const applied = await this.client.sync(project, agent, id, title, history, turns);
        this.lastSent.set(id, fp);
        if (applied.length) this.changed();
      } catch (e) {
        this.log(`[memory] chat ${id} not sent to the bridge: ${errText(e)}`);
      }
    });
    this.lock = run;
    await run;
  }

  /** The chat's live state once its messages are loaded (it is loaded for a moment when no view shows it). */
  private stateOf(id: string, agent: AgentKind): Promise<ChatState | null> {
    const b = this.api?.backend(agent);
    if (!b) return Promise.resolve(null);
    const get = () => {
      try {
        return b.getState(id);
      } catch {
        return null;
      }
    };
    const now = get();
    if (now && !now.isLoading && now.messages.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      let done = false;
      let unsub: (() => void) | null = null;
      const finish = (s: ChatState | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub?.();
        resolve(s);
      };
      const timer = setTimeout(() => finish(get()), 20_000);
      const u = b.subscribe(id, (s) => {
        if (!s.isLoading && s.messages.length) finish(s);
      });
      if (done) u();
      else unsub = u;
    });
  }

  // ------------------------------------------------------------------ the chip (MemoryChip.kt)

  async request(msg: MemoryRequestMsg, chat: { id: string; agent: AgentKind } | null): Promise<HostToView> {
    const key = blockKey(msg.body);
    const enabled = this.enabled();
    try {
      if (msg.op === 'undo') {
        const applied = await this.client.undo(key);
        this.changed();
        // the chat's history file then notes it as undone (a later chat reading it must not save the memory again)
        if (chat) {
          this.lastSent.delete(chat.id);
          void this.syncChat(chat.id, chat.agent);
        }
        return { type: 'memoryResult', reqId: msg.reqId, applied, enabled };
      }
      if (!enabled) return { type: 'memoryResult', reqId: msg.reqId, applied: null, enabled };
      return { type: 'memoryResult', reqId: msg.reqId, applied: await this.client.applied(key), enabled };
    } catch (e) {
      return { type: 'memoryResult', reqId: msg.reqId, applied: null, enabled, error: errText(e) };
    }
  }

  // ------------------------------------------------------------------

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const t of this.settling.values()) clearTimeout(t);
    this.settling.clear();
    for (const id of [...this.tracked.keys()]) this.untrack(id);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}

/** [text] with the memory text hidden in front (after a leading /command: the CLI only runs a leading one). */
function withMemory(text: string, memory: string): string {
  const block = hiddenBlock(memory);
  return text.trimStart().startsWith('/') ? `${text}\n\n${block}` : block + text;
}
