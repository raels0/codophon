import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeEach, expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import {
  CODEX_NOT_FOUND_CODE,
  DEFAULT_OPENAI_MODEL,
  getCodexCommand,
  getCodexInstallPaths,
  normalizeOpenAIModel,
  runCodex,
} from '../codex.ts';
import { createCommandTransport, type FakeCommandProcess } from './helpers/command-transport.ts';

const getArgumentValue = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const completeCodexExec = async (
  commandProcess: FakeCommandProcess,
  output = '{"version":1}',
  stdout = '',
) => {
  const outputPath = getArgumentValue(commandProcess.args, '--output-last-message');
  if (!outputPath) {
    throw new Error('Expected a Codex output path.');
  }
  await writeFile(outputPath, output);
  if (stdout) {
    commandProcess.stdout(stdout);
  }
  commandProcess.close();
};

// Spawning Codex resolves the login shell environment, so tests either
// provide their own fake shell or run without one.
beforeEach(() => {
  const shell = process.env.SHELL;
  delete process.env.SHELL;
  return () => {
    if (shell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = shell;
    }
  };
});

test('uses the default model only for empty or invalid preferences', () => {
  for (const value of [undefined, null, 42, '', '  ']) {
    expect(normalizeOpenAIModel(value)).toBe(DEFAULT_OPENAI_MODEL);
  }
  expect(normalizeOpenAIModel('  gpt-6.1-sol  ')).toBe('gpt-6.1-sol');
});

test('rejects invalid explicit Codex CLI overrides', async () => {
  await using _environment = createTemporaryEnvironment({
    CODOPHON_CODEX_PATH: '/tmp/codophon-missing-codex',
  });

  expect(() => getCodexCommand()).toThrow('CODOPHON_CODEX_PATH');
  try {
    getCodexCommand();
  } catch (error) {
    expect(error).toMatchObject({ code: CODEX_NOT_FOUND_CODE });
  }
});

test.each(['codex', 'codex-cli/bin/codex'])(
  'resolves the ChatGPT app CLI at %s without a codex command on PATH',
  async (entryPoint) => {
    await using directory = await createTemporaryDirectory('codophon-chatgpt-cli-');
    const bundledCLI = join(
      directory.path,
      'Applications/ChatGPT.app/Contents/Resources',
      entryPoint,
    );
    await mkdir(dirname(bundledCLI), { recursive: true });
    await writeFile(bundledCLI, '#!/bin/sh\n');
    await chmod(bundledCLI, 0o755);
    await using _environment = createTemporaryEnvironment({
      CODOPHON_CODEX_PATH: undefined,
      PATH: directory.path,
    });

    // Keep the test hermetic when a real CLI is installed in /Applications.
    const macOSInstallPaths = getCodexInstallPaths('darwin', directory.path);
    expect(macOSInstallPaths).toContain(
      join('/Applications/ChatGPT.app/Contents/Resources', entryPoint),
    );
    const installPaths = macOSInstallPaths.filter((path: string) =>
      path.startsWith(directory.path),
    );
    expect(getCodexCommand(installPaths)).toBe(bundledCLI);
  },
);

test.skipIf(process.platform !== 'darwin')(
  'explains macOS Codex CLI security blocks through runCodex',
  async () => {
    const { transport } = createCommandTransport(({ close, stderr, stdin }) => {
      stdin.on('finish', () => {
        stderr('"codex" was not opened because it contains malware.');
        close(1);
      });
    });

    await expect(
      runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
        commandTransport: transport,
      }),
    ).rejects.toThrow('Update Codex CLI');
  },
);

test('runs Codex walkthroughs as fresh ephemeral repository-scoped calls', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
    }),
  ).resolves.toBe('{"version":1}');

  expect(calls[0].args).toContain('--ephemeral');
  expect(calls[0].args).toContain('--json');
  expect(calls[0].args).toContain('--cd');
  expect(calls[0].args).toContain('/repo');
  expect(calls[0].args).toContain('model_reasoning_effort="low"');
  expect(calls[0].args).not.toContain('resume');
});

