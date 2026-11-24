// @ts-check

const { execFile, spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const { findExecutableOnPath } = require('./agent-shared.cjs');
const { getCommandEnvironment } = require('./login-shell-environment.cjs');
const { getOpenCodeCommand } = require('./opencode.cjs');

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 12_000;
const PROVIDER = 'github-copilot';
const MODEL_CATALOG_TTL_MS = 5 * 60_000;

/**
 * @param {string} command
 * @param {import('node:child_process').SpawnOptions & {cwd: string}} options
 * @returns {Promise<unknown>}
 */
const readCopilotCatalog = (command, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['--acp', '--disable-builtin-mcps', '--disable-client-telemetry'],
      { ...options, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      finish(new Error('Copilot CLI model discovery timed out.'));
    }, TIMEOUT_MS);
    let finished = false;

    /** @param {Error | null} error @param {unknown} [catalog] */
    function finish(error, catalog) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.destroy();
      const settle = () => (error ? reject(error) : resolve(catalog));
      if (child.exitCode !== null || child.signalCode !== null) return settle();
      child.once('close', settle);
      child.kill('SIGKILL');
    }

    /** @param {unknown} message */
    function send(message) {
      if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function disconnected() {
      finish(
        new Error(
          'Could not read models from Copilot CLI. Check that it is up to date and signed in.',
        ),
      );
    }

    lines.on('line', (line) => {
      if (finished) return;
      try {
        const response = JSON.parse(line);
        if (typeof response?.method === 'string' && response.id != null) {
          send({
            error: {
              code: -32601,
              message: 'Model discovery does not handle interactive requests.',
            },
            id: response.id,
            jsonrpc: '2.0',
          });
        } else if (response?.id === 1) {
          if (response.error || response.result?.protocolVersion !== 1) return disconnected();
          send({
            id: 2,
            jsonrpc: '2.0',
            method: 'session/new',
            params: { cwd: options.cwd, mcpServers: [] },
          });
        } else if (response?.id === 2) {
          if (response.error || !Array.isArray(response.result?.models?.availableModels)) {
            return disconnected();
          }
          finish(null, response.result.models.availableModels);
        }
      } catch {
        finish(new Error('Copilot CLI returned an invalid catalog response.'));
      }
    });
    lines.on('error', disconnected);
    child.stdin.on('error', disconnected);
    child.on('error', disconnected);
    child.on('close', () => {
      if (!finished) {
        // On a spawn failure, close can be emitted without an exit code.
        finished = true;
        clearTimeout(timeout);
        lines.close();
        reject(
          new Error(
            'Could not read models from Copilot CLI. Check that it is up to date and signed in.',
          ),
        );
      }
    });
    send({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        clientCapabilities: {},
        clientInfo: { name: 'codiff', version: '1' },
        protocolVersion: 1,
      },
    });
  });

/** @param {unknown} catalog @param {string} supported */
const matchCopilotModels = (catalog, supported) => {
  const providerIds = new Set(supported.split(/\r?\n/).map((line) => line.trim()));
  /** @type {Map<string, { id: string; label: string }>} */
  const models = new Map();
  if (!Array.isArray(catalog)) return [...models.values()];
  for (const model of catalog) {
    if (
      typeof model?.modelId !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]*$/i.test(model.modelId) ||
      (typeof model._meta?.copilotEnablement === 'string' &&
        model._meta.copilotEnablement !== 'enabled')
    )
      continue;
    const id = `${PROVIDER}/${model.modelId}`;
    if (!providerIds.has(id)) continue;
    const label =
      typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.modelId;
    models.set(id, { id, label });
  }
  return [...models.values()];
};

const readOpenCodeCopilotModels = async () => {
  // The Windows Store execution alias need not pass an executable-file probe.
  const copilot = process.platform === 'win32' ? 'copilot.exe' : findExecutableOnPath('copilot');
  if (!copilot)
    throw new Error('Copilot CLI was not found. Install it and sign in to sync models.');
  const opencode = getOpenCodeCommand();
  const env = await getCommandEnvironment();
  const cwd = await mkdtemp(join(tmpdir(), 'codiff-models-'));
  try {
    const [copilotResult, openCodeResult] = await Promise.allSettled([
      readCopilotCatalog(copilot, { cwd, env }),
      execFileAsync(opencode, ['models', PROVIDER], {
        cwd,
        env,
        timeout: TIMEOUT_MS,
        windowsHide: true,
      }),
    ]);
    if (copilotResult.status === 'rejected') throw copilotResult.reason;
    if (openCodeResult.status === 'rejected') {
      throw new Error(
        'Could not read the OpenCode GitHub Copilot provider catalog. Check that OpenCode is up to date and connected to GitHub Copilot.',
      );
    }
    return matchCopilotModels(copilotResult.value, openCodeResult.value.stdout);
  } finally {
    await rm(cwd, { force: true, maxRetries: 3, recursive: true });
  }
};

const createCopilotModelLoader = (readModels = readOpenCodeCopilotModels) => {
  /** @type {{ models: Awaited<ReturnType<typeof readOpenCodeCopilotModels>>, expiresAt: number } | undefined} */
  let cached;
  /** @type {ReturnType<typeof readOpenCodeCopilotModels> | undefined} */
  let pending;
  return (refresh = false) => {
    if (pending) return pending;
    if (!refresh && cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.models);
    }
    cached = undefined;
    pending = readModels()
      .then((models) => {
        cached = { expiresAt: Date.now() + MODEL_CATALOG_TTL_MS, models };
        return models;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
};

module.exports = { createCopilotModelLoader, matchCopilotModels };
