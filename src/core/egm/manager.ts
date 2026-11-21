// Settings → Agents → EGM (port of data/egm/EgmManager.kt): Google's Elephant-Goldfish Model
// (github.com/google/elephant-goldfish-model, Apache-2.0). The agent (the Elephant) plans a design with the user and
// writes it down; fresh reviewers (Goldfish) that know nothing of the conversation try to break it; code is written only
// after the user approves the design.
//
// Nothing of EGM ships with the extension: Install downloads EGM's own release ZIP, unchanged (or, if the user picks it,
// the main branch at one commit, cut down to what a release holds), into ~/.antigem/egm, where every agent on this PC
// can read it. Three slash commands (/egm, /egm-lite, /egm-review) become instructions when a message is sent
// (HostSettings.expand):
// - In a normal chat the agent is the Elephant and runs the Goldfish with its own subagent tool.
// - In a Jarvis chat Jarvis manages the run and starts every Goldfish as a separate task chat. The Elephant is a planner
//   task chat (or Jarvis itself). The planner writes each reviewer's prompt to a file and asks Jarvis for the
//   reviewers; Jarvis starts them with a fixed goal and adds nothing of its own, so they stay fresh.
// The rules for the planner and the reviewers are files written into ~/.antigem/egm-antigem from the settings here, so
// Jarvis passes only short goals that point at them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommandView } from '../../../shared/protocol';
import type { KeyValueStore, Logger } from '../types';
import { downloadFile, extractZip, httpGet, sha256File } from '../archive';
import { compareVersions } from '../plugins/types';

export const REPO = 'google/elephant-goldfish-model';
export const HOMEPAGE = `https://github.com/${REPO}`;
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const MAIN_COMMIT_URL = `https://api.github.com/repos/${REPO}/commits/main`;
/** EGM's runtime ZIP (skills, personas, standards, docs) without a host's plugin folder that AntiGem does not use. */
const ASSET_PREFIX = 'egm-openai-';
/**
 * What a download must hold to be EGM (the skills read the personas and standards while they run). Not egm-lite:
 * releases up to 0.1.1 have none (hasLite turns /egm-lite on when the installed copy has it).
 */
const REQUIRED = ['skills/egm-brainstorm/SKILL.md', 'skills/egm-draft/SKILL.md', 'skills/egm-review/SKILL.md', 'agents/comprehension.md', 'resources/document_standards'];
const LITE_SKILL = 'skills/egm-lite/SKILL.md';
/** What EGM's release ZIPs hold; a main-branch download (the whole repository) is cut down to these. */
const RUNTIME = new Set(['skills', 'agents', 'resources', 'docs', 'assets', 'plugin.json', 'LICENSE', 'README.md']);

export type PersonaId = 'ZOOM_OUT' | 'INVENTIVE' | 'COMPREHENSION' | 'DESIGN' | 'STRUCTURAL' | 'STYLE' | 'READINESS' | 'CODEBASE';

/** EGM's eight Goldfish reviewer personas (agents/<file>); the synthesizer and the bootstrap orchestrator are left out. */
export const PERSONAS: { id: PersonaId; file: string; label: string; description: string }[] = [
  { id: 'ZOOM_OUT', file: 'zoom_out.md', label: 'Zoom out', description: 'Skeptical architect: a simpler design, no extras, reuse of existing code' },
  { id: 'INVENTIVE', file: 'inventive_catalyst.md', label: 'Inventive catalyst', description: 'Looks for a different approach that removes the core trade-off' },
  { id: 'COMPREHENSION', file: 'comprehension.md', label: 'Comprehension', description: 'Naive reader: explains the design back, flags undefined terms and gaps' },
  { id: 'DESIGN', file: 'design_critic.md', label: 'Design critic', description: 'Hostile critic: architecture, failure cases, scaling and cost' },
  { id: 'STRUCTURAL', file: 'structural.md', label: 'Structure', description: "The document's layout: sections, headings, missing parts" },
  { id: 'STYLE', file: 'style.md', label: 'Style', description: 'Copy editor: clear, precise, no filler' },
  { id: 'READINESS', file: 'implementation_readiness.md', label: 'Implementation readiness', description: 'Tech lead: can the plan be built step by step without guessing' },
  { id: 'CODEBASE', file: 'codebase_details.md', label: 'Codebase details', description: 'Checks the plan against the real code: files, APIs, names' },
];

/** The persona's name in EGM's skills (egm-design, egm-zoom-out, …). */
const egmName = (p: (typeof PERSONAS)[number]) => 'egm-' + (p.id === 'DESIGN' ? 'design' : p.file.replace(/\.md$/, '').replace(/_/g, '-'));

