import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import {
  createUpdater,
  fetchLatestRelease,
  getInstallTarget,
  runInstallScript,
  type InstallTarget,
  type Release,
} from '../updater.ts';

const platform = process.platform === 'win32' ? 'win32' : 'darwin';
const canPackage = process.platform === 'darwin' || process.platform === 'win32';

/** A process id that has already exited, so install scripts don't wait. */
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

/** Lays out an installed app (`Codophon.app` or a folder with `codophon.exe`) holding `marker`. */
const createApp = (parent: string, marker: string) => {
  if (platform === 'darwin') {
    const app = join(parent, 'Codophon.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
    writeFileSync(join(app, 'Contents', 'MacOS', 'Codophon'), marker);
    return { executable: join(app, 'Contents', 'MacOS', 'Codophon'), path: app };
  }
  const app = join(parent, 'Codophon-win32-x64');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'codophon.exe'), marker);
  return { executable: join(app, 'codophon.exe'), path: app };
};

const zipApp = (appPath: string, zipPath: string) => {
  if (platform === 'darwin') {
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
  } else {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-cf', zipPath, '-C', join(appPath, '..'), 'Codophon-win32-x64']);
  }
};

/** Serves a GitHub-shaped `releases/latest` feed and its zip, like the real release does. */
const serveRelease = async (zip: Buffer, { digest }: { digest?: string } = {}) => {
  const server = createServer((request, response) => {
    if (request.url === '/latest') {
      const { port } = server.address() as AddressInfo;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          assets: [
            {
              browser_download_url: `http://127.0.0.1:${port}/zip`,
              digest: digest ?? `sha256:${createHash('sha256').update(zip).digest('hex')}`,
              name: `Codophon-${platform}-${process.arch}-2.0.0.zip`,
              size: zip.length,
            },
          ],
          tag_name: 'v2.0.0',
        }),
      );
    } else {
      response.end(zip);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    [Symbol.asyncDispose]: async () => {
      server.close();
      await once(server, 'close');
    },
    feed: `http://127.0.0.1:${port}/latest`,
  };
};

/** An installed 1.0.0 app and a 2.0.0 release of it, served locally. */
const setUpRelease = async (directory: string, options: { digest?: string; pid?: number } = {}) => {
  const installed = createApp(join(directory, 'Applications'), 'version 1.0.0');
  const built = createApp(join(directory, 'build'), 'version 2.0.0');
  const zipPath = join(directory, 'release.zip');
  zipApp(built.path, zipPath);
  const server = await serveRelease(readFileSync(zipPath), options);
  const target = getInstallTarget(installed.executable, platform)!;
  const updater = createUpdater({
    currentVersion: '1.0.0',
    enabled: true,
    fetchRelease: () => fetchLatestRelease(server.feed),
    installTarget: target,
    onChange: () => {},
    pid: options.pid ?? exitedPid(),
    quit: vi.fn(),
    stateDirectory: join(directory, 'state'),
  });
  return { installed, server, target, updater };
};

test.skipIf(!canPackage)(
  'downloads a newer release, verifies it, and swaps it in when Codophon quits',
  async () => {
    await using directory = await createTemporaryDirectory('codophon-updater-');
    // Stands in for the running app: the swap has to wait until it exits.
    const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const { installed, server, updater } = await setUpRelease(directory.path, {
      pid: running.pid,
    });
    await using _server = server;
    const log = () => {
      const path = join(directory.path, 'state', 'updates', 'install-update.log');
      return existsSync(path) ? readFileSync(path, 'utf8') : '(no install log)';
    };

    await updater.check();
    await updater.download();
    expect(updater.getStatus()).toEqual({
      availableVersion: '2.0.0',
      currentVersion: '1.0.0',
      download: { state: 'ready' },
    });

    updater.installOnQuit();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(readFileSync(installed.executable, 'utf8')).toBe('version 1.0.0');
    running.kill();
    await vi.waitFor(
      () => expect(readFileSync(installed.executable, 'utf8'), log()).toBe('version 2.0.0'),
      { timeout: 30_000 },
    );
    await vi.waitFor(() => expect(existsSync(`${installed.path}.previous`)).toBe(false), {
      timeout: 30_000,
    });
  },
  // Windows starts PowerShell and extracts with tar, which takes several seconds on CI.
  90_000,
);

test.skipIf(!canPackage)(
  'rejects a download that does not match the release checksum',
  async () => {
    await using directory = await createTemporaryDirectory('codophon-updater-');
    const { installed, server, updater } = await setUpRelease(directory.path, {
      digest: `sha256:${'0'.repeat(64)}`,
    });
    await using _server = server;

    await updater.check();
    await updater.download();
    expect(updater.getStatus().download).toEqual({
      error: "The download doesn't match the release's checksum.",
      state: 'failed',
    });
    expect(existsSync(join(directory.path, 'Applications', '.codophon-update'))).toBe(false);
    updater.installOnQuit();
    expect(readFileSync(installed.executable, 'utf8')).toBe('version 1.0.0');
  },
);

