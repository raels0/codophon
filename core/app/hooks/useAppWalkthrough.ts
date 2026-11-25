import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SidebarMode, WalkthroughError } from '../../lib/app-types.ts';
import { buildCommitModel, buildGenericCommitModel } from '../../lib/narrative-walkthrough.ts';
import {
  createReviewCommandTarget,
  type ReviewCommandTarget,
} from '../../lib/review-command-target.ts';
import { getSourceKey } from '../../lib/source.ts';
import type {
  ChangedFile,
  NarrativeWalkthrough,
  NarrativeWalkthroughRequestOptions,
  RepositoryState,
  WalkthroughProgressEvent,
} from '../../types.ts';
import type { CommitSession } from '../components/walkthrough/CommitView.tsx';
import type { WalkthroughReviewTarget } from '../components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from '../components/walkthrough/useNarrativeNavigation.ts';
import { nextWalkthroughResponseLabelIndex } from '../components/walkthrough/WalkthroughProgress.tsx';
import type { WalkthroughFileError } from '../components/WalkthroughFileError.tsx';

type MainMode = 'commit' | 'review';

type UseAppWalkthroughOptions = {
  getGeneration: () => number;
  getRepository: () => RepositoryState | null;
  state: RepositoryState | null;
};

// Native commands and asynchronous completions can run before React commits a render.
function useCurrentState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  const update = useCallback((next: T) => {
    current.current = next;
    setValue(() => next);
  }, []);
  return [value, update, current] as const;
}

const emptyFiles: ReadonlyArray<ChangedFile> = [];

