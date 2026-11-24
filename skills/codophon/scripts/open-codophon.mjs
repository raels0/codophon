#!/usr/bin/env node

// Launcher for the Codophon `codophon` skill, shared by Claude Code, Codex and OpenCode.
// The agent has already authored a narrative walkthrough JSON file; this opens Codophon
// pointed at it and links the agent's session so follow-up questions reuse the
// conversation.
//
// Usage:
//   node scripts/open-codophon.mjs [--agent claude|codex|opencode] --file <path> [target]
//   node scripts/open-codophon.mjs --guide
//
// `--file <path>` is forwarded to Codophon as `--walkthrough-file`. Any non-flag target
// (commit, HEAD, PR number, or repository path) is forwarded verbatim; when no repository
// path is given the session's working directory is used.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

// The skill directory is symlinked from the app, so this resolves inside the app bundle.
const skillRoot = resolve(import.meta.dirname, '..');
const codophonRoot = resolve(skillRoot, '../..');
const maxSessionScanFiles = 20_000;
const maxSessionReadBytes = 16 * 1024 * 1024;

/** Find the newest JSONL transcript under `root` whose path `matches`. */
const findSessionFile = (root, matches) => {
  if (!existsSync(root)) {
    return null;
  }
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0 && scanned < maxSessionScanFiles) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        b.name.localeCompare(a.name),
      );
    } catch {
      continue;
    }
    const directories = [];
    for (const entry of entries) {
      scanned += 1;
      const path = join(directory, entry.name);
      if (entry.isFile() && path.endsWith('.jsonl') && matches(path.toLowerCase())) {
        return path;
      }
      if (entry.isDirectory()) {
        directories.push(path);
      }
    }
    stack.push(...directories.reverse());
  }
  return null;
};

/** Read up to the last 16 MB of a transcript, starting at a line boundary. */
const readTail = (path) => {
  let file;
  try {
    file = openSync(path, 'r');
    const size = fstatSync(file).size;
    const length = Math.min(size, maxSessionReadBytes);
    const offset = size - length;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(file, buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    const text = buffer.toString('utf8', 0, bytesRead);
    if (offset === 0) {
      return text;
    }
    const firstCompleteLine = text.indexOf('\n');
    return firstCompleteLine === -1 ? '' : text.slice(firstCompleteLine + 1);
  } catch {
    return '';
  } finally {
    if (file != null) {
      try {
        closeSync(file);
      } catch {
        // Best-effort cleanup in the short-lived launcher process.
      }
    }
  }
};

/** The last working directory recorded in a JSONL transcript. */
const readTranscriptCwd = (path, readRecordCwd) => {
  let cwd = null;
  for (const line of readTail(path).split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      cwd = readRecordCwd(JSON.parse(line)) || cwd;
    } catch {
      // Ignore future-format or malformed session records.
    }
  }
  return cwd;
};

const isWithin = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

/**
 * What differs between agents: where the skill is installed, and how to find the current
 * session and where it ran.
 * Everything else about launching Codophon is shared.
 */
const AGENTS = {
  claude: {
    installPath: `${sep}.claude${sep}`,
    session(cwd) {
      const id = process.env.CLAUDE_SESSION_ID || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return { cwd, id: '' };
      }
      const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
      const file = findSessionFile(join(home, 'projects'), (path) =>
        path.endsWith(`${id.toLowerCase()}.jsonl`),
      );
      const sessionCwd =
        process.env.CLAUDE_SESSION_CWD ||
        (file && readTranscriptCwd(file, (record) => record?.cwd));
      return { cwd: sessionCwd || cwd, id };
    },
    sessionVariable: 'CLAUDE_SESSION_ID',
  },
  codex: {
    installPath: `${sep}.codex${sep}`,
    session(cwd) {
      const id = process.env.CODEX_THREAD_ID || '';
      if (!id) {
        return { cwd, id: '' };
      }
      const home = process.env.CODEX_HOME || join(homedir(), '.codex');
      const file = findSessionFile(join(home, 'sessions'), (path) =>
        path.includes(id.toLowerCase()),
      );
      const sessionCwd =
        process.env.CODEX_SESSION_CWD ||
        (file &&
          readTranscriptCwd(file, (record) =>
            record?.type === 'turn_context' ? record.payload?.cwd || record.cwd : null,
          ));
      return { cwd: sessionCwd || cwd, id };
    },
    sessionVariable: 'CODEX_THREAD_ID',
  },
  opencode: {
    installPath: `${sep}opencode${sep}`,
    session(cwd) {
      const pattern = /^ses_[a-z0-9]{8,}$/i;
      const fromEnvironment = process.env.OPENCODE_SESSION_ID || '';
      if (pattern.test(fromEnvironment)) {
        return { cwd, id: fromEnvironment };
      }
      // OpenCode doesn't export the session id; link the newest session for this project.
      const commands = [
        process.env.CODOPHON_OPENCODE_PATH?.trim(),
        'opencode',
        join(homedir(), '.opencode/bin/opencode'),
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode',
      ].filter(Boolean);
      let result = null;
      for (const command of commands) {
        result = spawnSync(
          command,
          ['session', 'list', '--format', 'json', '--max-count', '20', '--pure'],
          { cwd, encoding: 'utf8', timeout: 5000 },
        );
        if (result.error?.code !== 'ENOENT') {
          break;
        }
      }
      try {
        const sessions = result?.status === 0 ? JSON.parse(result.stdout) : [];
        const session = (Array.isArray(sessions) ? sessions : []).find(
          (candidate) =>
            typeof candidate?.id === 'string' &&
            pattern.test(candidate.id) &&
            typeof candidate.directory === 'string' &&
            isWithin(candidate.directory, cwd),
        );
        return { cwd, id: session?.id || '' };
      } catch {
        return { cwd, id: '' };
      }
    },
    sessionVariable: 'OPENCODE_SESSION_ID',
  },
};

