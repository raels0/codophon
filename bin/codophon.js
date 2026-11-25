#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { formatHelpText, parseArguments, resolvePullRequestTargetUrl } from './arguments.js';
import { completionShells, generateCompletionScript } from './completions.js';
import { waitForWalkthroughResult } from './walkthrough-result.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// The renderer is the built dist/ by default. When Codophon's own Vite dev server
// is running, use it instead so source edits hot-reload without a rebuild. The
// server is VERIFIED to identify as Codophon before it's trusted — 5173 is a
// common dev port, so "something is listening" is never enough on its own.
const DEV_SERVER_URL = process.env.CODOPHON_DEV_SERVER_URL || 'http://127.0.0.1:5173';

const looksLikeCodophon = (body) =>
  body.includes('<title>Codophon</title>') && body.includes('/core/index.tsx');

/** Resolve to the dev-server URL when it is up and serving Codophon, else `null`. */
const detectDevServer = (url) =>
  new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolveProbe(value ? url : null);
      }
    };

    let target;
    try {
      target = new URL(url);
    } catch {
      finish(false);
      return;
    }

    const request = (target.protocol === 'https:' ? https : http).get(target, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(false);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65_536) {
          response.destroy();
        }
      });
      response.on('end', () => finish(looksLikeCodophon(body)));
      response.on('close', () => finish(looksLikeCodophon(body)));
    });
    request.setTimeout(800, () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });

// Assemble the narrative walkthrough authoring guide: the prose, then the live
// schema object serialized inline (single-sourced from the validator — no copy).
const buildWalkthroughGuide = () => {
  const { narrativeWalkthroughSchema } = require('../electron/narrative-walkthrough.ts');
  const guide = readFileSync(resolve(root, 'bin/walkthrough-guide.md'), 'utf8').trimEnd();
  return `${guide}\n\n\`\`\`json\n${JSON.stringify(narrativeWalkthroughSchema, null, 2)}\n\`\`\`\n`;
};

/**
 * Start the app with one encoded launch request. Packaged builds go through the OS so the app
 * activates normally; a source checkout runs Electron against this directory.
 */
const launchApp = async (launchArgument) => {
  // Agent harnesses sometimes export ELECTRON_RUN_AS_NODE, which would make the app binary run as
  // plain Node and crash on boot.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const spawnDetached = (command, args) => {
    const child = spawn(command, args, { detached: true, env, stdio: 'ignore' });
    child.unref();
    return child;
  };

  const appBundle = process.platform === 'darwin' ? root.match(/^(.*\.app)\//)?.[1] : null;
  if (appBundle) {
    return spawnDetached('open', ['-n', appBundle, '--args', launchArgument]);
  }
  // Windows and Linux packages put the executable two levels above resources/app.
  const isPackaged = basename(root) === 'app' && basename(dirname(root)) === 'resources';
  const packagedExecutable = isPackaged
    ? ['codophon.exe', 'codophon'].map((name) => resolve(root, '../..', name)).find(existsSync)
    : null;
  if (packagedExecutable) {
    return spawnDetached(packagedExecutable, [launchArgument]);
  }

  // Prefer an explicit ELECTRON_RENDERER_URL; otherwise auto-use Codophon's dev
  // server when it is actually running and identifies as Codophon.
  env.ELECTRON_RENDERER_URL =
    process.env.ELECTRON_RENDERER_URL || (await detectDevServer(DEV_SERVER_URL)) || '';
  if (!env.ELECTRON_RENDERER_URL && !existsSync(resolve(root, 'dist/index.html'))) {
    console.error('Codophon has not been built yet. Run `pnpm build` first, or start `pnpm dev`.');
    process.exit(1);
  }
  const { default: electron } = await import('electron');
  return spawnDetached(electron, [root, launchArgument]);
};

const run = async () => {
  const parsedArguments = parseArguments(process.argv.slice(2));

  if (parsedArguments.help) {
    process.stdout.write(formatHelpText(packageJson.version));
    return;
  }

  if (parsedArguments.version) {
    process.stdout.write(`codophon v${packageJson.version}\n`);
    return;
  }

  if (parsedArguments.completionShell != null) {
    const shell = parsedArguments.completionShell;
    if (!shell) {
      process.stderr.write(
        `codophon: --completions requires a shell: ${completionShells.join(', ')}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!completionShells.includes(shell)) {
      process.stderr.write(
        `codophon: unsupported shell for --completions: ${shell}. Supported shells: ${completionShells.join(', ')}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(generateCompletionScript(shell));
    return;
  }

  if (parsedArguments.walkthroughGuide) {
    process.stdout.write(buildWalkthroughGuide());
    return;
  }

  const {
    agentBackend,
    branchRef,
    agentSessions,
    commitRef,
    pullRequestBranch,
    pullRequestNumber,
    pullRequestProvider,
    range,
    requestedPath,
    walkthrough,
    walkthroughContextPath,
    walkthroughFilePath,
  } = parsedArguments;
  let { pullRequestUrl } = parsedArguments;

  if (!pullRequestUrl && (pullRequestBranch || pullRequestNumber != null)) {
    try {
      pullRequestUrl = resolvePullRequestTargetUrl({
        branch: pullRequestBranch,
        number: pullRequestNumber,
        provider: pullRequestProvider ?? undefined,
        repositoryPath: requestedPath,
        url: pullRequestUrl,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  const { encodeLaunchRequest } = await import(resolve(root, 'electron/main/launch-request.ts'));
  // The app launches detached, so wait for it to report whether it applied the
  // walkthrough file; otherwise a file it rejects would still exit 0 here.
  const walkthroughResultDirectory = walkthroughFilePath
    ? mkdtempSync(join(tmpdir(), 'codophon-walkthrough-result-'))
    : null;
  const launchArgument = encodeLaunchRequest({
    agentBackend,
    agentSessions,
    repositoryPath: requestedPath,
    source: range
      ? { ...range, type: 'range' }
      : pullRequestUrl
        ? { type: 'pull-request', url: pullRequestUrl }
        : commitRef
          ? { ref: commitRef, type: 'commit' }
          : branchRef
            ? { ref: branchRef, type: 'branch-working-tree' }
            : undefined,
    walkthrough,
    walkthroughContextPath,
    walkthroughFile: walkthroughFilePath,
    walkthroughResultFile: walkthroughResultDirectory
      ? join(walkthroughResultDirectory, 'result.txt')
      : undefined,
  });

  const child = await launchApp(launchArgument);
  if (walkthroughResultDirectory) {
    try {
      const result = await waitForWalkthroughResult(
        join(walkthroughResultDirectory, 'result.txt'),
        child,
      );
      if (result.status === 'unavailable') {
        process.stderr.write(`${result.reason}\n`);
        process.exitCode = 1;
      }
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Codophon could not load the walkthrough.'}\n`,
      );
      process.exitCode = 1;
    } finally {
      rmSync(walkthroughResultDirectory, { force: true, recursive: true });
    }
  }
};

run();
