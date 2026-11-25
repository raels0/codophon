import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  collectAgentOutput,
  missingAgentError,
  withModelFallback,
  findAgentCommand,
  resolveAgentCommandTransport,
} from './agent-command.ts';
import { buildSchemaReminder, normalizeStructuredOutput, oneLine } from './agent-shared.ts';
import type { AgentOptions } from './agent.ts';
import { getCommandEnvironment } from './login-shell-environment.ts';

const OPENCODE_TIMEOUT_MS = 300_000;
const DEFAULT_OPENCODE_MODEL = 'opencode-default';
const FALLBACK_OPENCODE_MODEL = DEFAULT_OPENCODE_MODEL;
const OPENCODE_COMMAND_MODEL_PLACEHOLDER = '{{CODOPHON_OPENCODE_MODEL}}';
const OPENCODE_NOT_FOUND_CODE = 'OPENCODE_NOT_FOUND';
const OPENCODE_STREAMING_UNAVAILABLE_CODE = 'OPENCODE_STREAMING_UNAVAILABLE';
const OPENCODE_NOT_FOUND_MESSAGE =
  'OpenCode CLI was not found. Install OpenCode and verify `opencode --version` works in Terminal. Codophon searches PATH, ~/.opencode/bin/opencode, /opt/homebrew/bin/opencode, and /usr/local/bin/opencode. If OpenCode is installed somewhere else, launch Codophon with `CODOPHON_OPENCODE_PATH=/absolute/path/to/opencode codophon -w`.';

const OPENCODE_MODELS: ReadonlyArray<{ id: string; label: string }> = Object.freeze([
  { id: DEFAULT_OPENCODE_MODEL, label: 'OpenCode configured default' },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
]);
const OPENCODE_MODEL_PATTERN = /^[a-z0-9][a-z0-9._:-]*(?:\/[@a-z0-9][@a-z0-9._:-]*)+$/i;

const { create: createOpenCodeNotFoundError, matches: isOpenCodeNotFoundError } = missingAgentError(
  OPENCODE_NOT_FOUND_CODE,
  OPENCODE_NOT_FOUND_MESSAGE,
);

const getOpenCodeCommand = () =>
  findAgentCommand(
    'opencode',
    'CODOPHON_OPENCODE_PATH',
    [
      join(homedir(), '.opencode/bin/opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
    ],
    createOpenCodeNotFoundError,
  );

const getOpenCodeLaunchError = (error: unknown) => {
  if (isOpenCodeNotFoundError(error)) {
    return createOpenCodeNotFoundError();
  }

  return error instanceof Error ? error : new Error(String(error ?? ''));
};

const isOpenCodeStreamingUnavailableError = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === OPENCODE_STREAMING_UNAVAILABLE_CODE,
  );

const createOpenCodeStreamingUnavailableError = (error: unknown) =>
  Object.assign(getOpenCodeLaunchError(error), { code: OPENCODE_STREAMING_UNAVAILABLE_CODE });

const normalizeOpenCodeModel = (value: unknown): string => {
  const model = typeof value === 'string' ? value.trim() : '';
  return model === DEFAULT_OPENCODE_MODEL || OPENCODE_MODEL_PATTERN.test(model)
    ? model
    : DEFAULT_OPENCODE_MODEL;
};

const isOpenCodeModelAvailabilityError = (value: unknown) =>
  /\b(?:ProviderModelNotFoundError|model[_ ]not[_ ]found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model)\b/i.test(
    String(value ?? ''),
  ) ||
  /(?:\bmodel\b.{0,80}\b(?:403|404)\b|\b(?:403|404)\b.{0,80}\bmodel\b)/i.test(String(value ?? ''));

const renderOpenCodeCommand = (template: string, model: unknown) => {
  const placeholderCount = template.split(OPENCODE_COMMAND_MODEL_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `The OpenCode command template must contain exactly one ${OPENCODE_COMMAND_MODEL_PLACEHOLDER} placeholder.`,
    );
  }

  const normalizedModel = normalizeOpenCodeModel(model);
  const modelLine = normalizedModel === DEFAULT_OPENCODE_MODEL ? '' : `model: ${normalizedModel}`;
  return template.replace(OPENCODE_COMMAND_MODEL_PLACEHOLDER, modelLine);
};

