// Port of the app's data/memory/MemoryBridgeClient.kt: the bridge's /api/memory (its pkg/memory), memory files and
// chat history kept next to the agents (~/.antigem/memory).
import { createHash } from 'node:crypto';
import type { AgentKind } from '../../../shared/model';

/** The bridge's authenticated requests (BridgeManager). */
export interface MemoryBridge {
  fetch(p: string, init?: RequestInit): Promise<Response>;
}

export interface Memory {
  id: string;
  file: string;
  /** global | project */
  scope: string;
  project: string;
  project_dir: string;
  /** always | passive */
  mode: string;
  description: string;
  text: string;
  /** unix ms */
  updated: number;
  /** Who saved it: claude, codex, opencode, agy or user. */
  agent: string;
  source: string;
  path: string;
}

/** What happened to one ```antigem-memory block. */
export interface Applied {
  key: string;
  found: boolean;
  /** saved | updated | deleted | error */
  action?: string;
  id?: string;
  description?: string;
  error?: string;
  undone?: boolean;
  at?: number;
}

export interface HistoryHit {
  chat_id: string;
  title: string;
  agent: string;
  project: string;
  file: string;
  path: string;
  updated: number;
  snippet: string;
  score: number;
}

/** One saved chat. */
export interface HistoryChat {
  chat_id: string;
  title: string;
  /** claude, codex, opencode or agy */
  agent: string;
  project: string;
  file: string;
  path: string;
  started: number;
  updated: number;
  /** The user edited it: kept as is, the chat's new messages are added at the end. */
  edited: boolean;
  size: number;
}

/** One message of a chat for the bridge. */
export interface Turn {
  role: 'user' | 'assistant' | 'summary';
  text: string;
  at: number;
}

/** The key the bridge files a memory block under: sha1 of its text without \r, trimmed. */
export function blockKey(body: string): string {
  return createHash('sha1').update(body.replace(/\r/g, '').trim()).digest('hex');
}

const agentName = (a: AgentKind) => a.toLowerCase();

export class MemoryClient {
  constructor(private bridge: MemoryBridge) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(p: string, body?: unknown, timeoutMs = 10_000): Promise<any> {
    const init: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.method = 'POST';
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await this.bridge.fetch(`/api/memory/${p}`, init);
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) {
      if (res.status === 404) throw new Error('The bridge is too old for Agent memory: restart it (Settings → Bridge & connection).');
      throw new Error(`HTTP ${res.status}`);
    }
    const obj = JSON.parse(text);
    if (obj?.success === false) throw new Error(obj.error || 'The bridge refused');
    return obj;
  }

  // ------------------------------------------------------------------ chats

  /** The memory text for a chat's first message; gives up after [timeoutMs]. */
  async context(project: string | null, agent: AgentKind, message: string, limit: number, history: boolean, timeoutMs: number): Promise<string> {
    const r = await this.call('context', { project: project ?? '', agent: agentName(agent), message, limit, history }, timeoutMs);
    return typeof r.text === 'string' ? r.text : '';
  }

  /** A chat after a turn: the bridge applies its new memory blocks and (with [history]) rewrites its history file. */
  async sync(project: string | null, agent: AgentKind, chatId: string, title: string, history: boolean, turns: Turn[]): Promise<Applied[]> {
    const r = await this.call('sync', { project: project ?? '', agent: agentName(agent), chat_id: chatId, title, history, turns }, 60_000);
    return Array.isArray(r.applied) ? r.applied : [];
  }

  /** Removes a chat's history file; that chat is not saved again (new chats are). */
  async deleteHistory(chatId: string): Promise<void> {
    await this.call('history/delete', { chat_id: chatId });
  }

  // ------------------------------------------------------------------ the history page

  /** Every saved chat, newest first. */
  async historyList(): Promise<HistoryChat[]> {
    const r = await this.call('history/list');
    return Array.isArray(r.chats) ? r.chats : [];
  }

  /** A saved chat and its file's text. */
  async historyGet(chatId: string): Promise<{ chat: HistoryChat | null; text: string }> {
    const r = await this.call(`history/get?chat_id=${encodeURIComponent(chatId)}`);
    return { chat: r.chat ?? null, text: typeof r.text === 'string' ? r.text : '' };
  }

  /** Removes every saved chat (they are not saved again; new chats are). Returns how many. */
  async historyClear(): Promise<number> {
    const r = await this.call('history/clear', {});
    return Number(r.removed) || 0;
  }

  // ------------------------------------------------------------------ the chip

  async applied(key: string): Promise<Applied> {
    const r = await this.call(`applied?key=${encodeURIComponent(key)}`);
    return r.applied ?? { key, found: false };
  }

  async undo(key: string): Promise<Applied> {
    const r = await this.call('undo', { key });
    return r.applied ?? { key, found: false };
  }

  // ------------------------------------------------------------------ settings

  /** Every memory and the folder they are in. */
  async list(): Promise<{ root: string; memories: Memory[] }> {
    const r = await this.call('list');
    return { root: typeof r.root === 'string' ? r.root : '', memories: Array.isArray(r.memories) ? r.memories : [] };
  }

  async save(m: { id: string | null; file: string; scope: string; project: string | null; mode: string; description: string; text: string }): Promise<Memory> {
    const r = await this.call('save', { ...m, id: m.id ?? '', project: m.project ?? '' });
    if (!r.memory) throw new Error('The bridge sent no memory back');
    return r.memory;
  }

  async delete(id: string): Promise<void> {
    await this.call('delete', { id });
  }

  async search(query: string, project?: string | null): Promise<{ memories: Memory[]; history: HistoryHit[] }> {
    const r = await this.call(`search?q=${encodeURIComponent(query)}${project ? `&project=${encodeURIComponent(project)}` : ''}`);
    return { memories: Array.isArray(r.memories) ? r.memories : [], history: Array.isArray(r.history) ? r.history : [] };
  }
}