export const PRESETS: { id: string; label: string; reviewers: PersonaId[] }[] = [
  { id: 'QUICK', label: 'Quick · 2', reviewers: ['COMPREHENSION', 'DESIGN'] },
  { id: 'STANDARD', label: 'Standard · 3', reviewers: ['COMPREHENSION', 'DESIGN', 'READINESS'] },
  { id: 'FULL', label: 'Full · 8', reviewers: PERSONAS.map((p) => p.id) },
];

/** Who is the Elephant when /egm runs in a Jarvis chat. */
export type Elephant = 'PLANNER_CHAT' | 'JARVIS';
export const ELEPHANTS: Record<Elephant, { label: string; description: string }> = {
  PLANNER_CHAT: {
    label: 'A separate planner chat',
    description: "Jarvis starts a planner chat that brainstorms, writes and fixes the design; Jarvis relays and runs the reviewers. Keeps Jarvis' own chat light.",
  },
  JARVIS: { label: 'Jarvis itself', description: "Jarvis brainstorms and writes the design in its own chat and runs the reviewers. One chat less, but Jarvis' context fills up." },
};

/** Where Install gets EGM from. */
export type Source = 'RELEASE' | 'MAIN';
export const SOURCES: Record<Source, { label: string; description: string }> = {
  RELEASE: { label: 'Newest release', description: "EGM's published release, checked against its checksum. The stable choice." },
  MAIN: {
    label: 'Development version (main)',
    description: "EGM's main branch as it is now, with skills not released yet (egm-lite, as of release 0.1.1). It changes almost daily and has no checksum to check it against.",
  },
};

export type CommandId = 'FULL' | 'LITE' | 'REVIEW';
export const COMMANDS: { id: CommandId; token: string; description: string; argumentHint: string }[] = [
  { id: 'FULL', token: 'egm', description: 'EGM: brainstorm → design doc → Goldfish review → your approval → code', argumentHint: 'task' },
  { id: 'LITE', token: 'egm-lite', description: 'EGM lite: checklist → one Goldfish review → code → diff review', argumentHint: 'task' },
  { id: 'REVIEW', token: 'egm-review', description: 'EGM: Goldfish review of an existing design document', argumentHint: 'design doc path' },
];

export const DEFAULT_ARTIFACT_DIR = '.egm';
export const MAX_ROUNDS = 3;
export const MAX_PARALLEL = 4;

export const DEFAULT_CHAT_TEMPLATE = `How to run EGM in this chat:
- You are the Elephant: you keep the project context, work with the user and write the documents.
- Goldfish reviewers run in your own fresh-context subagent tool (Claude Code: Agent; Codex: spawn_agent; Antigravity: invoke_subagent; OpenCode: task). For each reviewer spawn a general-purpose subagent and pass the prompt the skill gives, starting with "Read <EGM root>/agents/<persona file> first and follow it.", with absolute paths. Never pass a summary of this conversation, your opinions or hints about what you think is wrong.
- Tell every reviewer it is read-only (no file changes, no builds or commands that change anything) and must put its whole report in its reply. You write the report files.
- If you have no fresh-context subagent tool, stop before any Goldfish step and tell the user: a review in this same chat is not a Goldfish review. They can type the same command in a Jarvis chat, where Jarvis starts every reviewer as a separate chat.
- Ask the user one question at a time (your question tool if you have one, else plain chat), as EGM says.`;

export const DEFAULT_JARVIS_TEMPLATE = `How to manage this EGM run:
1. Mission: start with jarvis_mission_set (goal = the user's task, done_when = what ends this command, steps = the phases above, one per line). Then save what you will need later with jarvis_mission_update(notes = …): the planner task id, the EGM artifact folder, the review round, and the two goal texts. The mission is repeated to you with every message, so these survive a long run. Mark each step doing / done as the phases change: that is what the user sees in the Jarvis tab.
2. Elephant: when it is a planner chat, start it with the planner goal, verbatim. Relay its questions to the user and the user's answers back word for word (jarvis_task_reply, or jarvis_task_answer for its question cards); never add your own ideas about the design. Its replies start with PHASE: …; update the mission from them.
3. GOLDFISH REQUEST (a list of prompt files from the planner): start one task per file with the Goldfish goal, at most the number of reviewers at once given above; start the next as one finishes. Add nothing to the goal: anything more from you spoils the fresh review. Do not wait or poll: the app tells you when a task ends. Then read its whole reply with jarvis_read_chat(id, role = "assistant", limit = 1, max_chars = 30000), save it unchanged next to the prompt file (the same name ending in .report.md instead of .prompt.md) and close the task with jarvis_task_close. When all are saved, send the planner GOLDFISH REPORTS and the report paths with jarvis_task_reply. If you cannot write files, send the reports' full text instead. If a reviewer failed, changed files or asked something, tell the user.
4. Approval: when the planner says Waiting for approval, give the user the design document's path, what changed in review and what is still open, and ask: approve, change something, or one more review round (in a typed chat ask in your reply; by voice with jarvis_ask). Pass the answer on: APPROVED, or the user's changes word for word. Never let implementation start without the user's explicit approval.
5. End: when the planner reports Done, mark the mission done and tell the user where the design, the reports and the changes are.`;

