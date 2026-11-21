// Skills (src/core/skills): "Set up with AI" opens a new chat with the setup request in the message box (the
// host's startChat), and opening the "/" menu asks the agent to read its skills again (the app's ChatScreen: at most
// every 10 s), so skills added meanwhile and the open chat's project ones show.
import type { AgentKind } from '@shared/model';
import { host } from '../host';
import { closeSettings } from './settings';
import { newChat, send, setComposerInsert } from './store';

host.onMessage((m) => {
  if (m.type !== 'startChat') return;
  closeSettings();
  newChat(m.agent);
  // after the new chat's (empty) draft is loaded into the box
  setTimeout(() => setComposerInsert({ text: m.text, replace: true, n: Date.now() }), 60);
});

const lastAsked = new Map<AgentKind, number>();

/** The "/" menu opened for `agent`'s chat. */
export function slashMenuOpened(agent: AgentKind) {
  const now = Date.now();
  if (now - (lastAsked.get(agent) ?? 0) < 10_000) return;
  lastAsked.set(agent, now);
  send({ type: 'slashMenuOpened', agent });
}