test.each(['high', 'ultra'])(
  'passes a custom Codex model with explicit %s effort to exec',
  async (effort) => {
    const { calls, transport } = createCommandTransport((commandProcess) => {
      commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
    });
    await expect(
      runCodex('/repo', 'prompt', {}, undefined, undefined, {
        commandTransport: transport,
        model: 'gpt-6.1-sol',
        reasoningEffort: effort,
      }),
    ).resolves.toBe('{"version":1}');
    expect(getArgumentValue(calls[0].args, '-m')).toBe('gpt-6.1-sol');
    expect(getArgumentValue(calls[0].args, '-c')).toBe(`model_reasoning_effort="${effort}"`);
  },
);

test('inherits Codex effort for custom models when no override is configured', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });
  await runCodex('/repo', 'prompt', {}, undefined, undefined, {
    commandTransport: transport,
    model: 'future-codex-model',
  });
  expect(getArgumentValue(calls[0].args, '-m')).toBe('future-codex-model');
  expect(calls[0].args).not.toContain('-c');
});

test('keeps an explicit effort override when an unavailable model falls back', async () => {
  const attempts: string[] = [];
  const { transport } = createCommandTransport((process) => {
    process.stdin.on('finish', () => {
      const model = getArgumentValue(process.args, '-m');
      attempts.push(`${model}|${getArgumentValue(process.args, '-c')}`);
      if (model === 'gpt-6.1-sol') {
        process.stderr('You do not have access to model gpt-6.1-sol.');
        process.close(1);
      } else void completeCodexExec(process);
    });
  });
  await expect(
    runCodex('/repo', 'prompt', {}, undefined, undefined, {
      commandTransport: transport,
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    }),
  ).resolves.toBe('{"version":1}');
  expect(attempts).toEqual([
    'gpt-6.1-sol|model_reasoning_effort="high"',
    'gpt-5.6-terra|model_reasoning_effort="high"',
  ]);
});

test.each([
  'The model does not support the requested reasoning effort.',
  'model_reasoning_effort is not supported.',
  'Unsupported reasoning effort: HTTP 404.',
])('reports unsupported effort without retrying another model: %s', async (message) => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => {
      commandProcess.stderr(message);
      commandProcess.close(1);
    });
  });
  await expect(
    runCodex('/repo', 'prompt', {}, undefined, undefined, {
      commandTransport: transport,
      model: 'gpt-6.1-sol',
      reasoningEffort: 'unsupported-effort',
    }),
  ).rejects.toThrow(message);
  expect(calls).toHaveLength(1);
});

test('reports the unavailable selected model and a fallback effort error together', async () => {
  const attempts: string[] = [];
  const { transport } = createCommandTransport((process) => {
    process.stdin.on('finish', () => {
      const model = getArgumentValue(process.args, '-m') || '';
      attempts.push(model);
      process.stderr(
        model === 'gpt-5.6-terra'
          ? 'You do not have access to model gpt-5.6-terra.'
          : 'Model gpt-5.5 does not support reasoning effort ultra.',
      );
      process.close(1);
    });
  });
  await expect(
    runCodex('/repo', 'prompt', {}, undefined, undefined, {
      commandTransport: transport,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
    }),
  ).rejects.toThrow(
    'Codex model gpt-5.6-terra was unavailable: You do not have access to model gpt-5.6-terra. Fallback model gpt-5.5 failed: Model gpt-5.5 does not support reasoning effort ultra.',
  );
  expect(attempts).toEqual(['gpt-5.6-terra', 'gpt-5.5']);
});

test('retries unavailable GPT-5.6 models with model-specific reasoning', async () => {
  const attempts: Array<string> = [];
  const { transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => {
      const model = getArgumentValue(commandProcess.args, '-m') || '';
      const effort = getArgumentValue(commandProcess.args, '-c') || '';
      attempts.push(`${model}|${effort}`);
      if (model !== 'gpt-5.5') {
        commandProcess.stderr(`You do not have access to model ${model}.`);
        commandProcess.close(1);
      } else {
        void completeCodexExec(commandProcess);
      }
    });
  });
  const fallbacks: Array<[string, string]> = [];

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      model: 'gpt-5.6-sol',
      onModelFallback: (fallbackModel, originalModel) => {
        fallbacks.push([fallbackModel, originalModel]);
      },
    }),
  ).resolves.toBe('{"version":1}');

  expect(attempts).toEqual([
    'gpt-5.6-sol|model_reasoning_effort="medium"',
    'gpt-5.6-terra|model_reasoning_effort="low"',
    'gpt-5.5|model_reasoning_effort="low"',
  ]);
  expect(fallbacks).toEqual([['gpt-5.5', 'gpt-5.6-sol']]);
});

