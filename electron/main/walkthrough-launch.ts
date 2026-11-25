import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type {
  CodophonLaunchOptions,
  NarrativeWalkthrough,
  RepositoryState,
  ReviewSource,
} from '../../core/types.ts';
import {
  assertWalkthroughHunkIdsResolve,
  normalizeNarrativeWalkthrough,
} from '../narrative-walkthrough.ts';

const createWalkthroughLaunchController = ({
  hasWindows,
  openWindow,
  quit,
  readRepositoryState,
}: {
  hasWindows: () => boolean;
  openWindow: (
    repositoryPath: string,
    launchOptions: CodophonLaunchOptions,
    state?: Promise<RepositoryState>,
  ) => { webContents: { id: number } };
  quit: () => void;
  readRepositoryState: (
    repositoryPath: string,
    launchOptions: CodophonLaunchOptions,
  ) => Promise<RepositoryState>;
}) => {
  let pendingChecks = 0;

  const initialWalkthroughs: Map<
    number,
    { state: RepositoryState; walkthrough: NarrativeWalkthrough }
  > = new Map();

  const getInitialSnapshot = (webContentsId: number, source?: ReviewSource) => {
    const snapshot = initialWalkthroughs.get(webContentsId);
    if (source && snapshot && !isDeepStrictEqual(source, snapshot.state.source)) {
      initialWalkthroughs.delete(webContentsId);
      return undefined;
    }
    return snapshot;
  };

  const quitIfIdle = () => {
    if (pendingChecks === 0 && !hasWindows()) {
      quit();
    }
  };

  const reportResult = (path: string, reason: string | null) => {
    try {
      writeFileSync(path, reason ? `unavailable\n${reason}\n` : 'ready\n', 'utf8');
    } catch {
      // An interrupted launcher may already have removed its result directory.
    }
  };

  return {
    clear: (webContentsId: number) => initialWalkthroughs.delete(webContentsId),

    getInitialRepositoryState: (webContentsId: number, source: ReviewSource) =>
      getInitialSnapshot(webContentsId, source)?.state,
    hasPending: () => pendingChecks > 0,

    open: async (repositoryPath: string, launchOptions: CodophonLaunchOptions) => {
      const { walkthroughFile, walkthroughResultFile } = launchOptions;
      if (!walkthroughFile || !walkthroughResultFile) {
        openWindow(repositoryPath, launchOptions);
        return;
      }

      pendingChecks += 1;
      try {
        let input;
        try {
          input = JSON.parse(readFileSync(walkthroughFile, 'utf8'));
        } catch (error) {
          reportResult(
            walkthroughResultFile,
            `Could not read walkthrough file: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }

        const state = await readRepositoryState(repositoryPath, launchOptions);
        assertWalkthroughHunkIdsResolve(input, state.files);
        const walkthrough = normalizeNarrativeWalkthrough(input, state.files, {
          branch: state.branch,
          generatedAt: state.generatedAt,
          root: state.root,
          source: state.source,
        });
        const window = openWindow(repositoryPath, launchOptions, Promise.resolve(state));
        // Both initial renderer requests must use the snapshot accepted at launch.
        initialWalkthroughs.set(window.webContents.id, { state, walkthrough });
        reportResult(walkthroughResultFile, null);
      } catch (error) {
        reportResult(
          walkthroughResultFile,
          `Walkthrough file could not be applied to this diff: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        pendingChecks -= 1;
        quitIfIdle();
      }
    },
    quitIfIdle,

    takeInitialWalkthrough: (webContentsId: number, source: ReviewSource) => {
      const snapshot = getInitialSnapshot(webContentsId, source);
      initialWalkthroughs.delete(webContentsId);
      return snapshot?.walkthrough;
    },
  };
};

export { createWalkthroughLaunchController };