test.skipIf(!canPackage)(
  'keeps the installed app when the staged update is missing',
  async () => {
    await using directory = await createTemporaryDirectory('codophon-updater-');
    const installed = createApp(directory.path, 'version 1.0.0');
    const scriptDirectory = join(directory.path, 'scripts');
    const logPath = join(scriptDirectory, 'install-update.log');
    // Launched the way Codophon launches it: detached, so it outlives the app.
    runInstallScript({
      pid: exitedPid(),
      relaunch: false,
      scriptDirectory,
      staged: join(directory.path, 'missing'),
      target: getInstallTarget(installed.executable, platform)!,
    }).unref();
    await vi.waitFor(
      () => expect(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').toMatch(/Done/),
      { timeout: 30_000 },
    );
    expect(readFileSync(logPath, 'utf8')).toMatch(/No update staged/);
    expect(readFileSync(installed.executable, 'utf8')).toBe('version 1.0.0');
    expect(existsSync(`${installed.path}.previous`)).toBe(false);
  },
  60_000,
);

test('installs only where the app can replace itself', async () => {
  await using directory = await createTemporaryDirectory('codophon-updater-');
  const mac = join(directory.path, 'Codophon.app', 'Contents', 'MacOS', 'Codophon');
  mkdirSync(join(mac, '..'), { recursive: true });
  expect(getInstallTarget(mac, 'darwin')).toEqual<InstallTarget>({
    launch: join(directory.path, 'Codophon.app'),
    path: join(directory.path, 'Codophon.app'),
    platform: 'darwin',
  });
  const translocated =
    '/private/var/folders/x/AppTranslocation/1/d/Codophon.app/Contents/MacOS/Codophon';
  expect(getInstallTarget(translocated, 'darwin')).toBeNull();
  expect(getInstallTarget(join(directory.path, 'codophon'), 'linux')).toBeNull();
  expect(getInstallTarget(join(directory.path, 'missing', 'codophon.exe'), 'win32')).toBeNull();
});

const createChecker = (
  stateDirectory: string,
  release: Release | null,
  options: { enabled?: boolean; now?: () => number } = {},
) => {
  const fetchRelease = vi.fn(async () => release);
  const updater = createUpdater({
    currentVersion: '1.2.0',
    enabled: options.enabled ?? true,
    fetchRelease,
    installTarget: null,
    now: options.now,
    onChange: () => {},
    quit: () => {},
    stateDirectory,
  });
  return { fetchRelease, updater };
};

test('without an installable build, a newer release links to its page until dismissed', async () => {
  await using directory = await createTemporaryDirectory('codophon-updater-');
  const { updater } = createChecker(directory.path, { assets: [], version: '1.3.0' });
  await expect(updater.check()).resolves.toEqual({
    availableVersion: '1.3.0',
    currentVersion: '1.2.0',
  });
  expect(updater.canInstall()).toBe(false);
  expect(updater.releaseUrl()).toBe('https://github.com/raels0/codophon/releases/tag/v1.3.0');

  expect(updater.dismiss()).toEqual({ currentVersion: '1.2.0' });
  expect(createChecker(directory.path, null).updater.getStatus()).toEqual({
    currentVersion: '1.2.0',
  });
});

test('ignores releases that are not newer, and failed checks', async () => {
  await using directory = await createTemporaryDirectory('codophon-updater-');
  const same = createChecker(directory.path, { assets: [], version: '1.2.0' }).updater;
  await expect(same.check()).resolves.toEqual({ currentVersion: '1.2.0' });
  const failing = createChecker(directory.path, null).updater;
  await expect(failing.check({ force: true })).resolves.toEqual({ currentVersion: '1.2.0' });
});

test('checks at most once a day unless forced, and never when disabled', async () => {
  await using directory = await createTemporaryDirectory('codophon-updater-');
  let time = 1_000_000_000;
  const { fetchRelease, updater } = createChecker(
    directory.path,
    { assets: [], version: '1.2.0' },
    { now: () => time },
  );
  await updater.check();
  await updater.check();
  expect(fetchRelease).toHaveBeenCalledOnce();
  await updater.check({ force: true });
  expect(fetchRelease).toHaveBeenCalledTimes(2);

  updater.setEnabled(false);
  time += 2 * 24 * 60 * 60 * 1000;
  expect(await updater.check()).toEqual({ currentVersion: '1.2.0' });
  expect(fetchRelease).toHaveBeenCalledTimes(2);
});
