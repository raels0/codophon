import { act } from 'react';
/**
 * @vitest-environment jsdom
 */
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import { writeReloadSelection } from '../lib/reload-selection.ts';
import type {
  ChangedFile,
  NarrativeWalkthrough,
  RepositoryState,
  ReviewSource,
  WalkthroughProgressEvent,
} from '../types.ts';
import { createFakeBridge } from './helpers/bridge.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, setInputValue, waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
  Worker?: typeof Worker;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};
class StubWorker extends EventTarget {
  constructor(_scriptURL: string | URL, _options?: WorkerOptions) {
    super();
  }
  onerror = null;
  onmessage = null;
  postMessage() {}
  terminate() {}
}
reactActEnvironment.Worker ??= StubWorker as unknown as typeof Worker;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.style.removeProperty('--font-diff-line-height');
  document.documentElement.style.removeProperty('--font-diff-mono');
  document.documentElement.style.removeProperty('--font-diff-size');
});

const repositoryState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

const createNarrativeWalkthroughFixture = (
  hunks: ReadonlyArray<{
    added: number;
    path: string;
    status: ChangedFile['status'];
  }>,
) =>
  ({
    agent: 'codex',
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'impl',
        stops: [
          {
            added: hunks.reduce((sum, hunk) => sum + hunk.added, 0),
            deleted: 1,
            hunkIds: hunks.map((hunk) => `${hunk.path}:unstaged:h1`),
            hunks: hunks.map((hunk) => ({
              added: hunk.added,
              anchor: {
                display: hunk.path,
                sectionId: `${hunk.path}:unstaged`,
                side: 'both',
              },
              deleted: hunk.path === 'src/app.ts' ? 1 : 0,
              id: `${hunk.path}:unstaged:h1`,
              path: hunk.path,
              status: hunk.status,
            })),
            id: 'implementation-path',
            importance: 'critical',
            prose: 'Review these changes.',
            title: 'Implementation path',
          },
        ],
        title: 'Implementation',
      },
    ],
    focus: 'Focus.',
    generatedAt: '2026-06-07T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source: { type: 'working-tree' },
    support: [],
    title: 'Narrative',
    version: 4,
  }) satisfies NarrativeWalkthrough;

const dispatchModifiedKey = (key: string, shiftKey = false) => {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  window.dispatchEvent(
    new KeyboardEvent('keydown', { ctrlKey: !isMac, key, metaKey: isMac, shiftKey }),
  );
};

test('displays a diff while setup status and history are still pending', async () => {
  const getAgentSkillStatus = vi.fn(() => new Promise<never>(() => {}));
  const getRepositoryHistory = vi.fn(
    () => new Promise<Awaited<ReturnType<Window['codophon']['getRepositoryHistory']>>>(() => {}),
  );
  window.codophon = createFakeBridge({
    getAgentSkillStatus,
    getRepositoryHistory,
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
    })),
    getTerminalHelperStatus: vi.fn(() => new Promise<never>(() => {})),
  });
  await using view = await renderReact(<App />);
  await waitFor(() => {
    expect(view.container.querySelector('.codophon-file-header')).not.toBeNull();
    expect(view.container.querySelector('.loading')).toBeNull();
  });
  await waitFor(() => {
    expect(getRepositoryHistory).toHaveBeenCalledOnce();
  });
  await waitFor(() => expect(getAgentSkillStatus).toHaveBeenCalledOnce());
  await waitFor(() => expect(window.codophon.markWindowReady).toHaveBeenCalledOnce());
});

test('unavailable preferences still reveal the review with defaults', async () => {
  window.codophon = createFakeBridge({
    getConfig: vi.fn(async () => {
      throw new Error('Unavailable');
    }),
  });
  await using view = await renderReact(<App />);
  await waitFor(() => {
    expect(view.container.querySelector('.app-shell')).not.toBeNull();
    expect(window.codophon.markWindowReady).toHaveBeenCalledOnce();
  });
});

