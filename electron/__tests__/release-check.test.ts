import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createReleaseCheck } =
  require('../release-check.cjs') as typeof import('../release-check.cjs');

let stateDirectory = '';
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'codophon-release-check-'));
});
afterEach(() => rm(stateDirectory, { force: true, recursive: true }));

const create = (latest: string | null, options: { enabled?: boolean; now?: () => number } = {}) =>
  createReleaseCheck({
    currentVersion: '1.2.0',
    enabled: options.enabled ?? true,
    fetchLatest: vi.fn(async () => latest),
    now: options.now,
    onChange: vi.fn(),
    stateDirectory,
  });

test('reports a newer release and links to it until dismissed, across restarts', async () => {
  const check = create('1.3.0');
  await expect(check.check()).resolves.toEqual({
    availableVersion: '1.3.0',
    currentVersion: '1.2.0',
  });
  expect(check.releaseUrl()).toBe('https://github.com/raels0/codophon/releases/tag/v1.3.0');

  expect(check.dismiss()).toEqual({ currentVersion: '1.2.0' });
  expect(create('1.3.0').getStatus()).toEqual({ currentVersion: '1.2.0' });
});

test('ignores releases that are not newer, and failed checks', async () => {
  await expect(create('1.2.0').check()).resolves.toEqual({ currentVersion: '1.2.0' });
  await expect(create(null).check({ force: true })).resolves.toEqual({ currentVersion: '1.2.0' });
});

test('checks at most once a day unless forced, and never when disabled', async () => {
  let time = 1_000_000_000;
  const now = () => time;
  const fetchLatest = vi.fn(async () => '1.3.0');
  const check = createReleaseCheck({
    currentVersion: '1.2.0',
    enabled: true,
    fetchLatest,
    now,
    onChange: () => {},
    stateDirectory,
  });
  await check.check();
  await check.check();
  expect(fetchLatest).toHaveBeenCalledOnce();
  await check.check({ force: true });
  expect(fetchLatest).toHaveBeenCalledTimes(2);

  check.setEnabled(false);
  time += 2 * 24 * 60 * 60 * 1000;
  expect(await check.check()).toEqual({ currentVersion: '1.2.0' });
  expect(fetchLatest).toHaveBeenCalledTimes(2);
});
