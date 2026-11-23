// `?mock`: project checkpoints for the fake host (dev/mock.ts): every user message of an opened chat has a restore
// point, and the restore sheet's requests answer with a made-up project.
import type { ChatMessage } from '@shared/model';
import type { CheckpointPreviewView, HostToView, ViewToHost } from '@shared/protocol';

type Post = (m: HostToView) => void;
const PROJECT = '/home/dev/nebula-weather';

export function mockRestorePoints(post: Post, cid: string, messages: ChatMessage[], agent = 'claude') {
  const byMessage: Extract<HostToView, { type: 'checkpoints' }>['byMessage'] = {};
  for (const m of messages)
    if (m.role === 'USER' && !m.jarvisEvents) byMessage[m.id] = { id: `cp_${m.id}`, time: m.createdAt, kind: 'turn', agent, title: m.content.split('\n')[0].slice(0, 120), repos: 1 };
  post({ type: 'checkpoints', conversationId: cid, project: PROJECT, byMessage });
}

export function mockCheckpointRequest(post: Post, m: Extract<ViewToHost, { type: 'checkpoint' }>) {
  const r = m.request;
  const reply = (fields: Omit<Extract<HostToView, { type: 'checkpointReply' }>, 'type' | 'reqId'>, ms = 500) =>
    setTimeout(() => post({ type: 'checkpointReply', reqId: m.reqId, ...fields }), ms);
  const preview = (undo?: string): CheckpointPreviewView => ({
    checkpoint: { id: 'id' in r ? r.id : 'cp', time: Date.now() - 40 * 60_000, kind: 'turn', agent: 'claude', title: 'Make the forecast cards responsive' },
    files: [
      { path: 'src/components/ForecastCard.tsx', change: 'modified', added: 12, removed: 31 },
      { path: 'src/styles/cards.css', change: 'modified', added: 4, removed: 9 },
      { path: 'src/components/CardGrid.tsx', change: 'deleted', added: 0, removed: 58 },
      { path: 'src/hooks/useBreakpoint.ts', change: 'recreated', added: 22, removed: 0 },
      { path: 'public/forecast.png', change: 'modified', added: 0, removed: 0, binary: true },
    ],
    modified: 3,
    deleted: 1,
    recreated: 1,
    warnings: [
      { kind: 'other_chats', text: '2 chats sent messages in this project after this point; their changes go back too:' },
      { kind: 'outside', text: 'Only files inside the project go back. What the agent did outside it (installed packages, files elsewhere, servers it started, things it sent) is not undone.' },
    ],
    laterChats: [
      { agent: 'codex', title: 'Add a dark mode toggle', time: Date.now() - 20 * 60_000, turns: 3 },
      { agent: 'agy', title: 'Fix the flaky snapshot test', time: Date.now() - 6 * 60_000, turns: 1 },
    ],
    errors: [],
    undoId: undo ?? null,
    otherRunning: 1,
  });
  switch (r.action) {
    case 'project':
      return reply({ project: { path: PROJECT, isGit: true, shouldAsk: new URLSearchParams(location.search).has('cpask') } }, 200);
    case 'decide':
      return reply({ project: { path: PROJECT, isGit: true, shouldAsk: false } }, 200);
    case 'preview':
      return reply({ preview: preview() }, 900);
    case 'restore':
      return reply({ preview: preview('cp_undo') }, 1200);
    case 'diff':
      post({ type: 'toast', level: 'info', message: `(mock) VS Code opens ${r.file}: now ↔ checkpoint` });
      return reply({}, 300);
    case 'delete':
      return reply({}, 300);
  }
}