const GOLDFISH_RULES = `# EGM Goldfish reviewer (AntiGem)

You are a Goldfish: a fresh reviewer in the Elephant-Goldfish Model (EGM). You know nothing about the conversation that produced the document, and that is the point.

- Your whole task is in the prompt file named in your message. Read it, then the persona file it names (if any), and follow them exactly. Read the files they name, and any project files you need to check facts.
- Read-only: do not create, edit, move or delete files, and run no builds, installs, git commands or anything else that changes the project or the system.
- Put your complete report in your reply; it is saved to a file for you. If a required file cannot be read, say the review is incomplete instead of giving a verdict.
- Do not ask questions (nobody will answer them): state your assumptions in the report.
- No small talk: findings only, in the format the persona or the prompt asks for.
`;

export interface EgmSettings {
  /** The slash commands work (EGM stays installed when off). */
  enabled: boolean;
  reviewers: PersonaId[];
  /** egm-review stops after each stage for the user (else it runs all stages, then reports once). */
  checkpoints: boolean;
  /** How often a review stage may run again after the document was fixed. */
  rounds: number;
  /** Goldfish reviewers running at the same time. */
  parallel: number;
  /** Where design documents and reports go, relative to the project (one folder per topic inside). */
  artifactDir: string;
  elephant: Elephant;
  /** What Install and Update download. */
  source: Source;
  chatTemplate: string;
  jarvisTemplate: string;
}

const DEFAULTS: EgmSettings = {
  enabled: true,
  reviewers: PRESETS[1].reviewers,
  checkpoints: false,
  rounds: 1,
  parallel: 2,
  artifactDir: DEFAULT_ARTIFACT_DIR,
  elephant: 'PLANNER_CHAT',
  source: 'RELEASE',
  chatTemplate: DEFAULT_CHAT_TEMPLATE,
  jarvisTemplate: DEFAULT_JARVIS_TEMPLATE,
};

export interface EgmState {
  /** The installed EGM version (its plugin.json), null when not installed. */
  version: string | null;
  /** Where the installed copy came from. */
  installedSource: Source | null;
  /** The main-branch commit installed (7 characters), for MAIN. */
  installedCommit: string | null;
  /** The newest release seen by the last check. */
  latest: string | null;
  /** The main branch's newest commit seen by the last check (7 characters). */
  latestCommit: string | null;
  /** The installed copy has egm-lite (EGM added it after release 0.1.1). */
  hasLite: boolean;
  task: string | null;
  progress: string | null;
  message: string | null;
  isError: boolean;
  log: string[];
}

interface Installed {
  version: string;
  source: Source;
  commit?: string | null;
}

export class EgmManager {
  /** EGM's own files, exactly as released. */
  readonly rootDir: string;
  /** AntiGem's rules for the planner and the reviewers of a Jarvis run (rewritten from the settings). */
  readonly adapterDir: string;
  private readonly workDir: string;
  state: EgmState = {
    version: null,
    installedSource: null,
    installedCommit: null,
    latest: null,
    latestCommit: null,
    hasLite: false,
    task: null,
    progress: null,
    message: null,
    isError: false,
    log: [],
  };
  private listeners = new Set<() => void>();
  private checkedAt = 0;

