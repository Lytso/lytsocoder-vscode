// What an agent needs before it can chat (install, sign in) and the buttons that do it, the same everywhere: the
// chat's not-ready card and banner, the composer, the Accounts dialog. As the app: Install starts the install at once
// and opens the agent's Account & CLI page, where its progress and log show (AgentStatusEntry actions in ChatScreen).
import type { AgentKind } from '@shared/model';
import type { AgentStatus } from '@shared/protocol';
import { agentStatus, send } from './store';
import { openAgentSettings } from './settings';

/** Settings id prefix of each agent (pages 'claude.cli', buttons 'claude.signin'…). */
const PREFIX: Record<AgentKind, string> = { AGY: 'agy', CLAUDE: 'claude', CODEX: 'codex', OPENCODE: 'opencode' };

/** The agent's Account & CLI page (install, sign-in, update). */
export function setupPageOf(agent: AgentKind): string {
  const page = agentStatus(agent)?.setupPage;
  return page && page.includes('.') ? page : `${PREFIX[agent]}.cli`;
}

/**
 * Installed but signed out (or the sign-in expired). Older hosts had no `signedOut`: there a missing sign-in was an
 * error whose detail said so.
 */
export function isSignedOut(s: AgentStatus | null | undefined): boolean {
  if (!s) return false;
  if (s.signedOut != null) return s.signedOut;
  return s.state === 'error' && /sign[ -]?in required|not signed in|signed out/i.test(s.detail ?? '');
}

/** What the agent needs before it can take a message: 'install', 'signIn', or null (ready, starting or down). */
export function agentNeed(s: AgentStatus | null | undefined): 'install' | 'signIn' | null {
  if (!s) return null;
  if (s.state === 'not_installed') return 'install';
  if (isSignedOut(s)) return 'signIn';
  return null;
}

/** Opens the agent's Account & CLI page. */
export function openSetupPage(agent: AgentKind) {
  openAgentSettings(agent, { id: setupPageOf(agent), title: agent === 'OPENCODE' ? 'OpenCode CLI' : 'Account & CLI' });
}

/** Installs the agent's CLI now; the Account & CLI page shows the progress (the agent starts when it is done). */
export function installAgent(agent: AgentKind) {
  const page = setupPageOf(agent);
  openSetupPage(agent);
  send({ type: 'settingAction', page, id: 'install' });
}

/**
 * Sign in: Antigravity and Codex start the browser sign-in at once; Claude Code first asks which account
 * (subscription or Anthropic Console) on its page. OpenCode has no sign-in of its own (each provider has a key).
 */
export function signInAgent(agent: AgentKind) {
  const page = setupPageOf(agent);
  openSetupPage(agent);
  if (agent === 'AGY' || agent === 'CODEX') send({ type: 'settingAction', page, id: `${PREFIX[agent]}.signin` });
}

/** Signs the agent out (Antigravity, Claude Code, Codex). */
export function signOutAgent(agent: AgentKind) {
  if (agent === 'OPENCODE') return;
  send({ type: 'settingAction', page: setupPageOf(agent), id: `${PREFIX[agent]}.signout` });
}

/** The chat's notice for an agent that can't take a message yet (composer toast, banner). */
export function notReadyText(agent: AgentKind, s: AgentStatus | null | undefined, label: string): string {
  const need = agentNeed(s);
  if (need === 'install') return `${label} is not installed. Press Install to set it up.`;
  if (need === 'signIn') return s?.detail && /expired/i.test(s.detail) ? s.detail : `Sign in to ${label} to send messages.`;
  if (s?.state === 'starting') return `${label} is still starting…`;
  return s?.detail ? `${label} is not running: ${s.detail}` : `${label} is not running. Press Reconnect to start it.`;
}
