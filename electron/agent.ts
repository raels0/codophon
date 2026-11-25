import {
  AGENT_BACKENDS,
  DEFAULT_AGENT_BACKEND,
  normalizeAgentBackend,
  type AgentBackend,
  type AgentNotFoundCode,
} from '../core/config/agents.ts';
import type { WalkthroughContext } from '../core/types.ts';
import { readClaudeSessionContext } from './claude-session-context.ts';
import * as claude from './claude.ts';
import { readCodexSessionContext } from './codex-session-context.ts';
import * as codex from './codex.ts';
import { readOpenCodeSessionContext } from './opencode-session-context.ts';
import * as opencode from './opencode.ts';

export type AgentOptions = {
  fallbackModel?: string;
  model?: string;
  onMetrics?: (metrics: {
    transport: 'app-server' | 'exec';
    usage?: {
      cachedInputTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    };
  }) => void;
  onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
  onPartialText?: (delta: string) => void;
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
  cliName: string;
  cliPathEnvVar: string;
  defaultTimeoutMs: number;
  models: ReadonlyArray<{ id: string; label: string }>;
  defaultModel: string;
  fallbackModel: string;
  modelSettingKey: 'openAIModel' | 'claudeModel' | 'opencodeModel';
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
  ) => Promise<string>;
  readSessionContext: (
    sessionId: string | undefined,
  ) => Promise<WalkthroughContext | null> | WalkthroughContext | null;
  sessionLaunchOptionKey: 'codexSessionId' | 'claudeSessionId' | 'opencodeSessionId';
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

const createCodexAgent = (): Agent => ({
  id: 'codex',
  label: 'Codex',
  cliName: 'codex',
  cliPathEnvVar: 'CODOPHON_CODEX_PATH',
  defaultTimeoutMs: codex.CODEX_TIMEOUT_MS,
  models: codex.OPENAI_MODELS,
  defaultModel: codex.DEFAULT_OPENAI_MODEL,
  fallbackModel: codex.FALLBACK_OPENAI_MODEL,
  modelSettingKey: 'openAIModel',
  normalizeModel: codex.normalizeOpenAIModel,
  notFoundCode: codex.CODEX_NOT_FOUND_CODE,
  isAvailable: () => canResolveCommand(codex.getCodexCommand, codex.isCodexNotFoundError),
  isNotFoundError: codex.isCodexNotFoundError,
  run: codex.runCodex,
  readSessionContext: readCodexSessionContext,
  sessionLaunchOptionKey: 'codexSessionId',
});

const createClaudeAgent = (): Agent => ({
  id: 'claude',
  label: 'Claude Code',
  cliName: 'claude',
  cliPathEnvVar: 'CODOPHON_CLAUDE_PATH',
  defaultTimeoutMs: claude.CLAUDE_TIMEOUT_MS,
  models: claude.CLAUDE_MODELS,
  defaultModel: claude.DEFAULT_CLAUDE_MODEL,
  fallbackModel: claude.FALLBACK_CLAUDE_MODEL,
  modelSettingKey: 'claudeModel',
  normalizeModel: claude.normalizeClaudeModel,
  notFoundCode: claude.CLAUDE_NOT_FOUND_CODE,
  isAvailable: () => canResolveCommand(claude.getClaudeCommand, claude.isClaudeNotFoundError),
  isNotFoundError: claude.isClaudeNotFoundError,
  run: claude.runClaude,
  readSessionContext: readClaudeSessionContext,
  sessionLaunchOptionKey: 'claudeSessionId',
});

const createOpenCodeAgent = (): Agent => ({
  id: 'opencode',
  label: 'OpenCode',
  cliName: 'opencode',
  cliPathEnvVar: 'CODOPHON_OPENCODE_PATH',
  defaultTimeoutMs: opencode.OPENCODE_TIMEOUT_MS,
  models: opencode.OPENCODE_MODELS,
  defaultModel: opencode.DEFAULT_OPENCODE_MODEL,
  fallbackModel: opencode.FALLBACK_OPENCODE_MODEL,
  modelSettingKey: 'opencodeModel',
  normalizeModel: opencode.normalizeOpenCodeModel,
  notFoundCode: opencode.OPENCODE_NOT_FOUND_CODE,
  isAvailable: () =>
    canResolveCommand(opencode.getOpenCodeCommand, opencode.isOpenCodeNotFoundError),
  isNotFoundError: opencode.isOpenCodeNotFoundError,
  run: opencode.runOpenCode,
  readSessionContext: readOpenCodeSessionContext,
  sessionLaunchOptionKey: 'opencodeSessionId',
});

const AGENT_FACTORIES: Record<AgentBackend, () => Agent> = {
  claude: createClaudeAgent,
  codex: createCodexAgent,
  opencode: createOpenCodeAgent,
};

const getAgent = (backendId: unknown): Agent => AGENT_FACTORIES[normalizeAgentBackend(backendId)]();

const listAgents = (): ReadonlyArray<Agent> => AGENT_BACKENDS.map((id) => AGENT_FACTORIES[id]());

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
