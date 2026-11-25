import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';
import type { NarrativeWalkthrough } from '../../core/types.ts';
import * as store from '../walkthrough-store.ts';

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'codophon-walkthrough-store-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(home, { force: true, recursive: true });
});

const sampleWalkthrough = (): NarrativeWalkthrough => ({
  agent: 'claude',
  chapters: [
    {
      blurb: '',
      icon: 'gear',
      id: 'runtime',
      stops: [
        {
          added: 1,
          deleted: 1,
          hunkIds: ['src/app.ts:staged:h1'],
          hunks: [
            {
              added: 1,
              deleted: 1,
              id: 'src/app.ts:staged:h1',
              path: 'src/app.ts',
              anchor: { display: 'src/app.ts:1' },
              status: 'modified',
            },
          ],
          id: 'behavior',
          importance: 'normal',
          prose: 'Review the behavior.',
          title: 'Behavior',
        },
      ],
      title: 'Runtime',
    },
  ],
  focus: 'Walk through the change.',
  generatedAt: '2026-01-01T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'main', root: '/repo' },
  source: { type: 'working-tree' },
  support: [],
  title: 'Walkthrough',
  version: 4,
});

test('round-trips an exact cache entry', () => {
  const cacheKey = 'exact-input-key';
  store.writeStoredWalkthrough(cacheKey, sampleWalkthrough());

  expect(existsSync(store.getWalkthroughStorePath(cacheKey))).toBe(true);
  expect(store.readStoredWalkthrough(cacheKey)?.title).toBe('Walkthrough');
  expect(store.readStoredWalkthrough('different-input-key')).toBe(null);
});

test('replaces an existing cache entry', () => {
  const cacheKey = 'exact-input-key';
  store.writeStoredWalkthrough(cacheKey, sampleWalkthrough());
  store.writeStoredWalkthrough(cacheKey, {
    ...sampleWalkthrough(),
    title: 'Updated walkthrough',
  });

  expect(store.readStoredWalkthrough(cacheKey)?.title).toBe('Updated walkthrough');
});

test('rejects malformed and incompatible cache records', () => {
  const cacheKey = 'exact-input-key';
  const path = store.getWalkthroughStorePath(cacheKey);
  mkdirSync(join(home, '.codophon', 'walkthroughs'), { recursive: true });

  writeFileSync(path, '{ not json');
  expect(store.readStoredWalkthrough(cacheKey)).toBe(null);

  writeFileSync(
    path,
    JSON.stringify({
      cacheKey,
      version: 2,
      walkthrough: sampleWalkthrough(),
    }),
  );
  expect(store.readStoredWalkthrough(cacheKey)).toBe(null);

  writeFileSync(
    path,
    JSON.stringify({
      cacheKey,
      version: 1,
      walkthrough: { ...sampleWalkthrough(), version: 3 },
    }),
  );
  expect(store.readStoredWalkthrough(cacheKey)).toBe(null);
});
