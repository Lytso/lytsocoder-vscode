// Port of data/skills/AgentSkillsClient.kt: the bridge's /api/agent-skills/ routes. Each agent's own skills folder
// (add from GitHub, update, remove) and Antigravity plugins installed from GitHub with agy's own installer. The bridge
// does the downloads and the file work; tokens and files never pass through here.
import type { AgentKind } from '../../../shared/model';
import type { BridgeManager } from '../bridge/BridgeManager';

/** Where a skill folder came from (its `.antigem-source.json`), when it was added from GitHub. */
export interface SkillSource {
  repo: string;
  ref: string;
  path: string;
  installed_at?: string;
}

/** One skill in an agent's own skills folder. kind: skill, or plugin (a Claude Code plugin folder kept there). */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  kind: string;
  source?: SkillSource | null;
}

/** One skill found in a GitHub repository; `exists`: the agent already has a folder with this id. */
export interface RepoSkill {
  path: string;
  id: string;
  name: string;
  description: string;
  exists: boolean;
  same_source: boolean;
}

/** plugin_kinds: claude-marketplace, claude-plugin, codex-plugin, agy-plugin (the plugin formats the repo holds). */
export interface RepoInspect {
  repo: string;
  ref: string;
  subpath: string;
  skills: RepoSkill[];
  plugin_kinds: string[];
}

export const AGENT_IDS: Record<AgentKind, string> = { CLAUDE: 'claude', CODEX: 'codex', AGY: 'agy', OPENCODE: 'opencode' };

/** Downloads (and agy's installer) can take a while. */
const SLOW_MS = 7 * 60_000;
const FAST_MS = 20_000;

export class AgentSkillsClient {
  constructor(private bridge: BridgeManager) {}

  private async send<T>(p: string, init: RequestInit, timeoutMs: number): Promise<T & { success?: boolean; error?: string }> {
    const res = await this.bridge.fetch(`/api/agent-skills${p}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) {
      // a bridge from before this feature answers a plain 404
      if (res.status === 404) throw new Error('The bridge is older than the extension. Restart the bridge (Settings → Bridge & connection) to manage skills here.');
      throw new Error(`HTTP ${res.status}${text.trim() ? `: ${text.trim().slice(0, 120)}` : ''}`);
    }
    return JSON.parse(text);
  }

  private post<T>(p: string, body: object, slow = true) {
    return this.send<T>(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, slow ? SLOW_MS : FAST_MS);
  }

  async list(agent: AgentKind): Promise<{ dir: string; skills: AgentSkill[] }> {
    const res = await this.send<{ dir?: string; skills?: AgentSkill[] }>(`/?agent=${AGENT_IDS[agent]}`, {}, FAST_MS);
    if (!res.success) throw new Error(res.error || 'Could not list the skills');
    return { dir: res.dir ?? '', skills: res.skills ?? [] };
  }

  async inspect(agent: AgentKind, source: string): Promise<RepoInspect> {
    const res = await this.post<Partial<RepoInspect>>('/inspect', { source, agent: AGENT_IDS[agent] });
    if (!res.success) throw new Error(res.error || 'Could not read the repository');
    return { repo: res.repo ?? '', ref: res.ref ?? '', subpath: res.subpath ?? '', skills: res.skills ?? [], plugin_kinds: res.plugin_kinds ?? [] };
  }

  /** `paths`: repository folders of the skills to add (empty = all); `replace`: also replace different skills of the same name. */
  async install(agent: AgentKind, source: string, paths: string[], replace: boolean): Promise<{ installed: string[]; replaced: string[] }> {
    const res = await this.post<{ installed?: string[]; replaced?: string[] }>('/install', { agent: AGENT_IDS[agent], source, paths, replace });
    if (!res.success) throw new Error(res.error || 'Could not add the skills');
    return { installed: res.installed ?? [], replaced: res.replaced ?? [] };
  }

  async update(agent: AgentKind, id: string): Promise<void> {
    const res = await this.post('/update', { agent: AGENT_IDS[agent], id });
    if (!res.success) throw new Error(res.error || `Could not update ${id}`);
  }

  async remove(agent: AgentKind, id: string): Promise<void> {
    const res = await this.post('/remove', { agent: AGENT_IDS[agent], id }, false);
    if (!res.success) throw new Error(res.error || `Could not remove ${id}`);
  }

  /** Downloads the repository and runs `agy plugin install <folder>`; returns agy's output. */
  async installAgyPlugin(source: string): Promise<string> {
    const res = await this.post<{ output?: string }>('/agy-plugin', { source });
    if (!res.success) {
      const out = (res.output ?? '').trim();
      throw new Error([res.error, out && !(res.error ?? '').includes(out) ? out : null].filter(Boolean).join('\n') || 'agy could not install it');
    }
    return res.output ?? '';
  }
}
