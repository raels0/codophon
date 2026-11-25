import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectAgentOutput,
  missingAgentError,
  withModelFallback,
  createJsonLineReader,
  findAgentCommand,
  resolveAgentCommandTransport,
} from './agent-command.ts';
import { oneLine } from './agent-shared.ts';
import type { AgentOptions } from './agent.ts';
import { getCommandEnvironment } from './login-shell-environment.ts';

const CODEX_TIMEOUT_MS = 90_000;
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
const FALLBACK_OPENAI_MODEL = 'gpt-5.5';
const CODEX_REASONING_EFFORT = 'low';
const CODEX_MACOS_BLOCKED_MESSAGE =
  'macOS blocked the local Codex CLI. Update Codex CLI from the official OpenAI release, then run `codex --version` and try again.';
const CODEX_NOT_FOUND_CODE = 'CODEX_NOT_FOUND';
const CODEX_NOT_FOUND_MESSAGE =
  'Codex CLI was not found. Install Codex and verify `codex --version` works in Terminal. On macOS, Codophon also checks for the CLI bundled with Codex.app or ChatGPT.app. If Codex is installed somewhere else, launch Codophon with `CODOPHON_CODEX_PATH=/absolute/path/to/codex codophon -w`.';
export type CodexOptions = AgentOptions & {
  commandTransport?: import('./agent-command.ts').AgentCommandTransport;
  onMetrics?: (metrics: {
    transport: 'exec';
    usage?: {
      cachedInputTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    };
  }) => void;
};
export type OpenAIModel = {
  id: string;
  label: string;
};

const OPENAI_MODELS: ReadonlyArray<OpenAIModel> = Object.freeze([
  {
    id: DEFAULT_OPENAI_MODEL,
    label: 'Default: GPT-5.6 Terra',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'Strong: GPT-5.6 Sol',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'Fast: GPT-5.6 Luna',
  },
  {
    id: FALLBACK_OPENAI_MODEL,
    label: 'Compatibility: GPT-5.5',
  },
]);
const OPENAI_MODEL_REASONING_EFFORTS = new Map([
  [DEFAULT_OPENAI_MODEL, CODEX_REASONING_EFFORT],
  [FALLBACK_OPENAI_MODEL, CODEX_REASONING_EFFORT],
  ['gpt-5.6-sol', 'medium'],
  ['gpt-5.6-luna', 'medium'],
  ['gpt-6-astra', CODEX_REASONING_EFFORT],
  ['gpt-6-sol', CODEX_REASONING_EFFORT],
  ['gpt-6-luna', CODEX_REASONING_EFFORT],
]);

const { create: createCodexNotFoundError, matches: isCodexNotFoundError } = missingAgentError(
  CODEX_NOT_FOUND_CODE,
  CODEX_NOT_FOUND_MESSAGE,
);

const getCodexInstallPaths = (
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
) => [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  ...(platform === 'darwin'
    ? [
        '/Applications/Codex.app/Contents/Resources/codex',
        join(home, 'Applications/Codex.app/Contents/Resources/codex'),
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'),
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
        join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
      ]
    : []),
];

const getCodexCommand = (installPaths: ReadonlyArray<string> = getCodexInstallPaths()) =>
  findAgentCommand('codex', 'CODOPHON_CODEX_PATH', installPaths, createCodexNotFoundError);

const getCodexLaunchErrorMessage = (
  error: unknown,
  platform: NodeJS.Platform = process.platform,
) => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
          ? error.message
          : String(error ?? '');
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const signal =
    error && typeof error === 'object' && 'signal' in error && typeof error.signal === 'string'
      ? error.signal
      : '';

  if (isCodexNotFoundError(error)) {
    return CODEX_NOT_FOUND_MESSAGE;
  }

  if (
    platform === 'darwin' &&
    (code === 'EACCES' ||
      code === 'EPERM' ||
      signal === 'SIGKILL' ||
      /\b(?:contains malware|malware blocked|not opened|will damage your computer|moved to (?:the )?bin|permission denied|operation not permitted)\b/i.test(
        message,
      ))
  ) {
    return message.trim()
      ? `${CODEX_MACOS_BLOCKED_MESSAGE} (${message})`
      : CODEX_MACOS_BLOCKED_MESSAGE;
  }

  return message;
};

const getCodexLaunchError = (error: unknown) => {
  if (isCodexNotFoundError(error)) {
    return createCodexNotFoundError();
  }

  const message = getCodexLaunchErrorMessage(error);
  if (error instanceof Error && message === error.message) {
    return error;
  }

  return new Error(message);
};

const getCodexStructuredErrorMessage = (value: string) => {
  const matches = Array.from(value.matchAll(/\bERROR:\s*(\{[^\n]+\})/g));
  for (const match of matches.reverse()) {
    try {
      const payload = JSON.parse(match[1]);
      const message = payload?.error?.message || payload?.message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    } catch {
      // Ignore malformed CLI diagnostics and fall back to the raw stream.
    }
  }

  return null;
};

const normalizeOpenAIModel = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OPENAI_MODEL;

