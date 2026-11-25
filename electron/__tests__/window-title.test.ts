import { expect, test } from 'vite-plus/test';
import {
  getPlanWindowTitle,
  getRepositoryWindowTitle,
  restoreRepositoryWindowTitleAfterLoad,
} from '../window-title.ts';

const root = '/Users/reviewer/Documents/GitHub/MyCoolRepo';

test('titles windows with the repository and selected source', () => {
  expect(getRepositoryWindowTitle({ root, source: { type: 'working-tree' } })).toBe(
    'MyCoolRepo · Codophon',
  );
  expect(
    getRepositoryWindowTitle({
      root,
      source: {
        number: 1337,
        type: 'pull-request',
        url: 'https://github.com/framer/MyCoolRepo/pull/1337',
      },
    }),
  ).toBe('MyCoolRepo/1337 · Codophon');
  expect(
    getRepositoryWindowTitle({
      root,
      source: { type: 'pull-request', url: 'https://github.com/framer/MyCoolRepo/pull/1338' },
    }),
  ).toBe('MyCoolRepo/1338 · Codophon');
  expect(
    getRepositoryWindowTitle({
      root,
      source: { ref: 'feature/new-title', type: 'branch-working-tree' },
    }),
  ).toBe('MyCoolRepo/feature/new-title · Codophon');
  expect(getRepositoryWindowTitle({ root, source: { ref: 'a1b2c3d4', type: 'commit' } })).toBe(
    'MyCoolRepo/a1b2c3d · Codophon',
  );
  expect(
    getRepositoryWindowTitle({
      root,
      source: { base: 'main', head: 'feature', symmetric: true, type: 'range' },
    }),
  ).toBe('MyCoolRepo/main...feature · Codophon');
});

test('restores the repository title after the renderer loads', async () => {
  let title = '';
  const target = {
    isDestroyed: () => false,
    setTitle: (nextTitle: string) => {
      title = nextTitle;
    },
  };
  const state = { root, source: { type: 'working-tree' } } as const;

  target.setTitle(getRepositoryWindowTitle(state));
  target.setTitle('Codophon');
  await restoreRepositoryWindowTitleAfterLoad(target, Promise.resolve(state));

  expect(title).toBe('MyCoolRepo · Codophon');
});
