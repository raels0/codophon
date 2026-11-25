import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import { findExecutableOnPath } from '../agent-shared.ts';
import {
  getCommandEnvironment,
  getLoginShellEnvironment,
  resolveLoginShellEnvironment,
} from '../login-shell-environment.ts';

const require = createRequire(import.meta.url);

const fishPath = findExecutableOnPath('fish');
const zshPath = findExecutableOnPath('zsh');

const createFakeLoginShell = async (directory: string, body: string) => {
  const shellPath = join(directory, 'fake-login-shell');
  await writeFile(shellPath, `#!/bin/sh\n${body}`);
  await chmod(shellPath, 0o755);
  return shellPath;
};

const expectProcessToExit = async (pidPath: string) => {
  const pid = Number(await readFile(pidPath, 'utf8'));
  try {
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process has already exited.
    }
  }
};

test.skipIf(process.platform === 'win32')(
  'isolates login shells from the caller’s controlling terminal',
  async () => {
    await using directory = await createTemporaryDirectory('codophon-login-shell-terminal-');
    const shell = await createFakeLoginShell(
      directory.path,
      `if ( : </dev/tty ) 2>/dev/null; then
  export CODOPHON_HAS_TERMINAL=yes
else
  export CODOPHON_HAS_TERMINAL=no
fi
exec /bin/sh -c "$4"
`,
    );
    const program = `const { openSync, closeSync } = require('node:fs');
const { resolveLoginShellEnvironment } = require(${JSON.stringify(require.resolve('../login-shell-environment.ts'))});
closeSync(openSync('/dev/tty', 'r'));
resolveLoginShellEnvironment(${JSON.stringify(shell)}).then((environment) => {
  console.log('CODOPHON_HAS_TERMINAL=' + environment.CODOPHON_HAS_TERMINAL);
});`;
    // script(1) runs the program on a fresh pseudo-terminal, standing in for
    // launching Codophon from a shell. BSD and util-linux spell it differently.
    const args =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', process.execPath, '-e', program]
        : [
            '-qec',
            `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`,
            '/dev/null',
          ];
    const child = spawn('script', args, {
      cwd: directory.path,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data));
    const [exitCode] = await once(child, 'close');
    expect(exitCode).toBe(0);
    expect(output).toContain('CODOPHON_HAS_TERMINAL=no');
  },
);

test('resolves variables exported by the login shell', async () => {
  await using directory = await createTemporaryDirectory('codophon-login-shell-');
  // Prints startup noise first, the way version managers do in real login
  // shells, so parsing has to survive output preceding the marker.
  const shell = await createFakeLoginShell(
    directory.path,
    `echo 'Using Node v24.15.0'
if [ "$1" != '-l' ] || [ "$2" != '-i' ] || [ "$3" != '-c' ]; then
  exit 1
fi
CODOPHON_FAKE_TOKEN='from-login-shell' CODOPHON_FAKE_MULTILINE='first line
second line' exec /bin/sh -c "$4"
`,
  );
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  const environment = await getLoginShellEnvironment();

  expect(environment.CODOPHON_FAKE_TOKEN).toBe('from-login-shell');
  expect(environment.CODOPHON_FAKE_MULTILINE).toBe('first line\nsecond line');
});

test.skipIf(!fishPath)('resolves variables exported by Fish config', async () => {
  await using directory = await createTemporaryDirectory('codophon-fish-login-shell-');
  const fishConfigDirectory = join(directory.path, 'fish');
  await mkdir(fishConfigDirectory);
  await writeFile(
    join(fishConfigDirectory, 'config.fish'),
    'set --export CODOPHON_FAKE_TOKEN from-fish-config\n',
  );
  await using _environment = createTemporaryEnvironment({
    HOME: directory.path,
    XDG_CONFIG_HOME: directory.path,
  });

  const environment = await resolveLoginShellEnvironment(fishPath!);

  expect(environment.CODOPHON_FAKE_TOKEN).toBe('from-fish-config');
});

