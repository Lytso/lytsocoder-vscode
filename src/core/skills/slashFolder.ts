// The folder whose skills and commands an agent's "/" menu shows (the app's slashCwd: the open chat's project, else
// the active project). The host asks it for the chat a view shows and passes it to the backend's slashFolder().
import type { Conversation } from '../../../shared/model';
import type { WorkspaceFolder } from '../../../shared/protocol';
import { absPath } from '../paths';

/**
 * `conversationId`'s project; for a new chat (null, or not listed yet) the project picked for new chats (the shared
 * pref `lastProject`, '' = none), else the first folder open in VS Code.
 */
export function slashFolderOf(conversationId: string | null, conversations: Conversation[], lastProject: unknown, folders: WorkspaceFolder[]): string | null {
  const conv = conversationId ? conversations.find((c) => c.id === conversationId) : undefined;
  if (conv) return absPath(conv.workspaceUri);
  if (typeof lastProject === 'string') return absPath(lastProject);
  return absPath(folders[0]?.path ?? null);
}