test('a failed background history request does not hide the diff', async () => {
  const getRepositoryHistory = vi.fn(async () => {
    throw new Error('History is unavailable');
  });
  window.codophon = createFakeBridge({
    getRepositoryHistory,
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [createChangedFile('src/app.ts')],
    })),
  });
  await using view = await renderReact(<App />);
  await waitFor(() => expect(getRepositoryHistory).toHaveBeenCalledOnce());
  expect(view.container.querySelector('.codophon-file-header')).not.toBeNull();
  expect(view.container.textContent).not.toContain('History is unavailable');
});

test('stale persisted collapsed sidebar state does not hide the sidebar on launch', async () => {
  window.localStorage.setItem('codophon:sidebar-collapsed', 'true');
  window.codophon = createFakeBridge();

  await using app = await renderReact(<App />);

  await waitFor(() => {
    expect(app.container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(
      false,
    );
    expect(app.container.querySelector('.sidebar')).not.toBeNull();
    expect(app.container.querySelector('.review-top-bar [role="tablist"]')).not.toBeNull();
  });

  const topBar = app.container.querySelector('.review-top-bar');
  expect(app.container.querySelector('.sidebar [role="tablist"]')).toBeNull();
  const modeControl = topBar?.querySelector('.review-mode-control');
  const modes = modeControl?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [];
  expect([...modes].map((mode) => mode.textContent)).toEqual(['Walkthrough', 'Tree', 'History']);
  const sidebarToggle = topBar?.querySelector<HTMLButtonElement>('.sidebar-toggle-button');
  await act(async () => sidebarToggle?.click());
  expect(app.container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(
    true,
  );
  expect(app.container.querySelector('.review-top-bar')).toBe(topBar);
});

test('keeps source-loading errors in the open-source dialog', async () => {
  const openReviewSourceListeners: Array<Parameters<Window['codophon']['onOpenReviewSource']>[0]> =
    [];
  const getRepositoryState = vi.fn(async (source?: ReviewSource) => {
    if (source?.type === 'branch-working-tree') {
      throw new Error(`Branch "${source.ref}" does not exist in this repository.`);
    }
    return repositoryState;
  });
  window.codophon = createFakeBridge({
    getRepositoryState,
    onOpenReviewSource: vi.fn((callback) => {
      openReviewSourceListeners.push(callback);
      return () => {};
    }),
  });

  await using app = await renderReact(<App />);
  await waitFor(() => expect(app.container.querySelector('.app-shell')).not.toBeNull());

  await act(async () => openReviewSourceListeners[0]?.('branch'));
  const input = app.container.querySelector<HTMLInputElement>('#open-review-source-input');
  const form = app.container.querySelector('form.open-review-source-dialog');
  if (!input || !form) {
    throw new Error('Expected the open branch dialog.');
  }

  await setInputValue(input, 'missing-branch');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  await waitFor(() => {
    expect(app.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Branch "missing-branch" does not exist in this repository.',
    );
  });
  expect(app.container.querySelector('.open-review-source-dialog')).not.toBeNull();
  expect(app.container.querySelector('.app-shell')).not.toBeNull();
  expect(app.container.textContent).not.toContain('Unable to read repository');
});

test('repository reload restores the selected file when it still exists', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const secondFile = createChangedFile('src/second.ts');
  const nextState = {
    ...repositoryState,
    files: [firstFile, secondFile],
  } satisfies RepositoryState;

  writeReloadSelection(nextState, secondFile.path);
  const openFile = vi.fn(async () => {});

  window.codophon = createFakeBridge({
    getRepositoryState: vi.fn(async () => nextState),
    openFile,
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
    expect(container.querySelector('.codophon-file-header')).not.toBeNull();
  });
  await act(async () => {
    dispatchModifiedKey('O', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(openFile).toHaveBeenCalledWith(secondFile.path);
});

test('repository reload restores the selected file from the previous source', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const secondFile = createChangedFile('src/second.ts');
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const nextState = {
    ...repositoryState,
    files: [firstFile, secondFile],
    source,
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'commit' ? nextState : repositoryState,
  );

  writeReloadSelection(nextState, secondFile.path);
  const openFile = vi.fn(async () => {});

  window.codophon = createFakeBridge({
    getRepositoryState,
    openFile,
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
    expect(container.querySelector('.codophon-file-header')).not.toBeNull();
  });
  await act(async () => {
    dispatchModifiedKey('O', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(openFile).toHaveBeenCalledWith(secondFile.path);
  expect(getRepositoryState).toHaveBeenCalledWith(source);
});

test('repository reload preserves a branch diff source even without a selected file', async () => {
  const source = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-diff',
  } satisfies ReviewSource;
  const nextState = {
    ...repositoryState,
    files: [],
    source,
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'branch-diff' ? nextState : repositoryState,
  );

  writeReloadSelection(nextState, null);

  window.codophon = createFakeBridge({
    getRepositoryState,
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
  });
  expect(getRepositoryState).toHaveBeenCalledWith(source);
});

test('repository reload restores branch diff scope after selecting uncommitted changes', async () => {
  const branchSource = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-diff',
  } satisfies ReviewSource;
  const workingTreeState = {
    ...repositoryState,
    branch: 'fork',
    source: { type: 'working-tree' },
  } satisfies RepositoryState;
  const getRepositoryHistory = vi.fn(async () => ({
    entries: [
      {
        author: 'Reviewer',
        committedAt: Date.now(),
        parents: [],
        ref: '99e7b27',
        subject: 'Add branch diff review mode',
      },
    ],
    root: '/repo',
  }));
  const getRepositoryState = vi.fn(async () => workingTreeState);

  writeReloadSelection(workingTreeState, null, branchSource);

  window.codophon = createFakeBridge({
    getRepositoryHistory,
    getRepositoryState,
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  const findButton = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    );

  await waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
    expect(findButton('Committed only vs main')).toBeTruthy();
  });
  expect(getRepositoryState).toHaveBeenCalledWith({ type: 'working-tree' });
  expect(getRepositoryHistory).toHaveBeenCalledWith(expect.any(Number), branchSource);
});

test('repository reload does not let stale selection override launch source', async () => {
  const launchSource = {
    ref: 'main',
    type: 'branch-working-tree',
  } satisfies ReviewSource;
  const staleState = {
    ...repositoryState,
    source: { type: 'working-tree' },
  } satisfies RepositoryState;
  const branchState = {
    ...repositoryState,
    source: launchSource,
  } satisfies RepositoryState;
  const getRepositoryState = vi.fn(async (requestedSource?: ReviewSource) =>
    requestedSource?.type === 'working-tree' ? staleState : branchState,
  );

  writeReloadSelection(staleState, null);

  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source: launchSource,
      walkthrough: false,
    })),
    getRepositoryState,
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
  });
  expect(getRepositoryState).toHaveBeenCalledWith(undefined);
  expect(getRepositoryState).not.toHaveBeenCalledWith(staleState.source);
});