const readOpenCodeText = (output: string): string => {
  const parts: Map<string, string> = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const part = event?.type === 'text' ? event.part : null;
      if (part && typeof part.text === 'string') {
        parts.set(typeof part.id === 'string' ? part.id : String(parts.size), part.text);
      }
    } catch {
      // Keep compatibility with older OpenCode versions that may emit plain text.
    }
  }
  return parts.size > 0 ? [...parts.values()].join('\n') : output;
};

const normalizeOpenCodeOutput = (output: string, schema: unknown): string =>
  normalizeStructuredOutput(readOpenCodeText(output), schema, 'OpenCode');

const reserveOpenCodePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port == null) {
          reject(new Error('OpenCode could not reserve a local server port.'));
        } else {
          resolve(port);
        }
      });
    });
  });

const readOpenCodeServerText = (output: string) => {
  try {
    const response = JSON.parse(output);
    if (response?.info?.error) {
      throw new Error(
        oneLine(
          response.info.error?.data?.message || response.info.error?.name,
          'OpenCode reported an error.',
        ),
      );
    }
    const parts = Array.isArray(response?.parts) ? response.parts : [];
    const text = parts
      .filter(
        (part: { type: string; text: any }) =>
          part?.type === 'text' && typeof part.text === 'string',
      )
      .map((part: { text: any }) => part.text)
      .join('\n');
    return text;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return output;
    }
    throw error;
  }
};

const handleOpenCodeProgressEvent = (
  input: unknown,
  sessionId: string,
  onProgress: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void,
  state: { assistantMessageIds: Set<string>; textParts: Map<string, string> },
) => {
  const event = (input as any)?.payload || input;
  const properties = event?.properties;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.type !== 'string' ||
    properties?.sessionID !== sessionId
  ) {
    return;
  }

  if (event.type === 'message.updated' && properties.info?.role === 'assistant') {
    state.assistantMessageIds.add(properties.info.id);
    return;
  }

  const messageId =
    properties.assistantMessageID || properties.messageID || properties.part?.messageID;
  const isAssistantMessage =
    event.type.startsWith('session.next.') || state.assistantMessageIds.has(messageId);
  if (!isAssistantMessage) {
    return;
  }

  if (
    event.type.startsWith('session.next.reasoning.') ||
    (event.type === 'message.part.updated' &&
      ['reasoning', 'step-start'].includes(properties.part?.type))
  ) {
    onProgress('agent-generation');
    return;
  }

  if (
    event.type === 'session.next.text.started' ||
    event.type === 'session.next.text.delta' ||
    (event.type === 'message.part.updated' && properties.part?.type === 'text')
  ) {
    onProgress('response-received');
  }

  if (
    event.type === 'message.part.delta' &&
    properties.field === 'text' &&
    typeof properties.delta === 'string'
  ) {
    const partId = String(properties.partID || state.textParts.size);
    state.textParts.set(partId, `${state.textParts.get(partId) || ''}${properties.delta}`);
    onProgress('response-received');
  }
};

const consumeOpenCodeEventStream = async (
  response: Response,
  sessionId: string,
  onProgress: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void,
  state: { assistantMessageIds: Set<string>; textParts: Map<string, string> },
) => {
  if (!response.body) {
    throw createOpenCodeStreamingUnavailableError(
      new Error('OpenCode did not provide an event stream.'),
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.search(/\r?\n\r?\n/);
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      const separator = buffer.slice(frameEnd).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
      buffer = buffer.slice(frameEnd + separator.length);
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data) {
          continue;
        }
        try {
          handleOpenCodeProgressEvent(JSON.parse(data), sessionId, onProgress, state);
        } catch {
          // Ignore malformed diagnostics without exposing them to the renderer.
        }
      }
      frameEnd = buffer.search(/\r?\n\r?\n/);
    }
  }
};

const getOpenCodeServerModel = (model: string) => {
  if (model === DEFAULT_OPENCODE_MODEL) {
    return undefined;
  }
  const [providerID, ...modelParts] = model.split('/');
  return { modelID: modelParts.join('/'), providerID };
};