const getCodophonCommand = () => {
  if (process.env.CODOPHON_COMMAND) {
    return { args: [], command: process.env.CODOPHON_COMMAND };
  }

  const appCli = join(codophonRoot, 'bin/codophon-app');
  if (
    process.platform === 'darwin' &&
    codophonRoot.includes('.app/Contents/Resources/app') &&
    existsSync(appCli)
  ) {
    return { args: [], command: appCli };
  }

  const devCli = join(codophonRoot, 'bin/codophon.js');
  if (existsSync(devCli)) {
    return { args: [devCli], command: process.execPath };
  }

  if (process.platform === 'darwin' && existsSync(appCli)) {
    return { args: [], command: appCli };
  }

  return { args: [], command: 'codophon' };
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
};

const rawArgs = process.argv.slice(2);

// `--guide`: print Codophon's current walkthrough authoring guide and exit. The
// guidance lives in Codophon (not this skill), so it stays current across updates.
if (rawArgs.includes('--guide')) {
  const codophon = getCodophonCommand();
  run(codophon.command, [...codophon.args, '--walkthrough-guide']);
}

const forwardedArgs = [];
let walkthroughFile = '';
let agentName = '';
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === '--file' || arg === '--agent') {
    const value = rawArgs[index + 1] || '';
    index += 1;
    if (arg === '--file') {
      walkthroughFile = value;
    } else {
      agentName = value;
    }
    continue;
  }
  if (arg.startsWith('--file=')) {
    walkthroughFile = arg.slice('--file='.length);
    continue;
  }
  if (arg.startsWith('--agent=')) {
    agentName = arg.slice('--agent='.length);
    continue;
  }
  forwardedArgs.push(arg);
}

if (agentName && !Object.hasOwn(AGENTS, agentName)) {
  process.stderr.write(
    `open-codophon: unknown agent "${agentName}". Use claude, codex, or opencode.\n`,
  );
  process.exit(1);
}
// Each agent invokes the skill through its own symlinked install path, which identifies it more
// reliably than environment variables that leak into nested terminals.
const invokedPath = resolve(process.argv[1] || '');
agentName ||=
  Object.keys(AGENTS).find((name) => invokedPath.includes(AGENTS[name].installPath)) ||
  Object.keys(AGENTS).find((name) => process.env[AGENTS[name].sessionVariable]) ||
  '';

if (!walkthroughFile) {
  process.stderr.write('open-codophon: missing --file <path> to the walkthrough JSON.\n');
  process.exit(1);
}

const fallbackCwd =
  process.cwd() === skillRoot || process.cwd().startsWith(`${skillRoot}${sep}`)
    ? codophonRoot
    : process.cwd();
const session = agentName ? AGENTS[agentName].session(fallbackCwd) : { cwd: fallbackCwd, id: '' };

const walkthroughFilePath = resolve(session.cwd, walkthroughFile);
if (!existsSync(walkthroughFilePath)) {
  process.stderr.write(`open-codophon: walkthrough file not found at ${walkthroughFilePath}.\n`);
  process.exit(1);
}

const hasRepositoryTarget = forwardedArgs.some(
  (arg) => !arg.startsWith('-') && existsSync(resolve(session.cwd, arg)),
);

const codophon = getCodophonCommand();
run(codophon.command, [
  ...codophon.args,
  '-w',
  ...(agentName ? ['--agent', agentName] : []),
  '--walkthrough-file',
  walkthroughFilePath,
  ...(session.id ? [`--${agentName}-session`, session.id] : []),
  ...forwardedArgs,
  ...(hasRepositoryTarget ? [] : [session.cwd]),
]);
