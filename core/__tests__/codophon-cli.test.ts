import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import {
  formatHelpText,
  parseArguments,
  resolvePullRequestTargetUrl,
  resolvePullRequestUrl,
} from '../../bin/arguments.js';
import { decodeLaunchRequest } from '../../electron/main/launch-request.ts';
import { createFakeCommandLogger } from './helpers/cli.ts';
import { removeGitTestDirectory } from './helpers/git.ts';
import { getGitTestEnvironment } from './helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
  createTemporaryWorkingDirectory,
} from './helpers/resources.ts';

const execFileAsync = promisify(execFile);
const forgeConfig = createRequire(import.meta.url)('../../forge.config.cjs') as {
  hooks: { packageAfterCopy: (config: unknown, buildPath: string) => Promise<void> };
};

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
};

let refRepositoryPath = '';
let refRepositoryShortHash = '';

beforeAll(async () => {
  refRepositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codophon-cli-refs-')));
  await git(refRepositoryPath, ['init']);
  await git(refRepositoryPath, ['commit', '--allow-empty', '-m', 'first']);
  await git(refRepositoryPath, ['branch', 'base']);
  await git(refRepositoryPath, ['commit', '--allow-empty', '-m', 'second']);
  await git(refRepositoryPath, ['branch', 'feature']);
  await git(refRepositoryPath, ['branch', 'feature.v1']);
  const { stdout } = await execFileAsync('git', ['-C', refRepositoryPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  refRepositoryShortHash = stdout.trim().slice(0, 8);
  await git(refRepositoryPath, ['branch', refRepositoryShortHash]);
  await git(refRepositoryPath, ['branch', 'target']);
});

afterAll(async () => {
  if (refRepositoryPath) {
    await removeGitTestDirectory(refRepositoryPath);
  }
});

const withCwd = async <T>(cwd: string, callback: () => T | Promise<T>) => {
  using _workingDirectory = createTemporaryWorkingDirectory(cwd);
  return await callback();
};

const withFakeGitHubCli = async <T>(
  response: Record<string, unknown>,
  callback: (argsPath: string) => T | Promise<T>,
) => {
  await using directory = await createTemporaryDirectory('codophon-cli-gh-');
  const argsPath = join(directory.path, 'args.txt');
  const commandPath = join(directory.path, 'gh');

  await writeFile(
    commandPath,
    '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$CODOPHON_TEST_GH_ARGS"\ndone\nprintf "%s\\n" "$CODOPHON_TEST_GH_RESPONSE"\n',
  );
  await chmod(commandPath, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODOPHON_TEST_GH_ARGS: argsPath,
    CODOPHON_TEST_GH_RESPONSE: JSON.stringify(response),
    PATH: `${directory.path}:${process.env.PATH ?? ''}`,
  });
  return await callback(argsPath);
};

test('parseArguments treats a hash positional as a commit ref', () => {
  const commitRef = 'a1b2c3d4e5f678901234567890abcdef12345678';

  expect(parseArguments(['-w', commitRef])).toEqual({
    commitRef,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: true,
  });
});

test('parseArguments treats HEAD positional revisions as commit refs', () => {
  expect(parseArguments(['HEAD'])).toEqual({
    commitRef: 'HEAD',
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });

  expect(parseArguments(['HEAD^1'])).toEqual({
    commitRef: 'HEAD^1',
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments canonicalizes review URLs copied from a review tab', () => {
  for (const value of [
    'https://github.com/raels0/codophon/pull/1728/changes#r4821',
    'https://github.com/raels0/codophon/pull/1728/files',
    'https://www.github.com/raels0/codophon/pull/1728?diff=split',
    'github.com/raels0/codophon/pull/1728',
  ]) {
    expect(parseArguments([value])).toMatchObject({
      pullRequestUrl: 'https://github.com/raels0/codophon/pull/1728',
    });
  }

  for (const value of [
    'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492?_a=files',
    'dev.azure.com/contoso/Fabrikam/_git/Storefront/pullRequest/492',
  ]) {
    expect(parseArguments([value])).toMatchObject({
      pullRequestUrl: 'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492',
    });
  }
});

test('parseArguments treats plain branch refs as branch refs', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['feature'])).toEqual({
      branchRef: 'feature',
      commitRef: null,
      help: false,
      pullRequestNumber: null,
      pullRequestUrl: null,
      requestedPath: refRepositoryPath,
      version: false,
      walkthrough: false,
    });
  });
});