const runOpenCode = async (
  repoRoot: string,
  prompt: string,
  schema: unknown,
  _outputName: string = 'opencode-output.json',
  timeoutMessage: string = 'OpenCode timed out.',
  options: AgentOptions & {
    commandTransport?: import('./agent-command.ts').AgentCommandTransport;
  } = {},
) => {
  const model = normalizeOpenCodeModel(options.model);
  const fallbackModel = normalizeOpenCodeModel(options.fallbackModel || FALLBACK_OPENCODE_MODEL);
  const timeoutMs = options.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  const effectivePrompt = `${prompt}${buildSchemaReminder(schema)}`;

  const invokeOpenCodeCli = async (openCodeModel: string) => {
    const environment = await getCommandEnvironment();
    const commandTransport = resolveAgentCommandTransport(
      options.commandTransport,
      getOpenCodeCommand,
    );
    const opencodeArgs = [
      'run',
      '--format',
      'json',
      '--pure',
      '--agent',
      'build',
      '--dir',
      repoRoot,
      ...(openCodeModel === DEFAULT_OPENCODE_MODEL ? [] : ['--model', openCodeModel]),
    ];
    const child = commandTransport.spawn(commandTransport.command, opencodeArgs, {
      cwd: repoRoot,
      env: {
        ...environment,
        OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = await collectAgentOutput(child, {
      label: 'OpenCode',
      getLaunchError: getOpenCodeLaunchError,
      prompt: effectivePrompt,
      timeoutMessage,
      timeoutMs,
    });
    return normalizeOpenCodeOutput(stdout, schema);
  };

  const invokeOpenCodeServer = async (openCodeModel: string) => {
    const commandTransport = resolveAgentCommandTransport(
      options.commandTransport,
      getOpenCodeCommand,
    );
    const port = await reserveOpenCodePort();
    const environment = await getCommandEnvironment();
    const child = commandTransport.spawn(
      commandTransport.command,
      ['serve', '--pure', '--hostname=127.0.0.1', `--port=${port}`],
      {
        cwd: repoRoot,
        env: {
          ...environment,
          OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const abortController = new AbortController();
    let baseUrl = '';
    let sessionId = '';
    let startupOutput = '';
    let timeout: string | number | NodeJS.Timeout | undefined;

    try {
      baseUrl = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (
          callback: {
            (reason?: any): void;
            (value: string | PromiseLike<string>): void;
            (reason?: any): void;
            (reason?: any): void;
            (arg0: any): void;
          },
          value: string | (Error & { code: string }),
        ) => {
          if (settled) {
            return;
          }
          settled = true;
          callback(value);
        };
        timeout = setTimeout(
          () => {
            finish(
              reject,
              createOpenCodeStreamingUnavailableError(
                new Error('Timed out waiting for the OpenCode event server to start.'),
              ),
            );
          },
          Math.min(timeoutMs, 5_000),
        );
        child.stdout.on('data', (chunk) => {
          startupOutput += chunk.toString();
          for (const line of startupOutput.split(/\r?\n/)) {
            const match = line.match(/opencode server listening.*\bon\s+(https?:\/\/\S+)/);
            if (match) {
              clearTimeout(timeout);
              finish(resolve, match[1]);
              return;
            }
          }
        });
        child.stderr.on('data', (chunk) => {
          startupOutput += chunk.toString();
        });
        child.on('error', (error) => {
          clearTimeout(timeout);
          finish(reject, createOpenCodeStreamingUnavailableError(error));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          finish(
            reject,
            createOpenCodeStreamingUnavailableError(
              new Error(
                oneLine(
                  startupOutput,
                  signal
                    ? `OpenCode event server was terminated by ${signal}.`
                    : `OpenCode event server exited with code ${code}.`,
                ),
              ),
            ),
          );
        });
      });

      timeout = setTimeout(() => abortController.abort(new Error(timeoutMessage)), timeoutMs);
      const directory = new URLSearchParams({ directory: repoRoot });
      const request = async (path: string, init: RequestInit | undefined) => {
        try {
          return await fetch(`${baseUrl}${path}?${directory}`, {
            ...init,
            signal: abortController.signal,
          });
        } catch (error) {
          if (abortController.signal.aborted) {
            throw abortController.signal.reason;
          }
          throw createOpenCodeStreamingUnavailableError(error);
        }
      };
      const sessionResponse = await request('/session', {
        body: JSON.stringify({
          agent: 'build',
          permission: [{ action: 'deny', pattern: '*', permission: '*' }],
          title: 'Codophon walkthrough',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!sessionResponse.ok) {
        throw createOpenCodeStreamingUnavailableError(
          new Error(
            oneLine(
              await sessionResponse.text(),
              `OpenCode session creation failed with status ${sessionResponse.status}.`,
            ),
          ),
        );
      }
      const session = await sessionResponse.json();
      sessionId = typeof session?.id === 'string' ? session.id : '';
      if (!sessionId) {
        throw createOpenCodeStreamingUnavailableError(
          new Error('OpenCode session creation did not return a session ID.'),
        );
      }

      const eventResponse = await request('/event', {
        headers: { accept: 'text/event-stream' },
      });
      if (
        !eventResponse.ok ||
        !eventResponse.headers.get('content-type')?.includes('text/event-stream')
      ) {
        throw createOpenCodeStreamingUnavailableError(
          new Error(`OpenCode event streaming is unavailable (${eventResponse.status}).`),
        );
      }
      const progressState = {
        assistantMessageIds: new Set<string>(),
        textParts: new Map<string, string>(),
      };
      const eventStream = consumeOpenCodeEventStream(
        eventResponse,
        sessionId,
        options.onProgress ?? (() => {}),
        progressState,
      ).catch(() => {});

      const model = getOpenCodeServerModel(openCodeModel);
      const promptResponse = await request(`/session/${encodeURIComponent(sessionId)}/message`, {
        body: JSON.stringify({
          agent: 'build',
          ...(model ? { model } : {}),
          parts: [{ text: effectivePrompt, type: 'text' }],
          tools: {},
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const responseText = await promptResponse.text();
      if (!promptResponse.ok) {
        if ([404, 405].includes(promptResponse.status)) {
          throw createOpenCodeStreamingUnavailableError(
            new Error(`OpenCode streaming prompt is unavailable (${promptResponse.status}).`),
          );
        }
        throw new Error(
          oneLine(responseText, `OpenCode request failed with status ${promptResponse.status}.`),
        );
      }

      const output = readOpenCodeServerText(responseText);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const streamedText = [...progressState.textParts.values()].join('\n');
      abortController.abort();
      await eventStream;
      return normalizeStructuredOutput(output || streamedText, schema, 'OpenCode');
    } finally {
      clearTimeout(timeout);
      if (baseUrl && sessionId) {
        await fetch(
          `${baseUrl}/session/${encodeURIComponent(sessionId)}?${new URLSearchParams({
            directory: repoRoot,
          })}`,
          { method: 'DELETE', signal: AbortSignal.timeout(500) },
        ).catch(() => {});
      }
      abortController.abort();
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  };

  const invokeOpenCode = async (openCodeModel: string) => {
    if (!options.onProgress) {
      return invokeOpenCodeCli(openCodeModel);
    }
    try {
      return await invokeOpenCodeServer(openCodeModel);
    } catch (error) {
      if (!isOpenCodeStreamingUnavailableError(error)) {
        throw error;
      }
      return invokeOpenCodeCli(openCodeModel);
    }
  };

  return withModelFallback(
    model,
    [fallbackModel],
    invokeOpenCode,
    isOpenCodeModelAvailabilityError,
    options,
  );
};

export {
  DEFAULT_OPENCODE_MODEL,
  FALLBACK_OPENCODE_MODEL,
  OPENCODE_MODELS,
  OPENCODE_NOT_FOUND_CODE,
  OPENCODE_TIMEOUT_MS,
  getOpenCodeCommand,
  isOpenCodeNotFoundError,
  normalizeOpenCodeModel,
  renderOpenCodeCommand,
  runOpenCode,
};