test.each([
  'You do not have access to model gpt-6-sol.',
  'HTTP 403 Forbidden',
  'HTTP 404 Not Found',
])('retries unavailable GPT-6 models with Terra before GPT-5.5: %s', async (message) => {
  const attempts: Array<string> = [];
  const { transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => {
      const model = getArgumentValue(commandProcess.args, '-m') || '';
      attempts.push(model);
      if (model === 'gpt-6-sol') {
        commandProcess.stderr(message);
        commandProcess.close(1);
      } else {
        void completeCodexExec(commandProcess);
      }
    });
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      model: 'gpt-6-sol',
    }),
  ).resolves.toBe('{"version":1}');

  expect(attempts).toEqual(['gpt-6-sol', 'gpt-5.6-terra']);
});

test('reports Codex exec token usage for eval instrumentation', async () => {
  const { transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on(
      'finish',
      () =>
        void completeCodexExec(
          commandProcess,
          '{"version":1}',
          `${JSON.stringify({
            type: 'turn.completed',
            usage: {
              cached_input_tokens: 80,
              input_tokens: 100,
              output_tokens: 25,
              reasoning_output_tokens: 10,
            },
          })}\n`,
        ),
    );
  });
  const metrics: Array<any> = [];

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      onMetrics: (value) => metrics.push(value),
    }),
  ).resolves.toBe('{"version":1}');

  expect(metrics).toEqual([
    {
      transport: 'exec',
      usage: {
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125,
      },
    },
  ]);
});

test('reports walkthrough progress from codex exec events', async () => {
  const events = [
    { thread_id: 't1', type: 'thread.started' },
    { item: { type: 'reasoning' }, type: 'item.completed' },
    { item: { text: '{"version":1}', type: 'agent_message' }, type: 'item.completed' },
  ];
  const { transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on(
      'finish',
      () =>
        void completeCodexExec(
          commandProcess,
          '{"version":1}',
          events.map((event) => `${JSON.stringify(event)}\n`).join(''),
        ),
    );
  });
  const phases: Array<string> = [];

  await runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
    commandTransport: transport,
    onProgress: (phase) => phases.push(phase),
  });

  expect(phases).toEqual(['agent-generation', 'agent-generation', 'response-received']);
});

test('forwards per-call Codex reasoning effort overrides', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      reasoningEffort: 'low',
    }),
  ).resolves.toBe('{"version":1}');

  expect(calls[0].args).toContain('model_reasoning_effort="low"');
});

test('supports per-call Codex timeouts', async () => {
  const { transport } = createCommandTransport(() => {});
  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      timeoutMs: 10,
    }),
  ).rejects.toThrow('Timed out.');
});

test('surfaces structured Codex CLI errors without the full prompt stream', async () => {
  const { transport } = createCommandTransport(({ close, stderr, stdin, stdout }) => {
    stdin.on('finish', () => {
      stdout('user very long prompt that should not be shown\n');
      stderr('ERROR: {"type":"error","error":{"message":"Invalid schema for response_format."}}\n');
      close(1);
    });
  });

  let message = '';
  try {
    await runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('Invalid schema for response_format.');
  expect(message).not.toContain('very long prompt');
});

test('authenticates Codex from the login shell environment when the app inherited none', async () => {
  await using directory = await createTemporaryDirectory('codophon-codex-login-env-');
  const fakeShell = join(directory.path, 'fake-login-shell');
  // A GUI-launched Codophon keeps launchd's minimal environment: no
  // OPENAI_API_KEY, even when the user's login shell exports one, so Codex must
  // receive the login shell variables.
  await writeFile(
    fakeShell,
    `#!/bin/sh
OPENAI_API_KEY='from-login-shell' exec /bin/sh -c "$4"
`,
  );
  await chmod(fakeShell, 0o755);
  await using _environment = createTemporaryEnvironment({
    OPENAI_API_KEY: undefined,
    SHELL: fakeShell,
  });
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      onProgress: () => {},
    }),
  ).resolves.toBe('{"version":1}');

  expect(calls).toHaveLength(1);
  expect(calls[0].options.env?.OPENAI_API_KEY).toBe('from-login-shell');
});
