import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  collectAgentOutput,
  findAgentCommand,
  resolveAgentCommandTransport,
} from './agent-command.ts';
import { normalizeEnum, oneLine } from './agent-shared.ts';
import { getCommandEnvironment } from './login-shell-environment.ts';

// Claude Code can be slower to first token than Codex, so allow a longer budget.
const CLAUDE_TIMEOUT_MS = 90_000;
const DEFAULT_CLAUDE_MODEL = 'sonnet';
const FALLBACK_CLAUDE_MODEL = 'haiku';
const CLAUDE_NOT_FOUND_CODE = 'CLAUDE_NOT_FOUND';
const CLAUDE_NOT_FOUND_MESSAGE =
  'Claude Code CLI was not found. Install Claude Code and verify `claude --version` works in Terminal. Codophon searches PATH, ~/.local/bin/claude, /opt/homebrew/bin/claude, and /usr/local/bin/claude. If Claude Code is installed somewhere else, launch Codophon with `CODOPHON_CLAUDE_PATH=/absolute/path/to/claude codophon -w`.';
const CLAUDE_NOT_LOGGED_IN_MESSAGE =
  'Claude Code is not logged in. Run `claude` in Terminal and complete `/login`, then try again.';

export type ClaudeOptions = {
  fallbackModel?: string;
  commandTransport?: import('./agent-command.ts').AgentCommandTransport;
  model?: string;
  onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
  onProgress?: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void;
  timeoutMs?: number;
};
export type ClaudeModel = {
  id: string;
  label: string;
};

const CLAUDE_MODELS: ReadonlyArray<ClaudeModel> = Object.freeze([
  {
    id: 'opus',
    label: 'Best: Claude Opus',
  },
  {
    id: DEFAULT_CLAUDE_MODEL,
    label: 'Balanced: Claude Sonnet',
  },
  {
    id: FALLBACK_CLAUDE_MODEL,
    label: 'Fast: Claude Haiku',
  },
]);
const CLAUDE_MODEL_IDS = new Set(CLAUDE_MODELS.map((model) => model.id));

const createClaudeNotFoundError = (detail?: string) =>
  Object.assign(
    new Error(detail ? `${CLAUDE_NOT_FOUND_MESSAGE} ${detail}` : CLAUDE_NOT_FOUND_MESSAGE),
    {
      code: CLAUDE_NOT_FOUND_CODE,
    },
  );

const getClaudeCommand = () =>
  findAgentCommand(
    'claude',
    'CODOPHON_CLAUDE_PATH',
    [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
    createClaudeNotFoundError,
  );

const isClaudeNotFoundError = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === CLAUDE_NOT_FOUND_CODE || error.code === 'ENOENT'),
  );

const isClaudeNotLoggedInError = (value: string) =>
  /\b(?:not logged in|please run \/login|run \/login|invalid api key|authentication_error|oauth)\b/i.test(
    value,
  );

// Legacy configs store pinned ids like `claude-sonnet-4-6`; map them to the CLI alias.

const normalizeClaudeModel = (value: unknown): string =>
  normalizeEnum(
    typeof value === 'string' ? value.replace(/^claude-(opus|sonnet|haiku)\b.*$/, '$1') : value,
    CLAUDE_MODEL_IDS,
    DEFAULT_CLAUDE_MODEL,
  );

const isClaudeModelAvailabilityError = (value: string) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

const getClaudeLaunchError = (error: unknown) => {
  if (isClaudeNotFoundError(error)) {
    return createClaudeNotFoundError();
  }

  return error instanceof Error ? error : new Error(String(error ?? ''));
};

/**
 * Consume Claude Code `stream-json` events. Thinking and text deltas only
 * update semantic progress; no model text is forwarded outside this process.
 */