test.each([
  { reviewTheme: 'neutral', title: 'Review Theme: Neutral Review' },
  { reviewTheme: 'blue-amber', title: 'Review Theme: Blue/Amber' },
] as const)(
  '$title applies a saved preference without reloading the review',
  async ({ reviewTheme, title }) => {
    let configChanged: ((config: ReturnType<typeof createDefaultConfig>) => void) | undefined;
    const config = createDefaultConfig();
    config.settings.theme = 'dark';
    window.codophon = createFakeBridge({
      getConfig: vi.fn(async () => config),
      onConfigChanged: vi.fn((callback) => {
        configChanged = callback;
        return () => {};
      }),
      updateSettings: vi.fn(async ({ reviewTheme = config.settings.reviewTheme }) => {
        configChanged?.({ ...config, settings: { ...config.settings, reviewTheme } });
      }),
    });
    await using view = await renderReact(<App />);
    await waitFor(() => expect(view.container.querySelector('.loading')).toBeNull());
    const reads = vi.mocked(window.codophon.getRepositoryState).mock.calls.length;
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Open command palette"]')!
        .click(),
    );
    const search = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Search commands"]',
    )!;
    expect(document.activeElement).toBe(search);
    await setInputValue(search, title);
    const matches = view.container.querySelectorAll('.command-bar-item');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.textContent).toContain(title);
    await act(async () =>
      search.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(window.codophon.updateSettings).toHaveBeenCalledWith({ reviewTheme });
    expect(document.documentElement.getAttribute('data-review-theme')).toBe(reviewTheme);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(view.container.querySelector('[aria-label="Command palette"]')).toBeNull();
    expect(window.codophon.getRepositoryState).toHaveBeenCalledTimes(reads);
  },
);

