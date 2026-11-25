import { useCallback, useRef } from 'react';
import { sortFiles } from '../../lib/files.ts';
import { getWalkthroughReviewKeyPrefix } from '../../lib/review-identity.ts';
import { getSourceKey } from '../../lib/source.ts';
import type { ChangedFile, RepositoryState, ReviewSource } from '../../types.ts';

type Viewed = Record<string, string>;
type ViewedUpdate = {
  failed: boolean;
  file: ChangedFile;
  pending: boolean;
  root: string;
  sourceKey: string;
  version: number;
  viewed: boolean;
};

const replaceFileViewed = (current: Viewed, file: ChangedFile, replacement: Viewed): Viewed => {
  const prefix = getWalkthroughReviewKeyPrefix(file.path);
  const isRelated = (key: string) => key === file.path || key.startsWith(prefix);
  return Object.fromEntries([
    ...Object.entries(current).filter(([key]) => !isRelated(key)),
    ...Object.entries(replacement).filter(([key]) => isRelated(key)),
  ]);
};

export function usePullRequestViewedSync({
  getRepository,
  getViewed,
  setViewed,
}: {
  getRepository: () => RepositoryState | null;
  getViewed: () => Viewed;
  setViewed: (viewed: Viewed) => void;
}) {
  const updatesRef = useRef(new Map<string, ViewedUpdate>());
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const confirmedRef = useRef(new Map<string, Viewed>());
  const versionRef = useRef(0);

  const syncViewed = useCallback(
    (focusedFile: ChangedFile, previous: Viewed, next: Viewed) => {
      const state = getRepository();
      if (state?.source.type !== 'pull-request' || state.source.provider === 'azure-devops') {
        return;
      }
      // Walkthrough surfaces render a focused diff with its own fingerprint.
      // Whole-file progress always uses the original repository file.
      const file = state.files.find((candidate) => candidate.path === focusedFile.path);
      if (!file) {
        return;
      }
      const viewed = next[file.path] === file.fingerprint;
      if (viewed === (previous[file.path] === file.fingerprint)) {
        return;
      }
      const sourceKey = getSourceKey(state.source);
      const key = JSON.stringify([state.root, sourceKey, file.path]);
      const update: ViewedUpdate = {
        failed: false,
        file,
        pending: true,
        root: state.root,
        sourceKey,
        version: ++versionRef.current,
        viewed,
      };
      updatesRef.current.set(key, update);
      if (!queuesRef.current.has(key)) {
        confirmedRef.current.set(key, replaceFileViewed({}, file, previous));
      }
      const source = state.source;
      const queue = (queuesRef.current.get(key) ?? Promise.resolve())
        .then(async () => {
          await window.codophon.setPullRequestFileViewed({ path: file.path, source, viewed });
          confirmedRef.current.set(key, replaceFileViewed({}, file, next));
        })
        .catch((error: unknown) => {
          update.failed = true;
          const currentState = getRepository();
          if (
            updatesRef.current.get(key) !== update ||
            currentState?.root !== state.root ||
            getSourceKey(currentState.source) !== sourceKey ||
            !currentState.files.some(
              (candidate) =>
                candidate.path === file.path && candidate.fingerprint === file.fingerprint,
            )
          ) {
            return;
          }
          const restored = replaceFileViewed(
            getViewed(),
            file,
            confirmedRef.current.get(key) ?? previous,
          );
          setViewed(restored);
          window.alert(
            `Could not sync Viewed for ${file.path} with GitHub: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          update.pending = false;
          if (queuesRef.current.get(key) === queue) {
            queuesRef.current.delete(key);
          }
        });
      queuesRef.current.set(key, queue);
    },
    [setViewed, getRepository, getViewed],
  );

  const getRepositoryState = useCallback(
    async (source?: ReviewSource): Promise<RepositoryState> => {
      const version = versionRef.current;
      // A refresh after a click must observe the saved state. Keep newer clicks
      // optimistic if they happen while the GitHub lookup is in flight.
      await Promise.all(queuesRef.current.values());
      const snapshot = await window.codophon.getRepositoryState(source);
      const state = { ...snapshot, files: sortFiles(snapshot.files) };
      if (state.viewedFiles) {
        const viewedFiles = { ...state.viewedFiles };
        for (const update of updatesRef.current.values()) {
          if (
            update.failed ||
            (!update.pending && update.version <= version) ||
            update.root !== state.root ||
            update.sourceKey !== getSourceKey(state.source) ||
            !state.files.some(
              (file) =>
                file.path === update.file.path && file.fingerprint === update.file.fingerprint,
            )
          ) {
            continue;
          }
          if (update.viewed) {
            viewedFiles[update.file.path] = update.file.fingerprint;
          } else {
            delete viewedFiles[update.file.path];
          }
        }
        return { ...state, viewedFiles };
      }
      return state;
    },
    [],
  );

  return { getRepositoryState, syncViewed };
}
