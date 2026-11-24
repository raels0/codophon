import type { CodophonAgentBackend } from '../config/types.ts';
import type { AgentSkillStatus, CodophonLaunchOptions, TerminalHelperStatus } from '../types.ts';

export const HISTORY_PAGE_SIZE = 30;

export const defaultLaunchOptions: CodophonLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

export const defaultAgentSkillStatus: AgentSkillStatus = {
  installed: false,
  path: '',
};

const AGENT_LABELS: Record<CodophonAgentBackend, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export const getAgentLabel = (backend: CodophonAgentBackend): string =>
  AGENT_LABELS[backend] ?? AGENT_LABELS.codex;

export const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codophon',
  installed: false,
  path: '',
};

/** The command palette asks the diff view to enter edit mode through this window event. */
export const EDIT_SELECTED_FILE_EVENT = 'codophon:edit-selected-file';