test('PR refresh fetches the latest snapshot before history and preserves review UI state', async () => {
  const source = {
    baseSha: 'old-base',
    headSha: 'old-head',
    number: 12,
    provider: 'azure-devops',
    type: 'pull-request',
    url: 'https://dev.azure.com/example/project/_git/repo/pullrequest/12',
  } satisfies ReviewSource;
  const initialState = {
    ...repositoryState,
    files: [createChangedFile('src/initial.ts')],
    source,
  } satisfies RepositoryState;
  const refreshedState = {
    ...initialState,
    files: [...initialState.files, createChangedFile('src/added.ts')],
    source: { ...source, baseSha: 'new-base', headSha: 'new-head' },
  } satisfies RepositoryState;
  const pending = Promise.withResolvers<RepositoryState>();
  const getRepositoryState = vi
    .fn<Window['codophon']['getRepositoryState']>()
    .mockResolvedValueOnce(initialState)
    .mockImplementation(() => pending.promise);
  const getRepositoryHistory = vi.fn<Window['codophon']['getRepositoryHistory']>(async () => ({
    entries: [],
    root: '/repo',
  }));
  let refresh: (() => void) | undefined;
  window.codophon = createFakeBridge({
    getRepositoryHistory,
    getRepositoryState,
    onRefreshRequest: (callback) => {
      refresh = callback;
      return () => {};
    },
  });
  await using app = await renderReact(<App />);
  const button = () =>
    app.container.querySelector<HTMLButtonElement>('[aria-label="Refresh pull request"]');
  await waitFor(() => expect(button()).not.toBeNull());
  const filter = app.container.querySelector<HTMLInputElement>(
    '[aria-label="Filter changed files"]',
  )!;
  await act(async () => setInputValue(filter, 'src/'));
  const historyRequests = getRepositoryHistory.mock.calls.length;
  await act(async () => {
    button()!.click();
    button()!.click();
    refresh?.();
  });
  expect(button()!.disabled).toBe(true);
  expect(button()!.getAttribute('aria-busy')).toBe('true');
  expect(button()!.textContent).toContain('Refreshing');
  expect(getRepositoryState).toHaveBeenCalledTimes(2);
  expect(getRepositoryHistory).toHaveBeenCalledTimes(historyRequests);
  await act(async () => pending.resolve(refreshedState));
  await waitFor(() => expect(app.container.textContent).toContain('added.ts'));
  expect(getRepositoryHistory).toHaveBeenLastCalledWith(expect.any(Number), refreshedState.source);
  expect(filter.value).toBe('src/');
  expect(button()!.disabled).toBe(false);
  expect(button()!.getAttribute('aria-busy')).toBe('false');
});

test.each(['state', 'history'] as const)(
  'PR refresh shows %s failures, keeps the current review, and can retry',
  async (failure) => {
    const source = {
      baseSha: 'old-base',
      headSha: 'old-head',
      number: 12,
      provider: 'azure-devops',
      type: 'pull-request',
      url: 'https://dev.azure.com/example/project/_git/repo/pullrequest/12',
    } satisfies ReviewSource;
    const initialState = {
      ...repositoryState,
      files: [createChangedFile('src/initial.ts')],
      source,
    } satisfies RepositoryState;
    const refreshedState = {
      ...initialState,
      files: [createChangedFile('src/updated.ts')],
      source: { ...source, headSha: 'new-head' },
    } satisfies RepositoryState;
    const getRepositoryState = vi
      .fn<Window['codophon']['getRepositoryState']>()
      .mockResolvedValue(initialState);
    const getRepositoryHistory = vi.fn<Window['codophon']['getRepositoryHistory']>(async () => ({
      entries: [],
      root: '/repo',
    }));
    window.codophon = createFakeBridge({ getRepositoryHistory, getRepositoryState });
    await using app = await renderReact(<App />);
    const button = () =>
      app.container.querySelector<HTMLButtonElement>('[aria-label="Refresh pull request"]');
    await waitFor(() => expect(button()).not.toBeNull());
    getRepositoryState.mockResolvedValue(refreshedState);
    const failingRequest = failure === 'state' ? getRepositoryState : getRepositoryHistory;
    failingRequest.mockRejectedValueOnce(new Error('Remote PR is unavailable.'));
    await act(async () => button()!.click());
    await waitFor(() =>
      expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(
        'Refresh failed: Remote PR is unavailable.',
      ),
    );
    expect(app.container.textContent).toContain('initial.ts');
    expect(app.container.textContent).not.toContain('updated.ts');
    expect(button()!.disabled).toBe(false);
    await act(async () =>
      app.container.querySelector<HTMLButtonElement>('.repository-change-reload')!.click(),
    );
    await waitFor(() => expect(app.container.textContent).toContain('updated.ts'));
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
    expect(button()!.disabled).toBe(false);
  },
);