export function useAppWalkthrough({
  getGeneration,
  getRepository,
  state,
}: UseAppWalkthroughOptions) {
  const [mainMode, setMainMode, mainModeRef] = useCurrentState<MainMode>('review');
  const [narrativeWalkthrough, setNarrativeWalkthrough, narrativeWalkthroughRef] =
    useCurrentState<NarrativeWalkthrough | null>(null);
  const [sidebarMode, setSidebarMode, sidebarModeRef] = useCurrentState<SidebarMode>('tree');
  const [walkthroughError, setWalkthroughError, walkthroughErrorRef] =
    useCurrentState<WalkthroughError | null>(null);
  const [walkthroughFileError, setWalkthroughFileError] = useState<WalkthroughFileError | null>(
    null,
  );
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughProgress, setWalkthroughProgress] = useState<{
    phase: WalkthroughProgressEvent['phase'] | null;
    responseLabelIndex: number;
    stageRevision: number;
  }>({ phase: null, responseLabelIndex: -1, stageRevision: 0 });
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const activeReviewCommandTargetRef = useRef<ReviewCommandTarget | null>(null);
  const walkthroughRequestRef = useRef(0);
  const navigationResetKey = state ? `${state.root}:${getSourceKey(state.source)}` : '';
  const narrativeNavigation = useNarrativeNavigation(
    narrativeWalkthrough,
    state?.files ?? emptyFiles,
    navigationResetKey,
  );

  useEffect(() => {
    activeReviewCommandTargetRef.current = null;
  }, [navigationResetKey]);

  useEffect(
    () =>
      window.codophon.onWalkthroughProgress((progress) => {
        setWalkthroughProgress((current) =>
          current.phase === progress.phase
            ? current
            : {
                phase: progress.phase,
                responseLabelIndex: current.responseLabelIndex,
                stageRevision: current.stageRevision + 1,
              },
        );
      }),
    [],
  );

  const startWalkthroughLoading = useCallback(() => {
    setWalkthroughProgress((current) => ({
      phase: null,
      responseLabelIndex: nextWalkthroughResponseLabelIndex(current.responseLabelIndex),
      stageRevision: current.stageRevision + 1,
    }));
    setWalkthroughLoading(true);
  }, []);

  const commitSession = useMemo<CommitSession>(
    () => ({
      commit: (request) =>
        window.codophon.createWalkthroughCommit({
          ...request,
          source: getRepository()?.source ?? request.source,
        }),
      onOutput: (callback) => window.codophon.onWalkthroughCommitOutput(callback),
      updateMessage: (request) =>
        window.codophon.updateWalkthroughCommitMessage({
          ...request,
          source: getRepository()?.source ?? request.source,
        }),
    }),
    [getRepository],
  );

  const loadNarrativeWalkthrough = useCallback(
    (source: RepositoryState['source'], options?: NarrativeWalkthroughRequestOptions) => {
      const request = walkthroughRequestRef.current + 1;
      walkthroughRequestRef.current = request;
      const sourceKey = getSourceKey(source);
      const stateGeneration = getGeneration();
      const isCurrentState = () =>
        walkthroughRequestRef.current === request &&
        getGeneration() === stateGeneration &&
        getSourceKey(getRepository()?.source ?? source) === sourceKey;
      startWalkthroughLoading();
      setWalkthroughError(null);
      window.codophon
        .getNarrativeWalkthrough(source, options)
        .then((result) => {
          if (!isCurrentState()) {
            return;
          }

          if (result.status === 'ready') {
            setNarrativeWalkthrough(result.walkthrough);
            if (sidebarModeRef.current !== 'walkthrough') {
              setWalkthroughUnread(true);
            }
          } else {
            setWalkthroughError(result);
          }
        })
        .catch((error: unknown) => {
          if (!isCurrentState()) {
            return;
          }

          setWalkthroughError({
            reason: error instanceof Error ? error.message : String(error),
            status: 'unavailable',
          });
        })
        .finally(() => {
          if (walkthroughRequestRef.current === request) {
            setWalkthroughLoading(false);
          }
        });
    },
    [
      getGeneration,
      getRepository,
      setNarrativeWalkthrough,
      setWalkthroughError,
      sidebarModeRef,
      startWalkthroughLoading,
    ],
  );

  const refreshWalkthroughForState = useCallback(
    (
      nextState: RepositoryState,
      previousWalkthrough: NarrativeWalkthrough | null = narrativeWalkthroughRef.current,
    ) => {
      if (sidebarModeRef.current !== 'walkthrough' && previousWalkthrough == null) {
        return;
      }

      walkthroughRequestRef.current += 1;
      setNarrativeWalkthrough(null);
      setWalkthroughError(null);
      setWalkthroughLoading(false);
      if (nextState.files.length === 0) {
        return;
      }

      loadNarrativeWalkthrough(nextState.source, {
        force: true,
        previousWalkthrough: previousWalkthrough ?? undefined,
      });
    },
    [
      loadNarrativeWalkthrough,
      narrativeWalkthroughRef,
      setNarrativeWalkthrough,
      setWalkthroughError,
      sidebarModeRef,
    ],
  );

  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
      setMainMode('review');
      setSidebarMode(mode);
      if (mode !== 'walkthrough') {
        return;
      }
      setWalkthroughUnread(false);
      if (narrativeWalkthrough || walkthroughError || walkthroughLoading || !state) {
        return;
      }
      if (state.files.length === 0) {
        setNarrativeWalkthrough(null);
        setWalkthroughError(null);
        setWalkthroughLoading(false);
        return;
      }

      loadNarrativeWalkthrough(state.source);
    },
    [
      loadNarrativeWalkthrough,
      narrativeWalkthrough,
      setMainMode,
      setNarrativeWalkthrough,
      setSidebarMode,
      setWalkthroughError,
      state,
      walkthroughError,
      walkthroughLoading,
    ],
  );

  const openCommitView = useCallback(() => {
    const currentState = getRepository();
    if (
      !currentState ||
      currentState.source.type !== 'working-tree' ||
      currentState.files.length === 0
    ) {
      return;
    }
    if (narrativeWalkthroughRef.current) {
      narrativeNavigation.enterCommit();
    }
    setSidebarMode('tree');
    setMainMode('commit');
  }, [getRepository, narrativeNavigation, narrativeWalkthroughRef, setMainMode, setSidebarMode]);

  const closeCommitView = useCallback(() => {
    setSidebarMode('tree');
    setMainMode('review');
  }, [setMainMode, setSidebarMode]);

  const updateActiveWalkthroughReviewTarget = useCallback(
    (target: WalkthroughReviewTarget | null) => {
      const currentState = getRepository();
      activeReviewCommandTargetRef.current =
        target && currentState
          ? createReviewCommandTarget(currentState.source, target.file, target.reviewIdentity)
          : null;
    },
    [getRepository],
  );

  const plainCommitModel = useMemo(
    () =>
      narrativeNavigation.walkthroughView
        ? buildCommitModel(narrativeNavigation.walkthroughView, state?.files ?? emptyFiles)
        : buildGenericCommitModel(state?.files ?? emptyFiles),
    [narrativeNavigation.walkthroughView, state?.files],
  );
  const showPlainCommitView =
    mainMode === 'commit' && state?.source.type === 'working-tree' && state.files.length > 0;

  return {
    activeReviewCommandTargetRef,
    changeSidebarMode,
    closeCommitView,
    commitSession,
    mainModeRef,
    narrativeNavigation,
    narrativeWalkthrough,
    narrativeWalkthroughRef,
    openCommitView,
    plainCommitModel,
    refreshWalkthroughForState,
    setMainMode,
    setNarrativeWalkthrough,
    setSidebarMode,
    setWalkthroughError,
    setWalkthroughFileError,
    setWalkthroughLoading,
    setWalkthroughUnread,
    showNarrativeWalkthrough: narrativeWalkthrough != null && sidebarMode === 'walkthrough',
    showPlainCommitView,
    sidebarMode,
    sidebarModeRef,
    startWalkthroughLoading,
    updateActiveWalkthroughReviewTarget,
    walkthroughError,
    walkthroughErrorRef,
    walkthroughFileError,
    walkthroughLoading,
    walkthroughProgress,
    walkthroughUnread,
  };
}
