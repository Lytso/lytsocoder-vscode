// Settings → Agents → EGM (port of ui/settings/EgmScreen.kt) as a host page ('egm'): install / update / remove EGM,
// its slash commands, which reviewers, the review limits, who the Elephant is in a Jarvis chat, and the instructions
// each command sends. "How to use EGM" is a page the view draws with the chat's renderer (EgmGuideCard).
import type { SettingItem, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { tildePath } from '../paths';
import {
  COMMANDS,
  DEFAULT_CHAT_TEMPLATE,
  DEFAULT_JARVIS_TEMPLATE,
  ELEPHANTS,
  HOMEPAGE,
  MAX_PARALLEL,
  MAX_ROUNDS,
  PERSONAS,
  PRESETS,
  SOURCES,
  type EgmManager,
  type Elephant,
  type PersonaId,
  type Source,
} from './manager';

/** The page the view draws itself for the guide (webview/src/components/DocPage.tsx). */
export const EGM_GUIDE_PAGE = 'local:doc:egm-guide';

/** Why /egm-lite is off: the installed EGM ([label], e.g. v0.1.1) has no egm-lite skill (releases up to 0.1.1). */
const liteMissingNote = (label: string | null) =>
  `Not available: EGM${label ? ` ${label}` : ''} has no egm-lite. Install the development version (Install above) to get it now; a later EGM release will include it too.`;

/** The EGM row of Settings → Agents, with what is installed (EgmEntryRow). */
export function egmRootItem(m: EgmManager): SettingItem {
  const s = m.state;
  const on = m.settings().enabled;
  const commands = COMMANDS.filter((c) => m.available(c.id)).map((c) => `/${c.token}`).join(', ');
  return {
    kind: 'page',
    id: 'egm',
    label: 'EGM · Elephant-Goldfish',
    icon: 'psychology',
    description: s.version == null ? 'Not installed  ·  Review a design before any code' : !on ? `${m.label}  ·  Commands off` : `${m.label}  ·  ${commands}`,
    badge: s.version == null ? 'Not installed' : m.hasUpdate ? 'Update' : !on ? 'Off' : m.label,
  };
}

export function egmPage(m: EgmManager): SettingsPage {
  m.pageOpened();
  const s = m.state;
  const st = m.settings();
  const busy = m.busy;
  const label = m.label;
  const sections: SettingsSection[] = [
    {
      id: 'egm.about',
      title: 'What EGM does',
      description:
        "Google's Elephant-Goldfish Model (open source, Apache 2.0). The agent (the Elephant) works out a design with you and writes it down. Then fresh " +
        'reviewers (the Goldfish), who never saw your conversation, read only the document and try to break it. The design is fixed until it passes and you ' +
        'approve it; only then is code written. It uses more tokens than a plain chat: every reviewer reads the document, its persona and project files; ' +
        'Quick or Standard reviewers are usually enough.',
      items: [{ kind: 'button', id: 'egm.homepage', label: 'github.com/google/elephant-goldfish-model' }],
    },
  ];

  // installed from the other source: one press installs from the chosen one instead
  const switching = s.version != null && s.installedSource !== st.source;
  const actions: Extract<SettingItem, { kind: 'cli' }>['actions'] = [];
  if (s.version == null) actions.push({ id: 'egm.install', label: 'Install EGM', style: 'primary' });
  else if (switching) actions.push({ id: 'egm.install', label: st.source === 'MAIN' ? 'Install the development version' : 'Install the newest release', style: 'primary' });
  else if (m.hasUpdate) actions.push({ id: 'egm.install', label: s.installedSource === 'MAIN' ? `Update to main ${s.latestCommit}` : `Update to v${s.latest}`, style: 'primary' });
  else actions.push({ id: 'egm.install', label: 'Reinstall' });
  if (s.version != null && !m.hasUpdate && !switching) actions.push({ id: 'egm.check', label: 'Check for update' });
  for (const a of actions) a.disabled = busy;
  const log = [...s.log, ...(busy && s.progress ? [s.progress] : [])].join('\n');
  const installItems: SettingItem[] = [];
  if (s.message) {
    installItems.push(
      { kind: 'info', id: 'egm.message', label: s.message, value: '', tone: s.isError ? 'error' : 'ok' },
      { kind: 'button', id: 'egm.dismiss', label: 'Dismiss' },
    );
  }
  installItems.push(
    {
      kind: 'select',
      id: 'egm.source',
      label: 'Pick where it comes from',
      value: st.source,
      disabled: busy,
      options: (Object.keys(SOURCES) as Source[]).map((k) => ({ value: k, label: SOURCES[k].label, description: SOURCES[k].description })),
    },
    {
      kind: 'cli',
      id: 'egm.cli',
      label: 'EGM',
      state: s.version != null ? 'installed' : 'missing',
      version: label ? (m.hasUpdate ? `${label} · update available` : label) : null,
      path: s.version != null ? tildePath(m.rootDir) : null,
      message: s.version != null ? null : 'Not installed',
      job: s.task || s.log.length ? { kind: s.task ?? 'install', running: busy, ok: busy ? null : !s.isError, log } : null,
      actions,
      refreshId: null,
    },
  );
  sections.push({
    id: 'egm.install',
    title: 'Install',
    description: 'Downloads EGM from GitHub (the skills, the reviewer personas and the review standards) into a folder every agent on this PC can read.',
    items: installItems,
  });
  if (s.version == null) return { id: 'egm', title: 'EGM · Elephant-Goldfish', sections };

  sections.push(
    {
      id: 'egm.commands',
      title: 'Slash commands',
      description:
        'In a normal chat the agent runs the reviewers with its own subagent tool. In a Jarvis chat (Jarvis tab), Jarvis manages the run: it starts every ' +
        'reviewer as a separate chat, shows the phases as its mission steps and asks you to approve the design.',
      items: [
        {
          kind: 'toggle',
          id: 'egm.enabled',
          label: 'Use the EGM commands',
          description: 'Type one at the start of a message in any chat; the rest of the message is the task.',
          value: st.enabled,
        },
        ...COMMANDS.map((c): SettingItem => {
          const available = m.available(c.id);
          return {
            kind: 'info',
            id: `egm.cmd.${c.token}`,
            label: `/${c.token} <${c.argumentHint}>`,
            description: available ? c.description : `${c.description}. ${liteMissingNote(label)}`,
            value: available ? '' : 'Not available',
            tone: available ? null : 'warn',
          };
        }),
      ],
    },
    { id: 'egm.guide', title: '', items: [{ kind: 'page', id: EGM_GUIDE_PAGE, label: 'How to use EGM', icon: 'description' }] },
  );

  const preset = PRESETS.find((p) => p.reviewers.length === st.reviewers.length && p.reviewers.every((r) => st.reviewers.includes(r)));
  sections.push(
    {
      id: 'egm.reviewers',
      title: `Goldfish reviewers · ${st.reviewers.length} of ${PERSONAS.length}`,
      description:
        "Which of EGM's reviewer personas look at a design (/egm and /egm-review). Each is a separate reviewer run that costs tokens. /egm-lite always uses one reviewer.",
      items: [
        { kind: 'select', id: 'egm.preset', label: 'Presets', value: preset?.id ?? '', options: PRESETS.map((p) => ({ value: p.id, label: p.label })) },
        {
          kind: 'checklist',
          id: 'egm.reviewers',
          label: '',
          values: st.reviewers,
          options: PERSONAS.map((p) => ({ value: p.id, label: p.label, description: p.description })),
        },
      ],
    },
    {
      id: 'egm.review',
      title: 'Review',
      items: [
        {
          kind: 'toggle',
          id: 'egm.checkpoints',
          label: 'Stop after each review stage',
          description: "On: you see every stage's report before the next stage runs. Off: all stages run, then one combined report.",
          value: st.checkpoints,
        },
        {
          kind: 'select',
          id: 'egm.rounds',
          label: 'Re-reviews after fixes',
          description: 'How often a review stage may run again once the document is fixed. 0 = never.',
          value: String(st.rounds),
          options: Array.from({ length: MAX_ROUNDS + 1 }, (_, i) => ({ value: String(i), label: String(i) })),
        },
        {
          kind: 'select',
          id: 'egm.parallel',
          label: 'Reviewers at the same time',
          description: 'Each running reviewer is a full agent: more at once is faster but needs more memory.',
          value: String(st.parallel),
          options: Array.from({ length: MAX_PARALLEL }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
        },
        {
          kind: 'text',
          id: 'egm.artifactDir',
          label: 'Folder for designs and reports',
          description: 'In the project folder; each topic gets its own folder inside. You may want to add it to .gitignore.',
          value: st.artifactDir,
          placeholder: '.egm',
        },
      ],
    },
    {
      id: 'egm.jarvis',
      title: 'Jarvis',
      description: 'Who is the Elephant (writes and fixes the design) when you type an EGM command in a Jarvis chat. The reviewers are always separate chats that Jarvis starts.',
      items: [
        {
          kind: 'select',
          id: 'egm.elephant',
          label: 'Elephant',
          value: st.elephant,
          options: (Object.keys(ELEPHANTS) as Elephant[]).map((k) => ({ value: k, label: ELEPHANTS[k].label, description: ELEPHANTS[k].description })),
        },
      ],
    },
    {
      id: 'egm.instructions',
      title: 'Instructions',
      description:
        'What each command tells the agent after the facts from this page (where EGM is, the reviewers, the limits). Edit it to change how the agent or Jarvis runs EGM.',
      items: [
        {
          kind: 'list',
          id: 'egm.templates',
          label: '',
          rows: [
            templateRow('chat', 'Normal chats', st.chatTemplate, DEFAULT_CHAT_TEMPLATE, "Sent after the run's facts (EGM's folder, the reviewers, the limits). It tells the agent how to run the reviewers in its own chat."),
            templateRow(
              'jarvis',
              'Jarvis chats',
              st.jarvisTemplate,
              DEFAULT_JARVIS_TEMPLATE,
              "Sent after the run's facts (EGM's folder, the planner and reviewer goals, the limits). It tells Jarvis how to manage the planner and the reviewer chats.",
            ),
          ],
        },
        {
          kind: 'info',
          id: 'egm.adapter',
          label: 'Rules for the planner and the reviewers of Jarvis runs, written by the app from this page',
          description: tildePath(m.adapterDir),
          value: '',
        },
      ],
    },
    {
      id: 'egm.remove',
      title: 'Remove',
      items: [
        {
          kind: 'button',
          id: 'egm.uninstall',
          label: 'Remove EGM',
          style: 'danger',
          description: 'Deletes EGM and its rules files from this PC. Design documents and reports in your projects stay.',
          confirm: 'The /egm commands stop working. Your design documents and reports stay in your projects.',
          disabled: busy,
        },
      ],
    },
  );
  return { id: 'egm', title: 'EGM · Elephant-Goldfish', sections };
}

function templateRow(id: string, title: string, value: string, def: string, hint: string) {
  const changed = value !== def;
  return {
    id,
    title,
    status: changed ? 'Changed' : 'Default',
    statusTone: changed ? ('warn' as const) : ('ok' as const),
    actions: [
      { id: 'edit', label: 'Edit', form: [{ id: 'text', label: hint, kind: 'multiline' as const, value, required: true }] },
      ...(changed ? [{ id: 'reset', label: 'Reset to default', confirm: `Reset the instructions for ${title.toLowerCase()} to the default?` }] : []),
    ],
  };
}

/** settingChange on the page; false when it is not one of its items. */
export function egmChange(m: EgmManager, id: string, value: unknown): boolean {
  switch (id) {
    case 'egm.source': {
      const source: Source = value === 'MAIN' ? 'MAIN' : 'RELEASE';
      if (source === m.settings().source) return true;
      m.updateSettings((s) => ({ ...s, source }));
      void m.checkForUpdate();
      return true;
    }
    case 'egm.enabled':
      m.updateSettings((s) => ({ ...s, enabled: value === true }));
      return true;
    case 'egm.preset': {
      const p = PRESETS.find((x) => x.id === value);
      if (p) m.updateSettings((s) => ({ ...s, reviewers: p.reviewers }));
      return true;
    }
    case 'egm.reviewers': {
      // a review needs at least one reviewer
      const list = Array.isArray(value) ? (value as string[]).filter((v): v is PersonaId => PERSONAS.some((p) => p.id === v)) : [];
      if (!list.length) throw new Error('Keep at least one reviewer');
      m.updateSettings((s) => ({ ...s, reviewers: list }));
      return true;
    }
    case 'egm.checkpoints':
      m.updateSettings((s) => ({ ...s, checkpoints: value === true }));
      return true;
    case 'egm.rounds':
      m.updateSettings((s) => ({ ...s, rounds: Number(value) }));
      return true;
    case 'egm.parallel':
      m.updateSettings((s) => ({ ...s, parallel: Number(value) }));
      return true;
    case 'egm.artifactDir': {
      const dir = String(value ?? '').trim();
      if (!dir) throw new Error('Enter a folder');
      m.updateSettings((s) => ({ ...s, artifactDir: dir }));
      return true;
    }
    case 'egm.elephant':
      m.updateSettings((s) => ({ ...s, elephant: value === 'JARVIS' ? 'JARVIS' : 'PLANNER_CHAT' }));
      return true;
    default:
      return false;
  }
}

/** settingAction on the page: a toast text, '' when handled silently, null when not its item. */
export async function egmAction(m: EgmManager, id: string, openUrl: (url: string) => void, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | null> {
  switch (id) {
    case 'egm.install':
      void m.install();
      return '';
    case 'egm.check':
      await m.checkForUpdate();
      return '';
    case 'egm.uninstall':
      void m.uninstall();
      return '';
    case 'egm.dismiss':
      m.clearMessage();
      return '';
    case 'egm.homepage':
      openUrl(HOMEPAGE);
      return '';
    case 'egm.templates': {
      const key = rowId === 'jarvis' ? 'jarvisTemplate' : rowId === 'chat' ? 'chatTemplate' : null;
      if (!key) return null;
      if (actionId === 'reset') m.updateSettings((s) => ({ ...s, [key]: key === 'jarvisTemplate' ? DEFAULT_JARVIS_TEMPLATE : DEFAULT_CHAT_TEMPLATE }));
      else if (actionId === 'edit') {
        if (!values?.text?.trim()) throw new Error('Enter the instructions');
        m.updateSettings((s) => ({ ...s, [key]: values.text }));
      }
      return '';
    }
    default:
      return null;
  }
}

/** "How to use EGM" (EgmGuideCard) as Markdown: which command when, examples, normal vs Jarvis chat, a run's course, tips. */
export function egmGuide(m: EgmManager): string {
  const dir = m.settings().artifactDir;
  const lite = m.state.version != null && !m.state.hasLite ? `\n\n> ${liteMissingNote(m.label)}` : '';
  return `## Which command?

### \`/egm <task>\`

For a new feature or a big change, where a wrong design costs a lot: several files, data formats, APIs. Uses the most tokens.

1. The agent asks you questions until the idea is clear (brainstorm).
2. It writes the design document, section by section, and asks for your OK on each.
3. The reviewers attack the document; the agent fixes it or explains why a finding is wrong.
4. You approve the design.
5. Only then does it write the code.

Example: \`/egm add offline sync for notes, with conflict handling\`

### \`/egm-lite <task>\`${lite}

For small changes: a bug fix, a refactor, a small feature, a change to a spec. Much cheaper than /egm.

1. The agent first points out risks and gaps in the task, then waits.
2. Type checklist: it writes a short plan (egm_lite_checklist.md).
3. Type goldfish: one fresh reviewer checks the plan (you can skip this).
4. Type exec: it makes the change.
5. Type review: one fresh reviewer checks the changes.

Example: \`/egm-lite fix the crash when the chat list is empty\`

### \`/egm-review <doc path>\`

When a plan or design document already exists (yours, or written in another chat) and you want it checked before anyone builds it.

The reviewers check the document and the agent writes their findings into a report. Then you choose: the agent fixes the findings, you fix them yourself, or you stop there.

Example: \`/egm-review docs/sync-design.md\`

## Normal chat or Jarvis chat?

Normal chat (Claude Code, Codex, …): the agent does everything in that chat and runs the reviewers as its own hidden sub-agents. The simplest and lightest way. If the agent has no sub-agent tool, it stops and tells you to use a Jarvis chat.

Jarvis chat (Jarvis tab → a Jarvis chat, then type the command): Jarvis manages the run. It starts a planner chat (or plans itself, see Jarvis in the EGM settings) and one chat per reviewer, which you can open from the chat list. The phases show as Jarvis' mission steps, and Jarvis asks you to approve the design. Use it to watch the reviewers, or when the agent has no sub-agent tool. Every reviewer chat is a full agent, so it needs more memory.

## During a run

- Answer the agent's questions: it asks one at a time.
- Everything is saved as files in your project, in \`${dir}/<topic>/\`: the design document and every review report. Open them in the editor.
- Nothing is coded before you approve. To approve, just say so; or ask for changes, or for one more review round.
- You can stop at any time. The files stay, and later you can check the document again with /egm-review.

## Tips

- Start with Quick or Standard reviewers; Full runs eight reviewers in every round.
- If your PC gets slow, set Reviewers at the same time to 1.
- Write the task as you would explain it to a colleague: what, why, and any limits ("no new libraries").
- For a change of a few lines, a plain chat is cheaper than EGM.
`;
}