test('refreshing changed files automatically regenerates the walkthrough', async () => {
  const appFile = createChangedFile('src/app.ts');
  const addedFile = createChangedFile('src/added.ts', {
    fingerprint: 'src/added.ts:1',
    patch: 'diff --git a/src/added.ts b/src/added.ts\n@@ -0,0 +1 @@\n+created\n',
    status: 'added',
  });
  const laterFile = createChangedFile('src/later.ts', {
    fingerprint: 'src/later.ts:1',
    patch: 'diff --git a/src/later.ts b/src/later.ts\n@@ -0,0 +1 @@\n+later\n',
    status: 'added',
  });
  const initialWalkthrough = createNarrativeWalkthroughFixture([
    { added: 1, path: appFile.path, status: 'modified' },
  ]);
  const addedWalkthrough = {
    ...createNarrativeWalkthroughFixture([
      { added: 1, path: appFile.path, status: 'modified' },
      { added: 1, path: addedFile.path, status: 'added' },
    ]),
    focus: 'Review the added file.',
  };
  const laterWalkthrough = {
    ...createNarrativeWalkthroughFixture([
      { added: 1, path: appFile.path, status: 'modified' },
      { added: 1, path: addedFile.path, status: 'added' },
      { added: 1, path: laterFile.path, status: 'added' },
    ]),
    focus: 'Review the later file.',
  };

  let onRepositoryChanged: ((change: { root: string }) => void) | null = null;
  let stateRequests = 0;
  const getRepositoryState = vi.fn<Window['codophon']['getRepositoryState']>(async () => {
    stateRequests += 1;
    return {
      ...repositoryState,
      files:
        stateRequests === 1
          ? [appFile]
          : stateRequests === 2
            ? [appFile, addedFile]
            : [appFile, addedFile, laterFile],
    };
  });
  let walkthroughRequests = 0;
  const getNarrativeWalkthrough = vi.fn(async () => {
    walkthroughRequests += 1;
    return {
      status: 'ready' as const,
      walkthrough:
        walkthroughRequests === 1
          ? initialWalkthrough
          : walkthroughRequests === 2
            ? addedWalkthrough
            : laterWalkthrough,
    };
  });

  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough,
    getRepositoryState,
    onRepositoryChanged: vi.fn((callback) => {
      onRepositoryChanged = callback;
      return () => {
        onRepositoryChanged = null;
      };
    }),
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.querySelector('.wt-stop-block')).not.toBeNull();
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
  });
  await act(async () => {
    onRepositoryChanged?.({ root: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.repository-change-reload')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Review the added file.');
    expect(container.textContent).toContain('added.ts');
    expect(container.textContent).not.toContain('Regenerate walkthrough');
    expect(container.textContent).not.toContain('Changed after the walkthrough was generated.');
  });
  expect(getNarrativeWalkthrough).toHaveBeenLastCalledWith(repositoryState.source, {
    force: true,
    previousWalkthrough: initialWalkthrough,
  });
  await act(async () => {
    onRepositoryChanged?.({ root: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.repository-change-reload')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('Review the later file.');
    expect(container.textContent).toContain('added.ts');
    expect(container.textContent).toContain('later.ts');
  });
  expect(getNarrativeWalkthrough).toHaveBeenLastCalledWith(repositoryState.source, {
    force: true,
    previousWalkthrough: addedWalkthrough,
  });
});

test('drops automatic walkthrough regeneration when the same source refreshes again', async () => {
  const appFile = createChangedFile('src/app.ts', {
    fingerprint: 'src/app.ts:1',
    patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
  });
  const addedFile = createChangedFile('src/added.ts', {
    fingerprint: 'src/added.ts:1',
    patch: 'diff --git a/src/added.ts b/src/added.ts\n@@ -0,0 +1 @@\n+added\n',
    status: 'added',
  });
  const laterFile = createChangedFile('src/later.ts', {
    fingerprint: 'src/later.ts:1',
    patch: 'diff --git a/src/later.ts b/src/later.ts\n@@ -0,0 +1 @@\n+later\n',
    status: 'added',
  });
  const initialWalkthrough = createNarrativeWalkthroughFixture([
    { added: 1, path: appFile.path, status: 'modified' },
  ]);
  const staleRegeneration = {
    ...createNarrativeWalkthroughFixture([
      { added: 1, path: appFile.path, status: 'modified' },
      { added: 1, path: addedFile.path, status: 'added' },
    ]),
    focus: 'Stale regeneration.',
  };
  const latestRegeneration = {
    ...createNarrativeWalkthroughFixture([
      { added: 1, path: appFile.path, status: 'modified' },
      { added: 1, path: addedFile.path, status: 'added' },
      { added: 1, path: laterFile.path, status: 'added' },
    ]),
    focus: 'Latest regeneration.',
  };

  let onRepositoryChanged: ((change: { root: string }) => void) | null = null;
  let stateRequests = 0;
  const getRepositoryState = vi.fn<Window['codophon']['getRepositoryState']>(async () => {
    stateRequests += 1;
    return {
      ...repositoryState,
      files:
        stateRequests === 1
          ? [appFile]
          : stateRequests === 2
            ? [appFile, addedFile]
            : [appFile, addedFile, laterFile],
    };
  });
  let walkthroughRequests = 0;
  let resolveFirstRegeneration:
    | ((result: { status: 'ready'; walkthrough: NarrativeWalkthrough }) => void)
    | null = null;
  let resolveSecondRegeneration:
    | ((result: { status: 'ready'; walkthrough: NarrativeWalkthrough }) => void)
    | null = null;
  const getNarrativeWalkthrough = vi.fn(() => {
    walkthroughRequests += 1;
    if (walkthroughRequests === 1) {
      return Promise.resolve({
        status: 'ready' as const,
        walkthrough: initialWalkthrough,
      });
    }
    return new Promise<{ status: 'ready'; walkthrough: NarrativeWalkthrough }>((resolve) => {
      if (walkthroughRequests === 2) {
        resolveFirstRegeneration = resolve;
      } else {
        resolveSecondRegeneration = resolve;
      }
    });
  });

  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough,
    getRepositoryState,
    onRepositoryChanged: vi.fn((callback) => {
      onRepositoryChanged = callback;
      return () => {
        onRepositoryChanged = null;
      };
    }),
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  const refresh = async () => {
    await act(async () => {
      onRepositoryChanged?.({ root: '/repo' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.repository-change-reload')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
  });
  await refresh();
  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.wt-stop-block')).toBeNull();
    expect(container.textContent).toContain('Generating walkthrough');
    expect(container.textContent).not.toContain('Regenerate walkthrough');
  });
  await refresh();
  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(3);
  });
  await act(async () => {
    resolveFirstRegeneration?.({
      status: 'ready',
      walkthrough: staleRegeneration,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector('.wt-stop-block')).toBeNull();
  expect(container.textContent).not.toContain('Stale regeneration.');
  await act(async () => {
    resolveSecondRegeneration?.({
      status: 'ready',
      walkthrough: latestRegeneration,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(container.textContent).toContain('Latest regeneration.');
    expect(container.textContent).toContain('later.ts');
  });
});

test('committing and then editing again clears and regenerates the walkthrough', async () => {
  const appFile = createChangedFile('src/app.ts');
  const nextFile = createChangedFile('src/next.ts', {
    fingerprint: 'src/next.ts:1',
    patch: 'diff --git a/src/next.ts b/src/next.ts\n@@ -0,0 +1 @@\n+next\n',
    status: 'added',
  });
  const initialWalkthrough = {
    ...createNarrativeWalkthroughFixture([{ added: 1, path: appFile.path, status: 'modified' }]),
    focus: 'Initial walkthrough.',
  };
  const nextWalkthrough = {
    ...createNarrativeWalkthroughFixture([{ added: 1, path: nextFile.path, status: 'added' }]),
    focus: 'Fresh walkthrough.',
  };
  let onRepositoryChanged: ((change: { root: string }) => void) | null = null;
  let stateRequests = 0;
  let walkthroughRequests = 0;
  let resolveNextWalkthrough:
    | ((result: { status: 'ready'; walkthrough: NarrativeWalkthrough }) => void)
    | null = null;
  const getNarrativeWalkthrough = vi.fn(() => {
    walkthroughRequests += 1;
    if (walkthroughRequests === 1) {
      return Promise.resolve({
        status: 'ready' as const,
        walkthrough: initialWalkthrough,
      });
    }
    return new Promise<{ status: 'ready'; walkthrough: NarrativeWalkthrough }>((resolve) => {
      resolveNextWalkthrough = resolve;
    });
  });

  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough,
    getRepositoryState: vi.fn(async () => {
      stateRequests += 1;
      return {
        ...repositoryState,
        files: stateRequests === 1 ? [appFile] : stateRequests === 2 ? [] : [nextFile],
      };
    }),
    onRepositoryChanged: vi.fn((callback) => {
      onRepositoryChanged = callback;
      return () => {
        onRepositoryChanged = null;
      };
    }),
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.querySelector('.wt-stop-block')).not.toBeNull();
  });
  await act(async () => {
    onRepositoryChanged?.({ root: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.repository-change-reload')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(container.textContent).toContain('No local changes');
    expect(container.querySelector('.wt-stop-block')).toBeNull();
  });
  expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
  await act(async () => {
    onRepositoryChanged?.({ root: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.repository-change-reload')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Generating walkthrough');
    expect(container.textContent).not.toContain('Initial walkthrough.');
    expect(container.querySelector('.wt-stop-block')).toBeNull();
  });
  expect(getNarrativeWalkthrough).toHaveBeenLastCalledWith(repositoryState.source, {
    force: true,
    previousWalkthrough: undefined,
  });
  await act(async () => {
    resolveNextWalkthrough?.({ status: 'ready', walkthrough: nextWalkthrough });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(container.textContent).toContain('Fresh walkthrough.');
    expect(container.textContent).toContain('next.ts');
    expect(container.textContent).not.toContain('Regenerate walkthrough');
    expect(container.textContent).not.toContain('Changed after the walkthrough was generated.');
  });
});

test('walkthrough launch errors stay on the walkthrough tab without automatic retries', async () => {
  const changedFile = {
    fingerprint: 'src/app.ts:1',
    path: 'src/app.ts',
    sections: [
      {
        binary: false,
        id: 'src/app.ts:unstaged',
        kind: 'unstaged',
        patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;
  const getNarrativeWalkthrough = vi.fn(async () => ({
    reason: 'Codex walkthrough timed out.',
    status: 'unavailable' as const,
  }));

  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough,
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [changedFile],
    })),
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  const getTab = (label: string) =>
    Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
      button.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;

  await waitFor(() => {
    expect(container.textContent).toContain('Walkthrough unavailable');
  });
  expect(getTab('Walkthrough')?.getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('.sidebar-walkthrough-status')).not.toBeNull();
  expect(container.querySelector('.sidebar .file-tree-shell')).toBeNull();
  expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
  await act(async () => {
    getTab('Tree')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    getTab('Walkthrough')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain('Walkthrough unavailable');
  expect(container.querySelector('.sidebar .file-tree-shell')).toBeNull();
  expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
});

test('walkthrough progress events replace the loading line without exposing agent output', async () => {
  const changedFile = {
    fingerprint: 'src/app.ts:1',
    path: 'src/app.ts',
    sections: [
      {
        binary: false,
        id: 'src/app.ts:unstaged',
        kind: 'unstaged',
        patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;
  let onProgress: ((progress: WalkthroughProgressEvent) => void) | null = null;
  let resolveWalkthrough: ((result: { reason: string; status: 'unavailable' }) => void) | null =
    null;
  const getNarrativeWalkthrough = vi.fn(
    () =>
      new Promise<{ reason: string; status: 'unavailable' }>((resolve) => {
        resolveWalkthrough = resolve;
      }),
  );

  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: true,
    })),
    getNarrativeWalkthrough,
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      files: [changedFile],
    })),
    onWalkthroughProgress: vi.fn((callback) => {
      onProgress = callback;
      return () => {
        onProgress = null;
      };
    }),
  });

  await using view = await renderReact(<App />);
  const { container } = view;

  await waitFor(() => {
    expect(container.textContent).toContain('Generating walkthrough…');
  });
  await act(async () => {
    onProgress?.({ phase: 'agent-generation' });
  });
  expect(container.textContent).toContain('Analyzing changes…');
  expect(container.textContent).not.toContain('Generating walkthrough…');
  await act(async () => {
    onProgress?.({ phase: 'response-received' });
  });
  expect(container.textContent).toContain('Building walkthrough…');
  expect(container.querySelector('.wt-generation')).toBeNull();
  await act(async () => {
    resolveWalkthrough?.({
      reason: 'Stopped for test.',
      status: 'unavailable',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

test('commit viewed progress synchronizes tree, walkthrough, and uncovered support without persistence', async () => {
  const file = createChangedFile('src/app.ts', {
    patch:
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-before\n+after\n',
  });
  const source = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
  const walkthrough = {
    ...createNarrativeWalkthroughFixture([{ added: 1, path: file.path, status: file.status }]),
    source,
  };
  window.codophon = createFakeBridge({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      source,
      walkthrough: true,
    })),
    getNarrativeWalkthrough: vi.fn(async () => ({ status: 'ready' as const, walkthrough })),
    getRepositoryState: vi.fn(async () => ({ ...repositoryState, files: [file], source })),
  });
  await using app = await renderReact(<App />);
  const buttons = () => [
    ...app.container.querySelectorAll<HTMLButtonElement>('.codophon-viewed-button'),
  ];
  const collapsedCount = () => app.container.querySelectorAll('[aria-label="Expand file"]').length;
  const switchMode = async (label: string) => {
    const tab = [...app.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (button) => button.textContent === label,
    );
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
  };
  await waitFor(() => expect(buttons()).toHaveLength(2));
  expect(app.container.textContent).toContain('Not included in the generated walkthrough.');
  await act(async () => buttons()[0].click());
  await switchMode('Tree');
  await waitFor(() => expect(buttons()).toHaveLength(1));
  expect(buttons()[0].getAttribute('aria-pressed')).toBe('false');
  expect(collapsedCount()).toBe(0);
  await switchMode('Walkthrough');
  await waitFor(() => expect(buttons()).toHaveLength(2));
  expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  await act(async () => buttons()[1].click());
  await switchMode('Tree');
  await waitFor(() => expect(buttons()).toHaveLength(1));
  expect(buttons()[0].getAttribute('aria-pressed')).toBe('true');
  expect(collapsedCount()).toBe(1);
  const tree = app.container.querySelector('file-tree-container')?.shadowRoot;
  expect(tree?.querySelector('style[data-codophon-viewed-rows]')?.textContent).toContain(
    'src/app.ts',
  );
  await act(async () => buttons()[0].click());
  await switchMode('Walkthrough');
  await waitFor(() => expect(buttons()).toHaveLength(2));
  expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual([
    'false',
    'false',
  ]);
  expect(collapsedCount()).toBe(0);
  await switchMode('Tree');
  await act(async () => buttons()[0].click());
  await switchMode('Walkthrough');
  await waitFor(() => expect(buttons()).toHaveLength(2));
  expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
  expect(collapsedCount()).toBe(2);
  expect(window.localStorage.getItem('codophon:viewed:/repo')).toBeNull();
  await app.rerender(<App key="new-session" />);
  await waitFor(() => {
    expect(buttons()).toHaveLength(2);
    expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
    ]);
  });
});