test.skipIf(!zshPath)('resolves variables exported by zshrc', async () => {
  await using directory = await createTemporaryDirectory('codophon-zsh-login-shell-');
  await writeFile(join(directory.path, '.zshrc'), "export CODOPHON_FAKE_TOKEN='from-zsh-config'\n");
  await using _environment = createTemporaryEnvironment({
    HOME: directory.path,
    ZDOTDIR: directory.path,
  });

  const environment = await resolveLoginShellEnvironment(zshPath!);

  expect(environment.CODOPHON_FAKE_TOKEN).toBe('from-zsh-config');
});

test('returns an empty environment when the login shell fails', async () => {
  await using directory = await createTemporaryDirectory('codophon-login-shell-');
  const shell = await createFakeLoginShell(directory.path, 'exit 1\n');
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  expect(await getLoginShellEnvironment()).toEqual({});
});

test('returns an empty environment when no login shell is configured', async () => {
  await using _environment = createTemporaryEnvironment({ SHELL: undefined });

  expect(await getLoginShellEnvironment()).toEqual({});
});

test('resolves each login shell once, even under concurrent calls', async () => {
  await using directory = await createTemporaryDirectory('codophon-login-shell-');
  const runsPath = join(directory.path, 'runs.txt');
  const shell = await createFakeLoginShell(
    directory.path,
    `echo run >> '${runsPath}'
CODOPHON_FAKE_TOKEN='from-login-shell' exec /bin/sh -c "$4"
`,
  );
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  const [first, second] = await Promise.all([
    getLoginShellEnvironment(),
    getLoginShellEnvironment(),
  ]);
  const third = await getLoginShellEnvironment();

  expect(second).toBe(first);
  expect(third).toBe(first);
  expect((await readFile(runsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
});

test('builds command environments where the process wins over the login shell', async () => {
  await using directory = await createTemporaryDirectory('codophon-login-shell-');
  const shell = await createFakeLoginShell(
    directory.path,
    `CODOPHON_FAKE_TOKEN='from-login-shell' CODOPHON_FAKE_SHARED='from-login-shell' exec /bin/sh -c "$4"
`,
  );
  await using _environment = createTemporaryEnvironment({
    CODOPHON_FAKE_SHARED: 'from-process',
    CODOPHON_FAKE_TOKEN: undefined,
    SHELL: shell,
  });

  const environment = await getCommandEnvironment();

  expect(environment.CODOPHON_FAKE_TOKEN).toBe('from-login-shell');
  expect(environment.CODOPHON_FAKE_SHARED).toBe('from-process');
});

test('salvages a clean environment dump when a background child holds stdout open', async () => {
  await using directory = await createTemporaryDirectory('codophon-login-shell-');
  const pidPath = join(directory.path, 'child.pid');
  // The shell finishes the dump and exits cleanly, but leaves behind a child
  // that inherits stdout, so `close` stays hours away from `exit`.
  const shell = await createFakeLoginShell(
    directory.path,
    `CODOPHON_FAKE_TOKEN='from-login-shell' /bin/sh -c "$4"
sleep 10 &
echo $! > '${pidPath}'
exit 0
`,
  );

  const environment = await resolveLoginShellEnvironment(shell, 500);

  expect(environment.CODOPHON_FAKE_TOKEN).toBe('from-login-shell');
  await expectProcessToExit(pidPath);
});

test('abandons a login shell that ignores termination', async () => {
  await using directory = await createTemporaryDirectory('codophon-login-shell-');
  const pidPath = join(directory.path, 'child.pid');
  const shell = await createFakeLoginShell(
    directory.path,
    `trap '' TERM
sleep 10 &
echo $! > '${pidPath}'
wait
`,
  );

  expect(await resolveLoginShellEnvironment(shell, 500)).toEqual({});
  await expectProcessToExit(pidPath);
});