test('parseArguments treats missing plain refs in Git repositories as branch refs', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['definitely-missing-branch'])).toMatchObject({
      branchRef: 'definitely-missing-branch',
      commitRef: null,
      requestedPath: refRepositoryPath,
    });

    expect(parseArguments(['definitely-missing-branch', refRepositoryPath])).toMatchObject({
      branchRef: 'definitely-missing-branch',
      commitRef: null,
      requestedPath: refRepositoryPath,
    });
  });
});

test('parseArguments treats hex-like refs as commits before branches', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments([refRepositoryShortHash])).toMatchObject({
      commitRef: refRepositoryShortHash,
      requestedPath: refRepositoryPath,
    });

    expect(parseArguments(['--branch', refRepositoryShortHash])).toMatchObject({
      branchRef: refRepositoryShortHash,
      commitRef: null,
      requestedPath: refRepositoryPath,
    });
  });
});

test('parseArguments keeps existing hash-like paths as repository paths', async () => {
  await using directory = await createTemporaryDirectory('codophon-cli-');
  const repositoryPath = join(directory.path, 'deadbeef');

  await mkdir(repositoryPath);

  expect(parseArguments([repositoryPath])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: repositoryPath,
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats PR number shorthands as review sources', () => {
  expect(parseArguments(['#75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats PR marker arguments as review sources', () => {
  expect(parseArguments(['pr', '75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestProvider: 'github',
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats GitHub PR branch markers as review sources', () => {
  expect(
    parseArguments(['pr', 'iminoso:feat/pr-branch-lookup', '/path/to/repository']),
  ).toMatchObject({
    pullRequestBranch: 'iminoso:feat/pr-branch-lookup',
    pullRequestNumber: null,
    pullRequestProvider: 'github',
    requestedPath: '/path/to/repository',
  });
});

test('parseArguments recognizes Codex walkthrough seed options', () => {
  expect(
    parseArguments([
      '-w',
      '--codex-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '--walkthrough-context',
      'seed.json',
    ]),
  ).toEqual({
    agentSessions: [{ agent: 'codex', id: '019e5e57-e7d6-7392-9ad1-ad959319d2fb' }],
    commitRef: null,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: true,
    walkthroughContextPath: resolve('seed.json'),
  });
});

test('parseArguments recognizes a pre-authored walkthrough file', () => {
  expect(parseArguments(['-w', '--walkthrough-file', '.codophon/walkthrough.json'])).toMatchObject({
    walkthrough: true,
    walkthroughFilePath: resolve('.codophon/walkthrough.json'),
  });
});

test('parseArguments recognizes the walkthrough guide flag', () => {
  expect(parseArguments(['--walkthrough-guide'])).toMatchObject({ walkthroughGuide: true });
  expect(parseArguments([])).not.toHaveProperty('walkthroughGuide');
});

test('parseArguments recognizes Claude walkthrough seed options and the agent override', () => {
  expect(
    parseArguments([
      '-w',
      '--agent',
      'claude',
      '--claude-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    ]),
  ).toMatchObject({
    agentBackend: 'claude',
    agentSessions: [{ agent: 'claude', id: '019e5e57-e7d6-7392-9ad1-ad959319d2fb' }],
    walkthrough: true,
  });
});

test('parseArguments recognizes the OpenCode agent override', () => {
  expect(
    parseArguments([
      '-w',
      '--agent',
      'opencode',
      '--opencode-session',
      'ses_121b4816bffebMr9YE52O4870p',
    ]),
  ).toMatchObject({
    agentBackend: 'opencode',
    agentSessions: [{ agent: 'opencode', id: 'ses_121b4816bffebMr9YE52O4870p' }],
    walkthrough: true,
  });
});

test('parseArguments ignores unknown agent backends', () => {
  const result = parseArguments(['--agent', 'gpt']) as { agentBackend?: string };
  expect(result.agentBackend).toBeUndefined();
});

test('parseArguments treats hash-prefixed PR marker values as review sources', () => {
  expect(parseArguments(['pr', '#75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestProvider: 'github',
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats Azure DevOps PR marker values as review sources', () => {
  expect(parseArguments(['ado', '42'])).toMatchObject({
    pullRequestNumber: 42,
    pullRequestProvider: 'azure-devops',
  });
  expect(parseArguments(['azdo', '#42'])).toMatchObject({
    pullRequestNumber: 42,
    pullRequestProvider: 'azure-devops',
  });
});

test('parseArguments accepts Azure DevOps pull request URLs', () => {
  expect(
    parseArguments([
      'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492?_a=files',
    ]),
  ).toMatchObject({
    pullRequestUrl: 'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492',
  });
});

test('resolvePullRequestUrl builds GitHub PR URLs from the origin remote', async () => {
  await using directory = await createTemporaryDirectory('codophon-cli-');
  const repositoryPath = directory.path;

  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['remote', 'add', 'upstream', 'https://github.com/other/repo.git']);
  await git(repositoryPath, ['remote', 'add', 'origin', 'git@github.com:raels0/codophon.git']);

  expect(resolvePullRequestUrl(repositoryPath, 75)).toBe(
    'https://github.com/raels0/codophon/pull/75',
  );
});

test(
  'PR branch lookup preserves the canonical GitHub URL returned by gh',
  { concurrent: false },
  async () => {
    await withFakeGitHubCli(
      {
        state: 'OPEN',
        url: 'https://github.com/raels0/codophon/pull/129',
      },
      async (argsPath) => {
        expect(
          resolvePullRequestTargetUrl({
            branch: 'iminoso:feat/pr-branch-lookup',
            number: null,
            provider: 'github',
            repositoryPath: process.cwd(),
            url: null,
          }),
        ).toBe('https://github.com/raels0/codophon/pull/129');
        expect(await readFile(argsPath, 'utf8')).toBe(
          ['pr', 'view', 'iminoso:feat/pr-branch-lookup', '--json', 'state,url', ''].join('\n'),
        );
      },
    );
  },
);
test('resolvePullRequestUrl builds Azure DevOps PR URLs from SSH remotes', async () => {
  await using directory = await createTemporaryDirectory('codophon-cli-');
  const repositoryPath = directory.path;

  await git(repositoryPath, ['init']);
  await git(repositoryPath, [
    'remote',
    'add',
    'origin',
    'git@ssh.dev.azure.com:v3/contoso/Fabrikam/Storefront',
  ]);

  expect(resolvePullRequestUrl(repositoryPath, 492, 'azure-devops')).toBe(
    'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492',
  );
  expect(resolvePullRequestUrl(repositoryPath, 492, 'github')).toBe(
    'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492',
  );
});

test('resolvePullRequestUrl prefers GitHub remotes when both GitHub and Azure exist', async () => {
  await using directory = await createTemporaryDirectory('codophon-cli-');
  const repositoryPath = directory.path;

  await git(repositoryPath, ['init']);
  await git(repositoryPath, [
    'remote',
    'add',
    'azure',
    'git@ssh.dev.azure.com:v3/contoso/Fabrikam/Storefront',
  ]);
  await git(repositoryPath, ['remote', 'add', 'origin', 'git@github.com:raels0/codophon.git']);

  expect(resolvePullRequestUrl(repositoryPath, 75, 'github')).toBe(
    'https://github.com/raels0/codophon/pull/75',
  );
});

test('PR branch lookup rejects merged pull requests', { concurrent: false }, async () => {
  await withFakeGitHubCli(
    {
      state: 'MERGED',
      url: 'https://github.com/raels0/codophon/pull/127',
    },
    () => {
      expect(() =>
        resolvePullRequestTargetUrl({
          branch: 'owner:merged-branch',
          number: null,
          provider: 'github',
          repositoryPath: process.cwd(),
          url: null,
        }),
      ).toThrow('Could not find an open GitHub pull request for branch "owner:merged-branch".');
    },
  );
});

// Packaged builds put the executable two levels above resources/app. The terminal helper runs
// the CLI with that executable in Node mode, and the CLI relaunches it as the app with one
// encoded launch request. The fake executable plays both roles.
const fakePackagedExecutable = `#!/bin/sh
if [ "\${ELECTRON_RUN_AS_NODE:-}" = "1" ]; then
  exec "$REAL_NODE" "$@"
fi
for arg in "$@"; do
  printf "%s\\n" "$arg" >> "$PACKAGED_ARGS_FILE.tmp"
done
mv "$PACKAGED_ARGS_FILE.tmp" "$PACKAGED_ARGS_FILE"
`;

for (const executableName of ['codophon.exe', 'codophon']) {
  test(`packaged terminal helper launches ${executableName} with the parsed review`, async () => {
    await using directory = await createTemporaryDirectory('codophon-packaged-app-');
    const appPath = join(directory.path, 'resources', 'app');
    const argsPath = join(directory.path, 'args.txt');
    const repositoryPath = join(directory.path, 'repo');
    await mkdir(join(appPath, 'bin'), { recursive: true });
    await mkdir(repositoryPath);
    for (const file of await readdir(resolve('bin'))) {
      await writeFile(join(appPath, 'bin', file), await readFile(resolve('bin', file)));
    }
    await chmod(join(appPath, 'bin', 'codophon-app'), 0o755);
    await symlink(resolve('electron'), join(appPath, 'electron'), 'dir');
    await forgeConfig.hooks.packageAfterCopy({}, appPath);
    await writeFile(join(appPath, 'package.json'), await readFile(resolve('package.json')));
    await writeFile(join(directory.path, executableName), fakePackagedExecutable);
    await chmod(join(directory.path, executableName), 0o755);

    const { CODOPHON_NODE_COMMAND: _, ...env } = process.env;
    await execFileAsync(
      join(appPath, 'bin', 'codophon-app'),
      ['--commit', 'HEAD', repositoryPath],
      {
        env: { ...env, PACKAGED_ARGS_FILE: argsPath, REAL_NODE: process.execPath },
      },
    );

    let args: Array<string> = [];
    for (let attempt = 0; attempt < 250 && args.length === 0; attempt++) {
      args = await readFile(argsPath, 'utf8').then(
        (text) => text.trim().split('\n'),
        () => new Promise((resolveWait) => setTimeout(() => resolveWait([]), 20)),
      );
    }
    expect(decodeLaunchRequest(args)).toEqual({
      repositoryPath,
      source: { ref: 'HEAD', type: 'commit' },
      walkthrough: false,
    });
  });
}

test('Codex skill launcher uses the session cwd as the repository target', async () => {
  await using logger = await createFakeCommandLogger('codophon-skill-launcher-', 'codophon');
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionDirectory = join(home, '.codex', 'sessions', '2026', '05', '25');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  await mkdir(repositoryPath, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(walkthroughFile, '{}');
  await writeFile(sessionPath, '');
  await truncate(sessionPath, 17 * 1024 * 1024);
  await appendFile(
    sessionPath,
    `\n${JSON.stringify({
      payload: { cwd: repositoryPath },
      type: 'turn_context',
    })}\n`,
  );

  await execFileAsync(
    process.execPath,
    [resolve('skills/codophon/scripts/open-codophon.mjs'), '--file', walkthroughFile, 'HEAD'],
    {
      cwd: resolve('skills/codophon'),
      env: {
        ...logger.env,
        CODEX_HOME: join(home, '.codex'),
        CODEX_THREAD_ID: sessionId,
        CODOPHON_COMMAND: logger.commandPath,
      },
    },
  );

  expect(await logger.readArgs()).toEqual([
    '-w',
    '--agent',
    'codex',
    '--walkthrough-file',
    walkthroughFile,
    '--codex-session',
    sessionId,
    'HEAD',
    repositoryPath,
  ]);
});

test('skill launcher identifies the agent from its install path and falls back to the source repo', async () => {
  await using logger = await createFakeCommandLogger('codophon-skill-launcher-', 'codophon');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  const installedSkill = join(logger.directory, 'home', '.codex', 'skills', 'codophon');

  await writeFile(walkthroughFile, '{}');
  await mkdir(dirname(installedSkill), { recursive: true });
  await symlink(resolve('skills/codophon'), installedSkill, 'dir');

  await execFileAsync(
    process.execPath,
    [join(installedSkill, 'scripts/open-codophon.mjs'), '--file', walkthroughFile],
    {
      cwd: resolve('skills/codophon'),
      env: {
        ...logger.env,
        CODEX_HOME: join(logger.directory, 'home', '.codex'),
        CODEX_THREAD_ID: '',
        CODOPHON_COMMAND: logger.commandPath,
      },
    },
  );

  expect(await logger.readArgs()).toEqual([
    '-w',
    '--agent',
    'codex',
    '--walkthrough-file',
    walkthroughFile,
    resolve('.'),
  ]);
});

test('Codex skill launcher does not override explicit repository targets', async () => {
  await using logger = await createFakeCommandLogger('codophon-skill-launcher-', 'codophon');
  const sessionRepositoryPath = join(logger.directory, 'session-repo');
  const explicitRepositoryPath = join(logger.directory, 'explicit-repo');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  await mkdir(sessionRepositoryPath, { recursive: true });
  await mkdir(explicitRepositoryPath, { recursive: true });
  await writeFile(walkthroughFile, '{}');

  await execFileAsync(
    process.execPath,
    [
      resolve('skills/codophon/scripts/open-codophon.mjs'),
      '--agent',
      'codex',
      '--file',
      walkthroughFile,
      explicitRepositoryPath,
    ],
    {
      cwd: resolve('skills/codophon'),
      env: {
        ...logger.env,
        CODEX_SESSION_CWD: sessionRepositoryPath,
        CODEX_THREAD_ID: '',
        CODOPHON_COMMAND: logger.commandPath,
      },
    },
  );

  expect(await logger.readArgs()).toEqual([
    '-w',
    '--agent',
    'codex',
    '--walkthrough-file',
    walkthroughFile,
    explicitRepositoryPath,
  ]);
});

test('Claude skill launcher uses the session cwd and forwards --agent claude', async () => {
  await using logger = await createFakeCommandLogger('codophon-claude-launcher-', 'codophon');
  const home = join(logger.directory, 'home');
  const repositoryPath = join(logger.directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const projectDirectory = join(home, '.claude', 'projects', '-tmp-repo');
  const sessionPath = join(projectDirectory, `${sessionId}.jsonl`);
  const walkthroughFile = join(logger.directory, 'walkthrough.json');

  await mkdir(repositoryPath, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(walkthroughFile, '{}');
  await writeFile(sessionPath, '');
  await truncate(sessionPath, 17 * 1024 * 1024);
  await appendFile(sessionPath, `\n${JSON.stringify({ cwd: repositoryPath })}\n`);

  await execFileAsync(
    process.execPath,
    [resolve('skills/codophon/scripts/open-codophon.mjs'), '--file', walkthroughFile, 'HEAD'],
    {
      cwd: resolve('skills/codophon'),
      env: {
        ...logger.env,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_SESSION_ID: sessionId,
        CODOPHON_COMMAND: logger.commandPath,
      },
    },
  );

  expect(await logger.readArgs()).toEqual([
    '-w',
    '--agent',
    'claude',
    '--walkthrough-file',
    walkthroughFile,
    '--claude-session',
    sessionId,
    'HEAD',
    repositoryPath,
  ]);
});

test('OpenCode skill launcher links the project session from a repository subdirectory', async () => {
  await using logger = await createFakeCommandLogger('codophon-opencode-launcher-', 'codophon');
  const repositoryPath = join(logger.directory, 'repo');
  const workingDirectory = join(repositoryPath, 'nested');
  const walkthroughFile = join(logger.directory, 'walkthrough.json');
  const homePath = join(logger.directory, 'home');
  const openCodePath = join(homePath, '.opencode', 'bin', 'opencode');
  const sessionId = 'ses_121b4816bffebMr9YE52O4870p';

  await mkdir(workingDirectory, { recursive: true });
  await mkdir(join(homePath, '.opencode', 'bin'), { recursive: true });
  const realRepositoryPath = await realpath(repositoryPath);
  const realWorkingDirectory = await realpath(workingDirectory);
  await writeFile(walkthroughFile, '{}');
  await writeFile(
    openCodePath,
    `#!/bin/sh
printf '[{"id":"${sessionId}","directory":"%s"}]\\n' "$OPENCODE_SESSION_DIRECTORY"
`,
  );
  await chmod(openCodePath, 0o755);

  await execFileAsync(
    process.execPath,
    [
      resolve('skills/codophon/scripts/open-codophon.mjs'),
      '--agent',
      'opencode',
      '--file',
      walkthroughFile,
      'HEAD',
    ],
    {
      cwd: workingDirectory,
      env: {
        ...logger.env,
        CODOPHON_COMMAND: logger.commandPath,
        HOME: homePath,
        OPENCODE_SESSION_DIRECTORY: realRepositoryPath,
        PATH: logger.directory,
      },
    },
  );

  expect(await logger.readArgs()).toEqual([
    '-w',
    '--agent',
    'opencode',
    '--walkthrough-file',
    walkthroughFile,
    '--opencode-session',
    sessionId,
    'HEAD',
    realWorkingDirectory,
  ]);
});

test('parseArguments recognizes --help and -h flags', () => {
  expect(parseArguments(['--help']).help).toBe(true);
  expect(parseArguments(['-h']).help).toBe(true);
});

test('parseArguments recognizes --version and -v flags', () => {
  expect(parseArguments(['--version']).version).toBe(true);
  expect(parseArguments(['-v']).version).toBe(true);
});

test('parseArguments defaults help and version to false', () => {
  const result = parseArguments([]);
  expect(result.help).toBe(false);
  expect(result.version).toBe(false);
});

test('formatHelpText includes version and all flags', () => {
  const text = formatHelpText('1.2.3');
  expect(text).toContain('codophon v1.2.3');
  expect(text).toContain('Usage:');
  expect(text).toContain('--help');
  expect(text).toContain('--version');
  expect(text).toContain('--commit');
  expect(text).toContain('--codex-session');
  expect(text).toContain('--opencode-session');
  expect(text).not.toContain('--plan');
  expect(text).not.toContain('--share');
  expect(text).toContain('--walkthrough');
  expect(text).toContain('--walkthrough-context');
  expect(text).toContain('-h');
  expect(text).toContain('-v');
  expect(text).toContain('-w');
  expect(text).toContain('codophon pr owner:feature');
  expect(text).toContain('codophon ado 75');
});

test('formatHelpText styles titles and descriptions', () => {
  const text = formatHelpText('1.2.3');

  expect(text).toContain('\u001b[1;34mUsage:\u001b[0m');
  expect(text).toContain('\u001b[1;34mOptions:\u001b[0m');
  expect(text).toContain('\u001b[1;34mExamples:\u001b[0m');
  expect(text).toContain('  --help, -h');
  expect(text).not.toContain('\u001b[1;34m--help, -h\u001b[0m');
  expect(text).toContain('\u001b[90mShow this help message and exit.\u001b[0m');
  expect(text).toContain('  codophon -w');
  expect(text).not.toContain('\u001b[1;34mcodophon -w\u001b[0m');
  expect(text).toContain('\u001b[90mWalk through local changes, or HEAD when clean.\u001b[0m');
});

test('codophon-app prints help text and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codophon-app'), ['--help'], {
    encoding: 'utf8',
    env: { ...process.env, CODOPHON_NODE_COMMAND: process.execPath },
  });
  expect(stdout).toContain('codophon v');
  expect(stdout).toContain('Usage:');
  expect(stdout).toContain('--help');
  expect(stdout).toContain('--opencode-session <id>');
  expect(stdout).not.toContain('--agent <codex|claude|opencode>Override');
  expect(stdout).toContain('\u001b[1;34mUsage:\u001b[0m');
  expect(stdout).toContain('\u001b[90mShow this help message and exit.\u001b[0m');
});

test('codophon-app prints version and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codophon-app'), ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, CODOPHON_NODE_COMMAND: process.execPath },
  });
  expect(stdout).toMatch(/^codophon v\d+\.\d+\.\d+\n$/);
});

test('codophon --walkthrough-guide prints the guide and embedded schema, then exits 0', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['bin/codophon.js', '--walkthrough-guide'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
    },
  );

  // The authoring prose...
  expect(stdout).toContain('Narrative walkthrough — authoring guide');
  expect(stdout).toContain('chapters');
  expect(stdout).toContain('support');
  expect(stdout).toContain('scanning the sidebar without the prose');
  expect(stdout).toContain('"Set retry attempt and time limits"');
  // ...followed by the live JSON schema, embedded as a fenced block.
  expect(stdout).toContain('```json');
  expect(stdout).toContain('"chapters"');
  expect(stdout).toContain('"hunkId"');
  expect(stdout).toContain('"const": 4');
});

test('parseArguments reads base...target and base..target as a range', async () => {
  await withCwd(refRepositoryPath, () => {
    expect(parseArguments(['-w', 'base...target'])).toMatchObject({
      range: { base: 'base', head: 'target', symmetric: true },
      requestedPath: refRepositoryPath,
    });
    expect(parseArguments(['base..target'])).toMatchObject({
      range: { base: 'base', head: 'target', symmetric: false },
    });
    // Unresolved refs fall back instead of being silently read as a range.
    expect(parseArguments(['nope...nada']).range).toBeUndefined();
  });
});
