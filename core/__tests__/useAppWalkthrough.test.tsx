/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { useAppWalkthrough } from '../app/hooks/useAppWalkthrough.ts';
import type { NarrativeWalkthrough, RepositoryState, WalkthroughProgressEvent } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

type AppWalkthroughController = ReturnType<typeof useAppWalkthrough>;

const walkthrough: NarrativeWalkthrough = {
  agent: 'codex',
  chapters: [],
  focus: 'Review the change.',
  generatedAt: '2026-07-15T00:00:00.000Z',
  kind: 'narrative',
  repo: {
    branch: 'main',
    root: '/repo',
  },
  source: { type: 'working-tree' },
  support: [],
  title: 'Walkthrough',
  version: 4,
};

const createRepositoryState = (): RepositoryState => ({
  branch: 'main',
  files: [createChangedFile('src/app.ts')],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
});

function AppWalkthroughHarness({
  onController,
  state,
  stateGenerationRef,
  stateRef,
}: {
  onController: (controller: AppWalkthroughController) => void;
  state: RepositoryState;
  stateGenerationRef: Parameters<typeof useAppWalkthrough>[0]['stateGenerationRef'];
  stateRef: Parameters<typeof useAppWalkthrough>[0]['stateRef'];
}) {
  const controller = useAppWalkthrough({
    state,
    stateGenerationRef,
    stateRef,
  });
  onController(controller);
  return null;
}

const renderWalkthroughController = async ({
  codophon,
  state = createRepositoryState(),
}: {
  codophon: Partial<Window['codophon']>;
  state?: RepositoryState;
}) => {
  window.codophon = codophon as Window['codophon'];
  const stateRef = { current: state };
  const stateGenerationRef = { current: 0 };
  let controller: AppWalkthroughController | null = null;
  const getController = () => {
    if (!controller) {
      throw new Error('Walkthrough controller did not render.');
    }
    return controller;
  };
  return {
    ...(await renderReact(
      <AppWalkthroughHarness
        onController={(nextController) => (controller = nextController)}
        state={state}
        stateGenerationRef={stateGenerationRef}
        stateRef={stateRef}
      />,
    )),
    getController,
    stateGenerationRef,
    stateRef,
  };
};

test('walkthrough controller lazily generates, refreshes, and transitions modes', async () => {
  const getNarrativeWalkthrough = vi.fn(async () => ({
    status: 'ready' as const,
    walkthrough,
  }));
  await using view = await renderWalkthroughController({
    codophon: {
      getNarrativeWalkthrough,
      onWalkthroughProgress: vi.fn(() => () => {}),
    },
  });
  const { getController, stateGenerationRef, stateRef } = view;

  expect(getController().sidebarMode).toBe('tree');
  await act(async () => {
    getController().changeSidebarMode('walkthrough');
  });
  await waitFor(() => {
    expect(getController().narrativeWalkthrough).toEqual(walkthrough);
    expect(getController().walkthroughLoading).toBe(false);
  });
  expect(getNarrativeWalkthrough).toHaveBeenCalledWith(walkthrough.source, undefined);
  expect(getController().sidebarMode).toBe('walkthrough');
  expect(getController().walkthroughProgress.responseLabelIndex).toBe(0);
  const refreshedState = {
    ...stateRef.current,
    files: [...stateRef.current.files, createChangedFile('src/added.ts')],
  };
  await act(async () => {
    stateGenerationRef.current += 1;
    stateRef.current = refreshedState;
    getController().refreshWalkthroughForState(refreshedState);
  });
  await waitFor(() => {
    expect(getNarrativeWalkthrough).toHaveBeenCalledTimes(2);
  });
  expect(getNarrativeWalkthrough).toHaveBeenLastCalledWith(walkthrough.source, {
    force: true,
    previousWalkthrough: walkthrough,
  });
  await act(async () => {
    getController().openCommitView();
  });
  expect(getController().showPlainCommitView).toBe(true);
  expect(getController().sidebarMode).toBe('tree');
  await act(async () => {
    getController().closeCommitView();
  });
  expect(getController().showPlainCommitView).toBe(false);
});

test('walkthrough controller routes progress and commit APIs through current state', async () => {
  let onProgress: ((progress: WalkthroughProgressEvent) => void) | null = null;
  const createWalkthroughCommit = vi.fn(async () => ({
    hash: 'abc123',
    status: 'committed' as const,
  }));
  const updateWalkthroughCommitMessage = vi.fn(async () => ({
    body: 'Updated body',
    status: 'ready' as const,
    subject: 'Updated subject',
  }));
  const state = createRepositoryState();
  await using view = await renderWalkthroughController({
    codophon: {
      createWalkthroughCommit,
      onWalkthroughProgress: vi.fn((callback) => {
        onProgress = callback;
        return () => {
          onProgress = null;
        };
      }),
      updateWalkthroughCommitMessage,
    },
    state,
  });
  const { getController } = view;

  await act(async () => {
    onProgress?.({ phase: 'agent-generation' });
  });
  expect(getController().walkthroughProgress.phase).toBe('agent-generation');
  expect(getController().walkthroughProgress.stageRevision).toBe(1);
  await act(async () => {
    await getController().commitWalkthrough({
      body: 'Body',
      paths: ['src/app.ts'],
      source: { ref: 'old', type: 'commit' },
      subject: 'Subject',
    });
    await getController().updateWalkthroughCommitMessage({
      body: 'Body',
      paths: ['src/app.ts'],
      source: { ref: 'old', type: 'commit' },
      subject: 'Subject',
    });
  });
  expect(createWalkthroughCommit).toHaveBeenCalledWith({
    body: 'Body',
    paths: ['src/app.ts'],
    source: state.source,
    subject: 'Subject',
  });
  expect(updateWalkthroughCommitMessage).toHaveBeenCalledWith({
    body: 'Body',
    paths: ['src/app.ts'],
    source: state.source,
    subject: 'Subject',
  });
});
