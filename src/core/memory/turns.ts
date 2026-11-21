// The chat as the bridge's history gets it (port of MemorySync.kt's turnsOf / userText / replyText): the user's
// messages as typed and the replies as shown, without thinking, tool calls, error cards or hidden blocks.
import type { ChatMessage } from '../../../shared/model';
import { collapseExpansions, extractAttachedFiles } from '../text';
import type { Turn } from './client';

const THOUGHT = /<!--\s*thought[^>]*-->[\s\S]*?(<!--\s*\/thought\s*-->|$)/g;
const THOUGHT_TAG = /<thought>[\s\S]*?<\/thought>/gi;
const THINKING_TAG = /<thinking>[\s\S]*?<\/thinking>/gi;
const ERROR_CARD = /<!--\s*error[^>]*-->[\s\S]*?<!--\s*\/error\s*-->/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const CHAT_TITLE = /<chat_title>[\s\S]*?<\/chat_title>\s*/gi;

export function userText(raw: string): string {
  return collapseExpansions(extractAttachedFiles(raw, 'memory').text).trim();
}

export function replyText(raw: string): string {
  const s = collapseExpansions(raw)
    .replace(ERROR_CARD, '')
    .replace(THOUGHT, '')
    .replace(THOUGHT_TAG, '')
    .replace(THINKING_TAG, '')
    .replace(COMMENT, '')
    .replace(CHAT_TITLE, '');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The finished messages of a chat as turns (the first one dated [startedAt]: it names the history file). */
export function turnsOf(messages: ChatMessage[], startedAt: number): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    if (m.isStreaming) continue;
    let t: Turn | null = null;
    if (m.role === 'USER') {
      const text = userText(m.content);
      if (text) t = { role: 'user', text, at: 0 };
    } else if (m.role === 'ASSISTANT') {
      const text = replyText(m.content);
      if (text) t = { role: 'assistant', text, at: 0 };
    } else if (m.role === 'SUMMARY') {
      const text = (m.contextSummary ?? m.content).trim();
      if (text) t = { role: 'summary', text, at: 0 };
    }
    if (t) out.push(t);
  }
  if (out.length) out[0] = { ...out[0], at: startedAt };
  return out;
}
