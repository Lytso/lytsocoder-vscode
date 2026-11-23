// Skills for every agent (Phase 7 item 3): each agent's own skills folder from GitHub (panel.ts, the app's
// AgentSkillsPanel), Antigravity plugins from GitHub, and "Set up with AI" for repositories LytsoCoder can't add.
export { AgentSkillsClient, AGENT_IDS, type AgentSkill, type RepoInspect, type RepoSkill } from './client';
export { AgentSkillsPanel, pluginHint, type SkillsPanelHooks } from './panel';
export { SETUP_WITH_AI, repoSetupPrompt, setupChatRequest, setupWithAiItem, type RepoSetupKind } from './setupWithAi';
export { slashFolderOf } from './slashFolder';