  /** [home]: where .antigem is (tests use a temporary folder). */
  constructor(
    private store: KeyValueStore,
    private logger: Logger,
    home = os.homedir(),
  ) {
    this.rootDir = path.join(home, '.antigem', 'egm');
    this.adapterDir = path.join(home, '.antigem', 'egm-antigem');
    this.workDir = path.join(home, '.antigem', 'egm-download');
    this.refresh();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<EgmState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private report(message: string, isError = false) {
    this.update({ message, isError });
  }

  private progress(text: string) {
    this.update({ progress: text });
  }

  private appendLog(line: string) {
    this.update({ log: [...this.state.log, line].slice(-200) });
  }

  private plannerFile() {
    return path.join(this.adapterDir, 'planner.md');
  }

  private goldfishFile() {
    return path.join(this.adapterDir, 'goldfish.md');
  }

  get busy(): boolean {
    return this.state.task != null;
  }

  get hasUpdate(): boolean {
    const s = this.state;
    if (s.installedSource === 'MAIN') return s.installedCommit != null && s.latestCommit != null && s.latestCommit !== s.installedCommit;
    return s.version != null && s.latest != null && (compareVersions(s.latest, s.version) ?? 0) > 0;
  }

  /** What is installed, for the page: "v0.1.1", or "main 70406c4" for the development version. */
  get label(): string | null {
    const s = this.state;
    if (!s.version) return null;
    return s.installedSource === 'MAIN' ? `main ${s.installedCommit ?? s.version}` : `v${s.version}`;
  }

  // ---------------- install, update, remove

  private installedPref(): Installed | null {
    return this.store.get<Installed>('egm.installed') ?? null;
  }

  /** Re-reads what is installed (the folder may have been removed in a terminal) and rewrites the rule files. */
  refresh() {
    if (this.busy) return;
    const pref = this.installedPref();
    const version = fs.existsSync(path.join(this.rootDir, 'skills')) ? (this.readVersion() ?? pref?.version ?? '?') : null;
    if (version == null) {
      if (pref) this.store.set('egm.installed', undefined);
    } else if (pref?.version !== version) this.store.set('egm.installed', { source: 'RELEASE', ...pref, version });
    const now = this.installedPref();
    const next = {
      version,
      installedSource: version == null ? null : (now?.source ?? 'RELEASE'),
      installedCommit: version == null ? null : (now?.commit ?? null),
      hasLite: version != null && this.hasLiteSkill(),
    };
    const s = this.state;
    if (s.version !== next.version || s.installedSource !== next.installedSource || s.installedCommit !== next.installedCommit || s.hasLite !== next.hasLite) this.update(next);
    if (version != null) {
      try {
        this.writeAdapterFiles();
      } catch (e) {
        this.logger(`[egm] rule files: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The settings page opened: what is installed, and (at most every few minutes) the newest version. */
  pageOpened() {
    this.refresh();
    if (Date.now() - this.checkedAt > 5 * 60_000) void this.checkForUpdate();
  }

  /** Looks up the newest version of the chosen source (shown as an update on the page). */
  async checkForUpdate() {
    this.checkedAt = Date.now();
    try {
      if (this.settings().source === 'RELEASE') this.update({ latest: (await this.latestRelease()).version });
      else this.update({ latestCommit: (await this.latestMainCommit()).slice(0, 7) });
    } catch (e) {
      this.logger(`[egm] update check: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Installs EGM from the chosen source, or replaces the installed copy with the newest one of that source (Update, or
   * a switch between release and main).
   */
  install(): Promise<void> {
    return this.runTask('install', async () => {
      const source = this.settings().source;
      const work = this.workDir;
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      try {
        const zip = path.join(work, 'egm.zip');
        let released: string | null = null;
        let commit: string | null = null;
        if (source === 'RELEASE') {
          this.progress('Looking up the newest EGM release…');
          const release = await this.latestRelease();
          this.appendLog(`Release ${release.tag}: ${release.zipName || 'source archive'}`);
          this.progress(`Downloading EGM ${release.version}…`);
          await this.download(release.zipUrl, zip);
          this.appendLog(`✓ Downloaded ${Math.floor(fs.statSync(zip).size / 1024)} KB`);
          if (release.sumsUrl) {
            const expected = (await httpGet(release.sumsUrl))
              .split('\n')
              .map((l) => l.trim().split(/\s+/))
              .find((p) => p.length >= 2 && p[p.length - 1].replace(/^\*/, '') === release.zipName)?.[0];
            if (!expected) {
              this.appendLog(`! The release lists no checksum for ${release.zipName}; not checked`);
            } else {
              if (sha256File(zip).toLowerCase() !== expected.toLowerCase()) throw new Error('The download does not match the release checksum. Try again.');
              this.appendLog('✓ Checksum matches');
            }
          }
          released = release.version;
        } else {
          this.progress("Looking up EGM's main branch…");
          const sha = await this.latestMainCommit();
          this.appendLog(`Main branch at ${sha.slice(0, 7)} (development version: unreleased, no checksum)`);
          this.progress(`Downloading EGM main ${sha.slice(0, 7)}…`);
          // that exact commit, so what is installed is what was looked up
          await this.download(`https://codeload.github.com/${REPO}/zip/${sha}`, zip);
          this.appendLog(`✓ Downloaded ${Math.floor(fs.statSync(zip).size / 1024)} KB`);
          commit = sha.slice(0, 7);
        }
        this.progress('Unpacking…');
        const staging = path.join(work, 'unpacked');
        extractZip(zip, staging);
        const bundle = bundleRoot(staging);
        if (!bundle) throw new Error('The download has no EGM skills folder.');
        const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(bundle, f)));
        if (missing.length) throw new Error(`The download is missing ${missing.join(', ')}.`);
        // the main branch comes as the whole repository (tests, site, CI…): keep what a release ZIP holds
        if (source === 'MAIN') for (const name of fs.readdirSync(bundle)) if (!RUNTIME.has(name)) fs.rmSync(path.join(bundle, name), { recursive: true, force: true });
        // the old copy goes as a whole: files a release dropped must not stay behind (EGM's own advice)
        fs.rmSync(this.rootDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(this.rootDir), { recursive: true });
        try {
          fs.renameSync(bundle, this.rootDir);
        } catch {
          fs.cpSync(bundle, this.rootDir, { recursive: true });
        }
        const version = this.readVersion() ?? released ?? '?';
        this.store.set('egm.installed', { version, source, commit } satisfies Installed);
        this.update({
          version,
          installedSource: source,
          installedCommit: commit,
          latest: released ?? this.state.latest,
          latestCommit: commit ?? this.state.latestCommit,
          hasLite: this.hasLiteSkill(),
        });
        this.writeAdapterFiles();
        const label = this.label ?? version;
        this.appendLog(`✓ EGM ${label} in ${this.rootDir}`);
        if (!this.state.hasLite) this.appendLog(`! EGM ${label} has no egm-lite: /egm-lite stays off (the development version has it)`);
        const commands = COMMANDS.filter((c) => this.available(c.id)).map((c) => `/${c.token}`).join(', ');
        this.report(`EGM ${label} installed. Type ${commands} in any chat.`);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  }

  /** Removes EGM and the rule files; design documents in projects stay. */
  uninstall(): Promise<void> {
    return this.runTask('remove', async () => {
      this.progress('Removing EGM…');
      fs.rmSync(this.rootDir, { recursive: true, force: true });
      fs.rmSync(this.adapterDir, { recursive: true, force: true });
      this.store.set('egm.installed', undefined);
      this.update({ version: null, installedSource: null, installedCommit: null, hasLite: false });
      this.appendLog(`✓ Removed ${this.rootDir}`);
      this.report('EGM removed. Its slash commands are gone; design documents in your projects stay.');
    });
  }

  private async runTask(task: string, block: () => Promise<void>) {
    if (this.busy) {
      this.report('Something is already running. Wait for it to finish.', true);
      return;
    }
    this.update({ task, log: [], progress: null, message: null, isError: false });
    try {
      await block();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.logger(`[egm] ${task} failed: ${m}`);
      this.appendLog(`✗ ${m}`);
      this.report(m || 'Failed', true);
    } finally {
      this.update({ task: null, progress: null });
    }
  }

  private async download(url: string, file: string) {
    let shown = -1;
    await downloadFile(url, file, {
      onProgress: (done, total) => {
        if (total <= 0) return;
        const pct = Math.floor((done * 100) / total);
        if (pct !== shown) {
          shown = pct;
          this.progress(`Downloading… ${pct}%`);
        }
      },
    });
  }

  private async latestRelease(): Promise<{ tag: string; version: string; zipUrl: string; zipName: string; sumsUrl: string | null }> {
    const json = JSON.parse(await httpGet(LATEST_URL)) as {
      tag_name?: string;
      zipball_url?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const tag = json.tag_name?.trim();
    if (!tag) throw new Error('The newest EGM release has no version tag.');
    let zipUrl: string | null = null;
    let zipName = '';
    let sumsUrl: string | null = null;
    for (const a of json.assets ?? []) {
      const name = a.name ?? '';
      const url = a.browser_download_url ?? '';
      if (!url) continue;
      if (name.startsWith(ASSET_PREFIX) && name.endsWith('.zip')) {
        zipUrl = url;
        zipName = name;
      }
      if (name === 'SHA256SUMS') sumsUrl = url;
    }
    // a release without the runtime ZIP: the tag's source archive (one top folder, plus files EGM does not need)
    const url = zipUrl ?? json.zipball_url?.trim();
    if (!url) throw new Error(`The release ${tag} has nothing to download.`);
    return { tag, version: tag.replace(/^v/, ''), zipUrl: url, zipName, sumsUrl: zipUrl ? sumsUrl : null };
  }

  /** The main branch's newest commit (the full SHA). */
  private async latestMainCommit(): Promise<string> {
    const sha = (await httpGet(MAIN_COMMIT_URL, 'application/vnd.github.sha')).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Could not read EGM's main branch from GitHub.");
    return sha;
  }

  private hasLiteSkill(): boolean {
    return fs.existsSync(path.join(this.rootDir, LITE_SKILL));
  }

  private readVersion(): string | null {
    try {
      const v = (JSON.parse(fs.readFileSync(path.join(this.rootDir, 'plugin.json'), 'utf8')) as { version?: unknown }).version;
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  }

  // ---------------- settings

  settings(): EgmSettings {
    return normalized({ ...DEFAULTS, ...(this.store.get<Partial<EgmSettings>>('egm.settings') ?? {}) });
  }

  updateSettings(transform: (s: EgmSettings) => EgmSettings) {
    const next = normalized(transform(this.settings()));
    // a template the user never changed is not stored, so a newer default reaches them
    const saved: Partial<EgmSettings> = { ...next };
    if (next.chatTemplate === DEFAULT_CHAT_TEMPLATE) delete saved.chatTemplate;
    if (next.jarvisTemplate === DEFAULT_JARVIS_TEMPLATE) delete saved.jarvisTemplate;
    this.store.set('egm.settings', saved);
    if (this.state.version != null) {
      try {
        this.writeAdapterFiles();
      } catch (e) {
        this.logger(`[egm] rule files: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const l of this.listeners) l();
  }

  clearMessage() {
    this.update({ message: null, isError: false });
  }

  // ---------------- slash commands

  /** EGM is installed and its commands are on. */
  get isActive(): boolean {
    return this.settings().enabled && this.state.version != null;
  }

  /** Whether the installed EGM has what [command] runs (egm-lite is missing from releases up to 0.1.1). */
  available(command: CommandId): boolean {
    return command !== 'LITE' || this.state.hasLite;
  }

  /** The EGM command [token] (without the slash) names, when EGM is active and has it. */
  command(token: string): CommandId | null {
    if (!this.isActive) return null;
    return COMMANDS.find((c) => c.token.toLowerCase() === token.toLowerCase() && this.available(c.id))?.id ?? null;
  }

  /** The commands in the chat's `/` list. */
  slashItems(): SlashCommandView[] {
    if (!this.isActive) return [];
    return COMMANDS.filter((c) => this.available(c.id)).map((c) => ({ command: `/${c.token}`, description: c.description, argumentHint: c.argumentHint, kind: 'custom' as const }));
  }

  /**
   * What `/egm…` [token] sends with [args] (the rest of the message: the task, or the document for a review), or null
   * when it is not an active EGM command. [jarvis]: the message goes to a Jarvis chat, which manages the run with task
   * chats instead of subagents.
   */
  expansion(token: string, args: string, jarvis: boolean): string | null {
    const command = this.command(token);
    if (!command) return null;
    const s = this.settings();
    return jarvis
      ? [this.setupBlock(s), this.jarvisRunBlock(command, args, s), s.jarvisTemplate.trim()].join('\n\n')
      : [this.setupBlock(s), chatTaskBlock(command, args, (n) => this.skill(n)), s.chatTemplate.trim()].join('\n\n');
  }

  private skill(name: string) {
    return path.join(this.rootDir, 'skills', name, 'SKILL.md');
  }

  /** The facts every EGM run needs, from the settings: where EGM is, which reviewers, the limits. */
  private setupBlock(s: EgmSettings): string {
    const root = this.rootDir;
    const version = this.label ? ` ${this.label}` : '';
    const lines = [
      `EGM (Elephant-Goldfish Model${version}, ${HOMEPAGE}) is installed by AntiGem. It makes you plan and defend a design before any code: the Elephant (the main agent, with the whole context) writes a design document, and fresh Goldfish reviewers that know nothing of the conversation try to break it.`,
      `- EGM root: ${root} (skills/<name>/SKILL.md = the workflows, agents/<file>.md = the Goldfish reviewer personas, resources/document_standards/ = the review standards, docs/ = notes per agent).`,
      '- EGM is not installed as a plugin of your agent here: its skills are not in your skill list and its personas are not registered subagent types. Read the files and follow them; never call a Skill tool for them. Where an EGM file says ${CLAUDE_PLUGIN_ROOT}, "the plugin root" or a path like agents/…, resources/… or docs/…, use the EGM root. A skill\'s references/ folder is next to its SKILL.md.',
      '- If the EGM root does not exist where you run (an agent on another computer or a server), stop and tell the user that EGM is installed only on the PC that runs AntiGem.',
      `- EGM artifact directory: ${s.artifactDir}/<short-topic-name>/ in the project folder (one folder per topic; create it). Drafts, checklists and every review report are files there, not long text in the chat.`,
    ];
    const chosen = PERSONAS.filter((p) => s.reviewers.includes(p.id));
    if (chosen.length === PERSONAS.length) lines.push('- Goldfish reviewers: all eight personas, as EGM\'s skills list them.');
    else
      lines.push(
        `- Goldfish reviewers: only ${chosen.map((p) => `${egmName(p)} (agents/${p.file})`).join(', ')}. Wherever an EGM skill lists reviewers (the brainstorm lenses, the review stages, egm-review-loop), keep only these and skip the others; skip a review stage that has none of them and keep the order of the rest. The user chose this in Settings → Agents → EGM. egm-lite has its own single reviewer and is not affected.`,
      );
    lines.push("- Do not use the egm-synthesizer persona: dispatch the reviewers of a stage directly and merge their findings yourself (EGM's direct-dispatch fallback).");
    lines.push(
      s.checkpoints
        ? '- Review mode: for egm-review use Step = interactive (check in with the user after each stage); do not ask the preset question.'
        : '- Review mode: for egm-review use Step = uninterrupted (run the stages without stopping, then write consolidated_review_report.md); do not ask the preset question.',
    );
    lines.push(`- Re-reviews: after the document is fixed, run a review stage again at most ${s.rounds} time(s); then record what is left as accepted trade-offs.`);
    lines.push(`- At most ${s.parallel} Goldfish reviewer(s) at the same time.`);
    lines.push('- No project code is written or changed before the user explicitly approves the design (in egm-lite: before the user says exec or Proceed).');
    return lines.join('\n');
  }

  /** What the planner does, for its goal. */
  private plannerFlow(command: CommandId, args: string): string {
    const skill = (n: string) => this.skill(n);
    switch (command) {
      case 'FULL':
        return (
          `Run the full EGM flow: ${skill('egm-brainstorm')}, then ${skill('egm-draft')}, then ${skill('egm-review')} (fix or contest findings with ${skill('egm-resolve')}). Then wait for the user's approval; implement only after APPROVED. ` +
          (args ? `The user's task: ${args}` : 'The user gave no task yet: ask for it first.')
        );
      case 'LITE':
        return `Follow ${skill('egm-lite')}. ` + (args ? `The user's task: ${args}` : 'The user gave no task yet: ask for it first.');
      case 'REVIEW':
        return `Run ${skill('egm-review')}. ` + (args ? `TargetFile: ${args}` : 'The user gave no document yet: ask for its path first.');
    }
  }

  /** The run's facts for Jarvis: the command, the Elephant, and the exact goals to start the planner and reviewers with. */
  private jarvisRunBlock(command: CommandId, args: string, s: EgmSettings): string {
    const what = { FULL: 'the full EGM flow', LITE: 'EGM lite', REVIEW: 'an EGM review of a design document' }[command];
    const phases = { FULL: 'Brainstorm, Draft, Review, Approval, Implement', LITE: 'Checklist, Spec review, Approval (exec), Implement, Diff review', REVIEW: 'Review, Fixes, Approval' }[command];
    const planner = this.plannerFile();
    const goldfish = this.goldfishFile();
    const lines = [
      'This is a Jarvis chat: you (Jarvis) manage this EGM run, and every Goldfish reviewer is a separate task chat that you start (not a subagent).',
      `- Command: ${what}. ` + (args ? `User's input: ${args}` : 'The user gave no task or document yet: ask for it first.'),
      `- Phases (the mission steps): ${phases}.`,
      `- Rules files the app wrote for this run: ${planner} (the Elephant's rules) and ${goldfish} (the reviewers' rules).`,
    ];
    if (s.elephant === 'PLANNER_CHAT') {
      lines.push(
        '- Elephant: a separate planner task chat. Start it with jarvis_task_start(title = "EGM planner", project = the user\'s project, goal = the text in <planner_goal>, verbatim).',
        '<planner_goal>',
        `You are the EGM Elephant (planner) of a run that Jarvis manages. First read ${planner} and follow it. ${this.plannerFlow(command, args)}`,
        '</planner_goal>',
      );
    } else {
      lines.push(
        `- Elephant: you, in this chat. Read ${planner} and follow it yourself, with this flow: ${this.plannerFlow(command, args)}`,
        '  Where it says to reply GOLDFISH REQUEST, start those reviewers yourself (as below), save their reports, then go on. Talk to the user directly instead of through PHASE lines.',
      );
    }
    lines.push(
      '- Goldfish goal: one reviewer task per prompt file, with jarvis_task_start(title = "Goldfish <reviewer>", project = the same project, goal = the text in <goldfish_goal> with PROMPT_FILE replaced by that file\'s absolute path). Nothing else goes into the goal.',
      '<goldfish_goal>',
      `Read ${goldfish} first, then do the review described in PROMPT_FILE.`,
      '</goldfish_goal>',
      `- At most ${s.parallel} reviewer task(s) running at the same time.`,
    );
    return lines.join('\n');
  }

  /** Writes the planner's and the reviewers' rules for Jarvis runs (they follow the settings). */
  private writeAdapterFiles() {
    fs.mkdirSync(this.adapterDir, { recursive: true });
    const write = (file: string, text: string) => {
      let old: string | null = null;
      try {
        old = fs.readFileSync(file, 'utf8');
      } catch {
        old = null;
      }
      if (old !== text) fs.writeFileSync(file, text);
    };
    write(this.plannerFile(), this.plannerRules(this.settings()));
    write(this.goldfishFile(), GOLDFISH_RULES);
  }

  private plannerRules(s: EgmSettings): string {
    const root = this.rootDir;
    return `# EGM in AntiGem: the Elephant (planner) of a run that Jarvis manages

Written by AntiGem from Settings → Agents → EGM and rewritten when those settings change.

${this.setupBlock(s)}

## You are the Elephant

You keep the project context, work with the user (through Jarvis) and write the documents. Jarvis manages the run and starts every Goldfish reviewer as a separate, fresh chat.

## Goldfish reviewers

- Do not spawn subagents yourself (no Agent, Task, spawn_agent, invoke_subagent or task tool), and never review your own document in place of a Goldfish.
- Whenever an EGM skill says to spawn a Goldfish or a subagent, write, for each reviewer, the exact prompt the skill says to pass into its own file: <EGM artifact directory>/goldfish/r<round>-<reviewer>.prompt.md, with absolute paths inside. Its first line: "Read ${root}${path.sep}agents${path.sep}<persona file> first and follow it." Then the prompt from the skill: the mode, the target document's absolute path and line range, the standard file, the context files. Nothing from your conversation: no summary, no opinions, no hints about what you think is wrong.
- egm-lite's Goldfish (the spec review, the diff review) works the same way: the prompt file holds the whole reviewer prompt the skill describes (the checklist, the change list, the rubric), without a persona line.
- Then end your turn with a reply whose first line is GOLDFISH REQUEST, followed by the prompt files, one absolute path per line, and stop. Jarvis answers GOLDFISH REPORTS with one report per prompt file (the same name ending in .report.md instead of .prompt.md). Read them all and continue the skill where you stopped: merge, deduplicate, write the stage report, resolve.

## Talking to the user

- The user does not watch this chat: Jarvis relays both ways. Ask one question at a time (with your question tool, or as plain text in your reply) and stop; the answer comes back word for word.
- Start every reply with a line PHASE: <phase> (Brainstorm, Draft, Review, Fixes, Waiting for approval, Implement, Diff review or Done) so Jarvis can show it.
- When the design is final, reply PHASE: Waiting for approval with the design document's path and what is still open, and stop. Change no project code until Jarvis sends APPROVED.
`;
  }
}

/** What the user asked for, in a normal chat. */
function chatTaskBlock(command: CommandId, args: string, skill: (name: string) => string): string {
  switch (command) {
    case 'FULL':
      return [
        'The user started the full EGM flow.',
        args ? `Task: ${args}` : 'Task: none given yet. Ask what they want to build, then start.',
        'Phases, in order:',
        `1. Brainstorm: follow ${skill('egm-brainstorm')} with the user.`,
        `2. Draft: follow ${skill('egm-draft')} to write the design document.`,
        `3. Review: follow ${skill('egm-review')} on that document; fix or contest findings with ${skill('egm-resolve')}.`,
        "4. Approval: give the user the final document's path and what is still open, and ask them to approve it.",
        '5. Only after the approval: implement exactly the approved design, then tell the user what changed.',
      ].join('\n');
    case 'LITE':
      return [
        `The user started EGM lite. Follow ${skill('egm-lite')} (its phase commands: checklist, goldfish / review, exec).`,
        args ? `Task: ${args}` : 'Task: none given yet. Ask what they want to do.',
      ].join('\n');
    case 'REVIEW':
      return [
        `The user started an EGM review of a design document. Follow ${skill('egm-review')}.`,
        args ? `TargetFile: ${args} (relative to the project folder unless absolute)` : "TargetFile: none given. Ask the user for the document's path.",
        `When the review is done, ask the user whether to fix the findings (${skill('egm-resolve')}) before anything else.`,
      ].join('\n');
  }
}

function normalized(s: EgmSettings): EgmSettings {
  const reviewers = PERSONAS.map((p) => p.id).filter((id) => s.reviewers?.includes(id));
  const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);
  return {
    ...s,
    enabled: s.enabled !== false,
    checkpoints: s.checkpoints === true,
    reviewers: reviewers.length ? reviewers : PRESETS[1].reviewers,
    rounds: Math.min(MAX_ROUNDS, Math.max(0, int(s.rounds, DEFAULTS.rounds))),
    parallel: Math.min(MAX_PARALLEL, Math.max(1, int(s.parallel, DEFAULTS.parallel))),
    artifactDir: String(s.artifactDir ?? '').trim().replace(/\/+$/, '') || DEFAULT_ARTIFACT_DIR,
    elephant: s.elephant === 'JARVIS' ? 'JARVIS' : 'PLANNER_CHAT',
    source: s.source === 'MAIN' ? 'MAIN' : 'RELEASE',
    chatTemplate: s.chatTemplate?.trim() ? s.chatTemplate : DEFAULT_CHAT_TEMPLATE,
    jarvisTemplate: s.jarvisTemplate?.trim() ? s.jarvisTemplate : DEFAULT_JARVIS_TEMPLATE,
  };
}

/** The folder of [dir] that holds EGM: [dir] itself, or its single top folder (a source archive). */
function bundleRoot(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'skills'))) return dir;
  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (dirs.length !== 1) return null;
  const only = path.join(dir, dirs[0].name);
  return fs.existsSync(path.join(only, 'skills')) ? only : null;
}