const createClaudeStreamParser = (onProgress: ClaudeOptions['onProgress']) => {
  let resultEnvelope: any = null;
  let lineBuffer = '';

  const handleEvent = (input: unknown) => {
    const event = input as any;
    if (!event || typeof event !== 'object') {
      return;
    }
    if (event.type === 'result') {
      resultEnvelope = event;
      return;
    }
    if (event.type !== 'stream_event') {
      return;
    }

    const streamEvent = event.event;
    if (streamEvent?.type === 'content_block_start') {
      const blockType = streamEvent.content_block?.type;
      if (blockType === 'thinking') {
        onProgress?.('agent-generation');
      } else if (blockType === 'text' || blockType === 'tool_use') {
        onProgress?.('response-received');
      }
      return;
    }
    if (streamEvent?.type !== 'content_block_delta') {
      return;
    }
    const deltaType = streamEvent.delta?.type;
    if (deltaType === 'thinking_delta') {
      onProgress?.('agent-generation');
    } else if (deltaType === 'text_delta' || deltaType === 'input_json_delta') {
      onProgress?.('response-received');
    }
  };

  const push = (text: string) => {
    lineBuffer += text;
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Non-JSON diagnostics remain available to the caller on failure.
        }
      }
      newlineIndex = lineBuffer.indexOf('\n');
    }
  };

  const flush = () => {
    const rest = lineBuffer.trim();
    lineBuffer = '';
    if (rest) {
      try {
        handleEvent(JSON.parse(rest));
      } catch {}
    }
    return resultEnvelope;
  };

  return { flush, push };
};

/**
 * Run Claude Code headless as a pure, read-only structured-output call.
 *
 * Mirrors the shape of {@link runCodex}: prompt is sent on stdin, output is a
 * JSON string validated against the provided schema. Tools are fully disabled
 * so Claude answers only from the prompt text, and session persistence is off
 * so the call leaves no transcript behind.
 */
const runClaude = async (
  repoRoot: string,
  prompt: string,
  schema: unknown,
  _outputName: string = 'claude-output.json',
  timeoutMessage: string = 'Claude Code timed out.',
  options: ClaudeOptions = {},
) => {
  const model = normalizeClaudeModel(options.model);
  const fallbackModel = normalizeClaudeModel(options.fallbackModel || FALLBACK_CLAUDE_MODEL);
  const timeoutMs = options.timeoutMs ?? CLAUDE_TIMEOUT_MS;

  const invokeClaude = async (claudeModel: string): Promise<string> => {
    const environment = await getCommandEnvironment();
    const commandTransport = resolveAgentCommandTransport(
      options.commandTransport,
      getClaudeCommand,
    );
    const streamProgress = Boolean(options.onProgress);
    const claudeArgs = [
      '-p',
      '--output-format',
      streamProgress ? 'stream-json' : 'json',
      ...(streamProgress ? ['--verbose', '--include-partial-messages'] : []),
      '--json-schema',
      JSON.stringify(schema),
      '--model',
      claudeModel,
      '--add-dir',
      repoRoot,
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--tools',
      '',
    ];
    const child = commandTransport.spawn(commandTransport.command, claudeArgs, {
      cwd: repoRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const streamParser = streamProgress ? createClaudeStreamParser(options.onProgress) : null;
    const stdout = await collectAgentOutput(child, {
      label: 'Claude Code',
      getLaunchError: getClaudeLaunchError,
      onStdout: streamParser?.push,
      prompt,
      timeoutMessage,
      timeoutMs,
    });
    let envelope = streamParser?.flush();
    if (!envelope) {
      try {
        envelope = JSON.parse(stdout);
      } catch {
        throw new Error(oneLine(stdout, 'Claude Code did not return JSON.'));
      }
    }
    const resultText = typeof envelope?.result === 'string' ? envelope.result : '';
    if (envelope?.is_error) {
      throw new Error(
        isClaudeNotLoggedInError(resultText)
          ? CLAUDE_NOT_LOGGED_IN_MESSAGE
          : oneLine(resultText, 'Claude Code reported an error.'),
      );
    }
    return envelope?.structured_output && typeof envelope.structured_output === 'object'
      ? JSON.stringify(envelope.structured_output)
      : resultText;
  };

  try {
    return await invokeClaude(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel || !isClaudeModelAvailabilityError(message)) {
      throw error;
    }

    const response = await invokeClaude(fallbackModel);
    await options.onModelFallback?.(fallbackModel, model);
    return response;
  }
};

export {
  CLAUDE_MODELS,
  CLAUDE_NOT_FOUND_CODE,
  CLAUDE_TIMEOUT_MS,
  DEFAULT_CLAUDE_MODEL,
  FALLBACK_CLAUDE_MODEL,
  getClaudeCommand,
  isClaudeNotFoundError,
  normalizeClaudeModel,
  runClaude,
};
