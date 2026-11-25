/**
 * The agent CLIs Codophon can drive, in first-run detection order. Everything that varies by agent
 * (labels, settings keys, error codes, CLI flags) derives from this list.
 */
export const AGENT_BACKENDS = ['codex', 'claude', 'opencode'] as const;

export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/** Reported when an agent's CLI is not installed, e.g. `CLAUDE_NOT_FOUND`. */
export type AgentNotFoundCode = `${Uppercase<AgentBackend>}_NOT_FOUND`;

export const DEFAULT_AGENT_BACKEND: AgentBackend = 'codex';

export const AGENT_LABELS: Readonly<Record<AgentBackend, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export const isAgentBackend = (value: unknown): value is AgentBackend =>
  (AGENT_BACKENDS as ReadonlyArray<unknown>).includes(value);

export const normalizeAgentBackend = (value: unknown): AgentBackend =>
  isAgentBackend(value) ? value : DEFAULT_AGENT_BACKEND;

export const isAgentNotFoundCode = (code: unknown): code is AgentNotFoundCode =>
  AGENT_BACKENDS.some((agent) => code === `${agent.toUpperCase()}_NOT_FOUND`);