const getOpenAIModelReasoningEffort = (model: unknown, reasoningEffort?: unknown) =>
  typeof reasoningEffort === 'string' && reasoningEffort.trim()
    ? reasoningEffort.trim()
    : OPENAI_MODEL_REASONING_EFFORTS.get(normalizeOpenAIModel(model));

const getOpenAIModelFallbacks = (
  model: unknown,
  fallbackModel: unknown = FALLBACK_OPENAI_MODEL,
) => {
  const normalizedModel = normalizeOpenAIModel(model);
  const candidates = [
    ...(normalizedModel !== DEFAULT_OPENAI_MODEL && normalizedModel !== FALLBACK_OPENAI_MODEL
      ? [DEFAULT_OPENAI_MODEL]
      : []),
    normalizeOpenAIModel(fallbackModel),
  ];
  return [...new Set(candidates)].filter((candidate) => candidate !== normalizedModel);
};

const isOpenAIModelAvailabilityError = (value: string) =>
  !/\b(?:model_reasoning_effort|reasoning[_\s-]*effort|effort)\b/i.test(value) &&
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|model\b.*not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

const normalizeCodexUsage = (usage: any) => {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens) || 0;
  const cachedInputTokens = Number(usage.cached_input_tokens ?? usage.cachedInputTokens) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens) || 0;
  const reasoningOutputTokens =
    Number(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens) || 0;
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
};

/**
 * Consume `codex exec --json` JSONL, turning its events into progress phases without exposing
 * model output.
 */
const createCodexEventParser = (onProgress: CodexOptions['onProgress']) => {
  let lastMessage = '';
  let usage:
    | {
        cachedInputTokens: number;
        inputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
        totalTokens: number;
      }
    | undefined;

  const handleEvent = (input: unknown) => {
    const event = input as any;
    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'turn.completed') {
      usage = normalizeCodexUsage(event.usage);
    }

    if (event.type === 'thread.started') {
      onProgress?.('agent-generation');
      return;
    }

    const itemType = event.item?.type;
    if (
      (event.type === 'item.started' && itemType !== 'agent_message') ||
      (event.type === 'item.completed' && itemType === 'reasoning')
    ) {
      onProgress?.('agent-generation');
      return;
    }

    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      itemType === 'agent_message'
    ) {
      onProgress?.('response-received');
      const text = event.item?.text;
      if (typeof text === 'string' && text.trim()) {
        lastMessage = text;
      }
    }
  };

  const reader = createJsonLineReader(handleEvent);
  const flush = () => {
    reader.flush();
    return { lastMessage, usage };
  };

  return { flush, push: reader.push };
};

const runCodex = async (
  repoRoot: string,
  prompt: string,
  schema: unknown,
  outputName: string = 'codex-output.json',
  timeoutMessage: string = 'Codex timed out.',
  options: CodexOptions = {},
) => {
  const model = normalizeOpenAIModel(options.model);
  const fallbackModels = getOpenAIModelFallbacks(model, options.fallbackModel);
  const timeoutMs = options.timeoutMs ?? CODEX_TIMEOUT_MS;

  const invokeCodexExec = async (codexModel: string): Promise<string> => {
    const reasoningEffort = getOpenAIModelReasoningEffort(codexModel, options.reasoningEffort);
    const directory = await fs.mkdtemp(join(tmpdir(), 'codophon-codex-'));
    try {
      const outputPath = join(directory, outputName);
      const schemaPath = join(directory, 'schema.json');
      await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');
      const environment = await getCommandEnvironment();
      const commandTransport = resolveAgentCommandTransport(
        options.commandTransport,
        getCodexCommand,
      );
      const codexArgs = [
        'exec',
        '-m',
        codexModel,
        ...(reasoningEffort
          ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
          : []),
        '--cd',
        repoRoot,
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--ignore-rules',
        '--color',
        'never',
        '--json',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '-',
      ];
      const child = commandTransport.spawn(commandTransport.command, codexArgs, {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const eventParser = createCodexEventParser(options.onProgress);
      const stdout = await collectAgentOutput(child, {
        label: 'Codex',
        prompt,
        timeoutMessage,
        timeoutMs,
        onStdout: eventParser.push,
        getLaunchError: getCodexLaunchError,
        getExitError: (rawMessage, signal) =>
          new Error(
            getCodexLaunchErrorMessage({
              message: oneLine(getCodexStructuredErrorMessage(rawMessage) || rawMessage),
              signal,
            }),
          ),
      });
      const { lastMessage, usage } = eventParser.flush();
      options.onMetrics?.({ transport: 'exec', usage });
      return await fs.readFile(outputPath, 'utf8').catch(() => lastMessage || stdout);
    } finally {
      await fs.rm(directory, { force: true, recursive: true }).catch(() => {});
    }
  };

  return withModelFallback(
    model,
    fallbackModels,
    invokeCodexExec,
    isOpenAIModelAvailabilityError,
    options,
    Boolean(options.reasoningEffort?.trim()),
  );
};

export {
  CODEX_NOT_FOUND_CODE,
  CODEX_TIMEOUT_MS,
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  getCodexCommand,
  getCodexInstallPaths,
  isCodexNotFoundError,
  normalizeOpenAIModel,
  OPENAI_MODELS,
  runCodex,
};
