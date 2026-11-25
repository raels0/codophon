import {
  AGENT_BACKENDS,
  AGENT_LABELS,
  DEFAULT_AGENT_BACKEND,
  normalizeAgentBackend,
  type AgentBackend,
  type AgentNotFoundCode,
} from '../core/config/agents.ts';
import type { WalkthroughContext } from '../core/types.ts';
import { parseJSONMessage } from './agent-shared.ts';
import { readClaudeSessionContext } from './claude-session-context.ts';
import * as claude from './claude.ts';
import { readCodexSessionContext } from './codex-session-context.ts';
import * as codex from './codex.ts';
import { readOpenCodeSessionContext } from './opencode-session-context.ts';
import * as opencode from './opencode.ts';

export type AgentOptions = {
  fallbackModel?: string;
  model?: string;
  onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
  onProgress?: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void;
  reasoningEffort?: string;
  timeoutMs?: number;
};

/** What generating a reply needs from an agent: run its CLI and recognise when it is missing. */
export type AgentRunner = Pick<
  Agent,
  'defaultTimeoutMs' | 'id' | 'isNotFoundError' | 'label' | 'notFoundCode' | 'run'
>;

export type Agent = {
  id: AgentBackend;
  label: string;
  defaultTimeoutMs: number;
  models: ReadonlyArray<{ id: string; label: string }>;
  defaultModel: string;
  fallbackModel: string;
  normalizeModel: (value: unknown) => string;
  notFoundCode: AgentNotFoundCode;
  isAvailable: () => boolean;
  isNotFoundError: (error: unknown) => boolean;
  run: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: AgentOptions,
  ) => Promise<unknown>;
  readSessionContext: (
    sessionId: string | undefined,
  ) => Promise<WalkthroughContext | null> | WalkthroughContext | null;
};

const canResolveCommand = (
  getCommand: () => string,
  isNotFoundError: (error: unknown) => boolean,
) => {
  try {
    getCommand();
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
};

type AgentImplementation = Pick<
  Agent,
  | 'models'
  | 'defaultModel'
  | 'fallbackModel'
  | 'normalizeModel'
  | 'readSessionContext'
  | 'defaultTimeoutMs'
  | 'isNotFoundError'
> & {
  command: () => string;
  invoke: (...args: Parameters<Agent['run']>) => Promise<string>;
};

const defineAgent = (
  id: AgentBackend,
  { command, invoke, ...implementation }: AgentImplementation,
): Agent => ({
  ...implementation,
  id,
  label: AGENT_LABELS[id],
  notFoundCode: `${id.toUpperCase()}_NOT_FOUND` as AgentNotFoundCode,
  isAvailable: () => canResolveCommand(command, implementation.isNotFoundError),
  run: async (...args) => parseJSONMessage(await invoke(...args)),
});

const agents: Record<AgentBackend, Agent> = {
  codex: defineAgent('codex', {
    command: codex.getCodexCommand,
    defaultTimeoutMs: codex.CODEX_TIMEOUT_MS,
    models: codex.OPENAI_MODELS,
    defaultModel: codex.DEFAULT_OPENAI_MODEL,
    fallbackModel: codex.FALLBACK_OPENAI_MODEL,
    normalizeModel: codex.normalizeOpenAIModel,
    isNotFoundError: codex.isCodexNotFoundError,
    invoke: codex.runCodex,
    readSessionContext: readCodexSessionContext,
  }),
  claude: defineAgent('claude', {
    command: claude.getClaudeCommand,
    defaultTimeoutMs: claude.CLAUDE_TIMEOUT_MS,
    models: claude.CLAUDE_MODELS,
    defaultModel: claude.DEFAULT_CLAUDE_MODEL,
    fallbackModel: claude.FALLBACK_CLAUDE_MODEL,
    normalizeModel: claude.normalizeClaudeModel,
    isNotFoundError: claude.isClaudeNotFoundError,
    invoke: claude.runClaude,
    readSessionContext: readClaudeSessionContext,
  }),
  opencode: defineAgent('opencode', {
    command: opencode.getOpenCodeCommand,
    defaultTimeoutMs: opencode.OPENCODE_TIMEOUT_MS,
    models: opencode.OPENCODE_MODELS,
    defaultModel: opencode.DEFAULT_OPENCODE_MODEL,
    fallbackModel: opencode.FALLBACK_OPENCODE_MODEL,
    normalizeModel: opencode.normalizeOpenCodeModel,
    isNotFoundError: opencode.isOpenCodeNotFoundError,
    invoke: opencode.runOpenCode,
    readSessionContext: readOpenCodeSessionContext,
  }),
};
const getAgent = (backend: unknown) => agents[normalizeAgentBackend(backend)];
const listAgents = () => AGENT_BACKENDS.map((id) => agents[id]);

const getAgentMenuModels = (
  agent: Agent,
  selectedModel: string,
  models: Agent['models'] = agent.models,
): ReadonlyArray<{ id: string; label: string }> =>
  models.some((model) => model.id === selectedModel)
    ? models
    : [...models, { id: selectedModel, label: `Custom: ${selectedModel}` }];

/**
 * Select the first installed backend without launching a CLI process.
 */
const detectInitialAgentBackend = (
  isAvailable: (agent: Agent) => boolean = (agent) => agent.isAvailable(),
): AgentBackend => listAgents().find(isAvailable)?.id ?? DEFAULT_AGENT_BACKEND;

export {
  detectInitialAgentBackend,
  getAgentMenuModels,
  getAgent,
  listAgents,
  normalizeAgentBackend,
};
