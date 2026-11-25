import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react/ClockCounterClockwise';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/TreeStructure';
import type { FileDiffLoadedFiles } from '@pierre/diffs';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AgentSettingsDialog } from './app/components/AgentSettingsDialog.tsx';
import { AskHistoryDialog } from './app/components/AskHistoryDialog.tsx';
import { AskNotifications } from './app/components/AskNotifications.tsx';
import { CommandBar } from './app/components/CommandBar.tsx';
import { KeyboardShortcutsHelp } from './app/components/KeyboardShortcutsHelp.tsx';
import { OpenReviewSourceDialog } from './app/components/OpenReviewSourceDialog.tsx';
import { OpenReviewSourceMenu } from './app/components/OpenReviewSourceMenu.tsx';
import {
  AgentUnavailablePanel,
  CopyCommentsButton,
  DiffSearchPanel,
  FirstRunPanel,
  PullRequestReviewButtons,
  RepositoryChangeBanner,
  RepositoryLoadErrorPanel,
  ReviewSourceLoading,
  UpdatePill,
  WalkthroughOutdatedBanner,
} from './app/components/Panels.tsx';
import { ReviewBriefDialog } from './app/components/ReviewBriefDialog.tsx';
import {
  preloadReviewMarkdown,
  ReviewCodeView,
  type ReviewDiffBlock,
} from './app/components/ReviewCodeView.tsx';
import type { ReviewModeItem } from './app/components/ReviewModeControl.tsx';
import { ReviewTopBar } from './app/components/ReviewTopBar.tsx';
import { Sidebar } from './app/components/Sidebar.tsx';
import { CommitView } from './app/components/walkthrough/CommitView.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { WalkthroughDiffSurface } from './app/components/walkthrough/WalkthroughDiffSurface.tsx';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import { HistoryStore } from './app/hooks/history-store.ts';
import { ReviewSessionStore } from './app/hooks/review-session-store.ts';
import { useAppCommands } from './app/hooks/useAppCommands.ts';
import { useAppKeyboardShortcuts } from './app/hooks/useAppKeyboardShortcuts.ts';
import { useAppReviewComments, type AskNotification } from './app/hooks/useAppReviewComments.ts';
import { useAppWalkthrough } from './app/hooks/useAppWalkthrough.ts';
import { createCodeEditingStore, useUnsavedCodeEditsGuard } from './app/hooks/useCodeEditing.ts';
import { useDiffSearch } from './app/hooks/useDiffSearch.ts';
import {
  getCodeFontLineHeight,
  normalizeCodeFontSizePreference,
  useDocumentAppearance,
} from './app/hooks/useDocumentAppearance.ts';
import { useInitialWindowReveal } from './app/hooks/useInitialWindowReveal.ts';
import { usePullRequestViewedSync } from './app/hooks/usePullRequestViewedSync.ts';
import { useResizableSidebar } from './app/hooks/useResizableSidebar.ts';
import { isAgentNotFoundCode } from './config/agents.ts';
import { createDefaultConfig } from './config/defaults.ts';
import { getShortcutLabel } from './config/keymap.ts';
import type { AgentSettingsSection, CodophonConfig, CodophonSettings } from './config/types.ts';
import {
  defaultAgentSkillStatus,
  defaultLaunchOptions,
  defaultTerminalHelperStatus,
  getAgentLabel,
} from './lib/app-constants.ts';
import {
  type CodeViewInstance,
  type RepositoryLoadError,
  type ReviewComment,
  type ReviewIdentity,
  type ReviewScrollBehavior,
  type ReviewScrollTarget,
  type SourceSession,
} from './lib/app-types.ts';
import { getAskPR, getAskReviewKey, getAskReviewVersion } from './lib/ask-cache.ts';
import {
  isPatchOnlyDiffSection,
  shouldLoadDiffSectionContents,
  shouldPreloadSectionContentsForSearch,
} from './lib/diff.ts';
import { splitRepositoryPath } from './lib/files.ts';
import {
  consumeReloadSelection,
  getReloadDeltaPaths,
  getReloadHistorySource,
  getReloadMainMode,
  getReloadSelectionPath,
  haveChangedFiles,
  haveReloadedFilesChanged,
  writeReloadSelection,
} from './lib/reload-selection.ts';
import { getReviewBriefQuestions } from './lib/review-brief.ts';
import { resolveReviewCommandTarget } from './lib/review-command-target.ts';
import {
  buildReviewCommentsMarkdown,
  getRefreshedReviewComments,
  getVisibleReviewComments,
} from './lib/review-comments.ts';
import { getSelectedPathFromScroll } from './lib/review-scroll.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import {
  getEmptySourceDetail,
  getEmptySourceTitle,
  getHistorySource,
  getRefreshSource,
  getRepositoryLoadError,
  getSourceKey,
  getSourceLabel,
  shouldStartInHistoryWhenEmpty,
  supportsDiffSearchContentPreload,
  supportsLazyDiffContent,
} from './lib/source.ts';
import type {
  ChangedFile,
  AgentSkillStatus,
  CodophonLaunchOptions,
  CodophonUpdateStatus,
  DefinitionCandidate,
  GitIdentity,
  OpenReviewSourceKind,
  ReviewSource,
  TerminalHelperStatus,
  DiffSection,
} from './types.ts';

const emptyReviewComments: ReadonlyArray<ReviewComment> = [];
const disableCodeViewWorkerPool = process.env.NODE_ENV === 'test';

const getFailedSectionLoadState = (section: DiffSection): DiffSection =>
  isPatchOnlyDiffSection(section)
    ? {
        ...section,
        summary: {
          canLoad: false,
          reason: 'Codophon could not load full file context.',
        },
      }
    : {
        ...section,
        loadState: 'error',
        summary: {
          canLoad: false,
          reason: 'Codophon could not load this file.',
        },
      };

const getReloadSourceForLaunch = (
  reloadSelection: ReturnType<typeof consumeReloadSelection>,
  launchOptions: CodophonLaunchOptions,
) => {
  if (!reloadSelection) {
    return undefined;
  }

  if (!launchOptions.source) {
    return reloadSelection.source;
  }

  return getSourceKey(reloadSelection.source) === getSourceKey(launchOptions.source)
    ? reloadSelection.source
    : undefined;
};

export default function App({
  initialConfig,
  initialLaunchOptions,
}: {
  initialConfig?: CodophonConfig;
  initialLaunchOptions?: CodophonLaunchOptions;
} = {}) {
  const [loadError, setLoadError] = useState<RepositoryLoadError | null>(null);
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);
  const [history] = useState(() => new HistoryStore());
  const { entries: historyEntries } = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reviewThemeError, setReviewThemeError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<CodophonUpdateStatus | null>(null);
  const [launchOptions, setLaunchOptions] = useState<CodophonLaunchOptions>(
    initialLaunchOptions ?? defaultLaunchOptions,
  );
  const [codophonConfig, setCodophonConfig] = useState<CodophonConfig>(
    initialConfig ?? createDefaultConfig,
  );
  const [agentSkillInstalling, setAgentSkillInstalling] = useState(false);
  const [agentSkillStatus, setAgentSkillStatus] =
    useState<AgentSkillStatus>(defaultAgentSkillStatus);
  const preferences = codophonConfig.settings;
  const [configLoaded, setConfigLoaded] = useState(initialConfig != null);
  const [scrollTarget, setScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const reviewMainRef = useRef<HTMLElement>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [isWindowFullScreen, setIsWindowFullScreen] = useState(false);
  const [pendingSource, setPendingSource] = useState<ReviewSource | null>(null);
  const [codeEditingStore] = useState(createCodeEditingStore);
  useUnsavedCodeEditsGuard(codeEditingStore);
  const [loadingSectionIds, setLoadingSectionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [openReviewSourceKind, setOpenReviewSourceKind] = useState<OpenReviewSourceKind | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [sessionStore] = useState(() => new ReviewSessionStore());
  const {
    bumpItemVersion,
    getGeneration,
    getRepository,
    getViewed,
    setSelectedPath,
    toggleCollapsed,
  } = sessionStore;
  const {
    collapsed,
    expandedReviewKeys,
    itemVersionByKey,
    reloadDeltaPaths,
    repository: state,
    selectedPath,
    viewed,
  } = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const [askHistory, setAskHistory] = useState<ReturnType<typeof getAskPR>>(null);
  const [reviewBrief, setReviewBrief] = useState<{
    notes: ReturnType<typeof getReviewBriefQuestions>;
    root: string;
    source: Extract<ReviewSource, { type: 'pull-request' }>;
  } | null>(null);
  const [terminalHelperInstalling, setTerminalHelperInstalling] = useState(false);
  const [terminalHelperStatus, setTerminalHelperStatus] = useState<TerminalHelperStatus>(
    defaultTerminalHelperStatus,
  );
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const preferencesRef = useRef(preferences);
  const sourceRequestRef = useRef(0);
  const refreshInProgressRef = useRef(false);
  const markdownRefreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const { getRepositoryState, syncViewed } = usePullRequestViewedSync({
    getRepository,
    getViewed,
    setViewed: sessionStore.setViewed,
  });
  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean, reviewIdentity?: ReviewIdentity) => {
      if (!getRepository()) {
        return;
      }
      const previous = getViewed();
      const next = sessionStore.toggleViewed(file, isViewed, reviewIdentity);
      syncViewed(file, previous, next);
    },
    [sessionStore, getRepository, syncViewed, getViewed],
  );
  const {
    askCacheError,
    askCodex,
    askNotifications,
    createComment,
    deleteComment,
    dismissAskNotification,
    focusCommentId,
    focusCommentRequest,
    hasPendingReviewComments,
    loadReviewComments,
    pullRequestReviewSubmitting,
    resetCommentFocus,
    reviewComments,
    reviewCommentsRef,
    setReviewComments,
    submitPullRequestComment,
    submitPullRequestReview,
    updateActiveReviewCommentDraft,
    updateAskFollowUpDraft,
    updateComment,
  } = useAppReviewComments({
    getRepository,
    onCommentFileChange: bumpItemVersion,
  });
  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, []);
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    collapseThreshold: SIDEBAR_COLLAPSE_THRESHOLD,
    onCollapse: collapseSidebar,
    onWidthCommit: writeSidebarWidth,
    position: preferences.sidebarPosition,
    readWidth: readSidebarWidth,
  });
  const {
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
    showNarrativeWalkthrough,
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
  } = useAppWalkthrough({
    getGeneration,
    getRepository,
    state,
  });
  const [hunkNavigation, setHunkNavigation] = useState<{
    direction: 1 | -1;
    request: number;
  } | null>(null);
  const showWhitespace = preferences.showWhitespace;
  const orderedFiles = useMemo(() => state?.files ?? [], [state]);
  const {
    activeMatch: activeDiffSearchMatch,
    activeMatchIndex: effectiveActiveDiffSearchMatchIndex,
    closeSearch: closeDiffSearch,
    fileFilteredFiles,
    focusRequest: diffSearchFocusRequest,
    hasQuery: hasDiffSearchQuery,
    matches: diffSearchMatches,
    matchPathSet: diffSearchMatchPathSet,
    moveMatch: moveDiffSearchMatch,
    openSearch: openDiffSearch,
    query: diffSearchQuery,
    resetSearch: resetDiffSearch,
    updateQuery: updateDiffSearchQuery,
    visible: diffSearchVisible,
    visibleFiles,
  } = useDiffSearch({
    files: orderedFiles,
    fileSearchQuery,
    showWhitespace,
  });

  const navigateHunks = useCallback((direction: 1 | -1) => {
    setHunkNavigation((current) => ({
      direction,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);

  const loadDiffSection = useCallback(
    (file: ChangedFile, section: DiffSection, repositoryState = getRepository()) => {
      const currentState = repositoryState;
      if (
        !currentState ||
        !supportsLazyDiffContent(currentState.source) ||
        !shouldLoadDiffSectionContents(section)
      ) {
        return;
      }

      const sourceKey = getSourceKey(currentState.source);
      const stateGeneration = getGeneration();
      const key = `${currentState.root}:${sourceKey}:${section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return;
      }

      loadingSectionKeysRef.current.add(key);
      setLoadingSectionIds((current) => new Set(current).add(section.id));

      window.codophon
        .getDiffSectionContent({
          force: true,
          kind: section.kind,
          path: file.path,
          showWhitespace: preferencesRef.current.showWhitespace,
          source: currentState.source,
        })
        .then((loadedSection) => {
          sessionStore.patchSection(stateGeneration, file.path, loadedSection);
        })
        .catch(() =>
          sessionStore.patchSection(stateGeneration, file.path, getFailedSectionLoadState(section)),
        )
        .finally(() => {
          loadingSectionKeysRef.current.delete(key);
          setLoadingSectionIds((current) => {
            const next = new Set(current);
            next.delete(section.id);
            return next;
          });
        });
    },
    [sessionStore, getGeneration, getRepository],
  );

  // Fetches full file contents for a patch-only section so the CodeView
  // `loadDiffFiles` option can hydrate the rendered diff in place. Unlike
  // `loadDiffSection`, this must not touch React state: replacing the section
  // would reset the hydrated diff object's identity.
  const loadDiffSectionContents = useCallback(
    async (file: ChangedFile, section: DiffSection): Promise<FileDiffLoadedFiles> => {
      const currentState = getRepository();
      if (!currentState || !supportsLazyDiffContent(currentState.source)) {
        throw new Error(`Cannot load diff contents for '${file.path}'.`);
      }

      const loadedSection = await window.codophon.getDiffSectionContent({
        force: true,
        kind: section.kind,
        path: file.path,
        showWhitespace: preferencesRef.current.showWhitespace,
        source: currentState.source,
      });
      if (!loadedSection.newFile) {
        throw new Error(`No file contents available for '${file.path}'.`);
      }

      return {
        newFile: loadedSection.newFile,
        oldFile: loadedSection.oldFile ?? null,
      };
    },
    [getRepository],
  );

  useEffect(
    () =>
      sessionStore.onInstall((next, previous, load) => {
        if (load.reason === 'launch' || load.reason === 'switch') {
          loadReviewComments(
            next,
            load.reason === 'switch' ? load.session?.reviewComments : undefined,
          );
          return;
        }
        if (!previous) {
          return;
        }
        const sameRevision = getAskReviewVersion(previous) === getAskReviewVersion(next);
        if (
          load.reason === 'save' ||
          (load.reason === 'whitespace' && next.source.type === 'pull-request' && sameRevision)
        ) {
          setReviewComments((current) => getRefreshedReviewComments(next, current));
        } else if (load.reason === 'whitespace') {
          loadReviewComments(next);
        } else if (next.source.type === 'pull-request' && !sameRevision) {
          loadReviewComments(next, getRefreshedReviewComments(next, reviewCommentsRef.current));
        }
        if (haveChangedFiles(previous.files, next.files)) {
          refreshWalkthroughForState(next);
        }
      }),
    [
      sessionStore,
      loadReviewComments,
      refreshWalkthroughForState,
      reviewCommentsRef,
      setReviewComments,
    ],
  );

  const refreshMarkdownFile = useCallback(
    (file: ChangedFile) => {
      const refresh = async () => {
        const currentState = getRepository();
        if (
          !currentState ||
          (currentState.source.type !== 'working-tree' &&
            currentState.source.type !== 'branch-working-tree')
        ) {
          return true;
        }
        const sourceRequest = sourceRequestRef.current;
        const stateGeneration = getGeneration();

        try {
          const nextState = await getRepositoryState(currentState.source);

          if (sourceRequestRef.current !== sourceRequest || getGeneration() !== stateGeneration) {
            return false;
          }

          sessionStore.install(nextState, { reason: 'save', savedPath: file.path });
          setLocalChangesDetected(false);
          return true;
        } catch {
          setLocalChangesDetected(true);
          return false;
        }
      };

      const result = markdownRefreshQueueRef.current.then(refresh, refresh);
      markdownRefreshQueueRef.current = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    [getGeneration, getRepository, getRepositoryState, sessionStore],
  );

  const scrollPathIntoReview = useCallback((path: string, behavior: ReviewScrollBehavior) => {
    setScrollTarget((current) => ({
      behavior,
      path,
      request: (current?.request ?? 0) + 1,
    }));
    programmaticScrollPathRef.current = path;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollPathRef.current = null;
      programmaticScrollTimerRef.current = null;
    }, 1200);
  }, []);

  const saveCurrentSourceSession = useCallback(() => {
    const currentState = getRepository();
    if (!currentState) {
      return;
    }

    sourceSessionsRef.current.set(getSourceKey(currentState.source), {
      collapsed: sessionStore.getSnapshot().collapsed,
      expandedReviewKeys: sessionStore.getSnapshot().expandedReviewKeys,
      narrativeWalkthrough: narrativeWalkthroughRef.current,
      reviewComments: reviewCommentsRef.current,
      selectedPath: sessionStore.getSnapshot().selectedPath,
      viewed: getViewed(),
      walkthroughError: walkthroughErrorRef.current,
      walkthroughFiles: currentState.files.map(({ fingerprint, path, status }) => ({
        fingerprint,
        path,
        status,
      })),
    });
  }, [
    getRepository,
    getViewed,
    narrativeWalkthroughRef,
    reviewCommentsRef,
    sessionStore,
    walkthroughErrorRef,
  ]);

  useEffect(() => {
    let canceled = false;

    const load = async () => {
      const reloadSelection = consumeReloadSelection();
      const nextLaunchOptions = initialLaunchOptions ?? (await window.codophon.getLaunchOptions());
      if (canceled) {
        return;
      }
      setLaunchOptions(nextLaunchOptions);

      void window.codophon
        .getAgentSkillStatus()
        .catch(() => defaultAgentSkillStatus)
        .then((status) => {
          if (!canceled) {
            setAgentSkillStatus(status);
          }
        });

      void window.codophon
        .getTerminalHelperStatus()
        .catch(() => defaultTerminalHelperStatus)
        .then((status) => {
          if (!canceled) {
            setTerminalHelperStatus(status);
          }
        });

      const nextState = await getRepositoryState(
        getReloadSourceForLaunch(reloadSelection, nextLaunchOptions),
      );

      if (canceled) {
        return;
      }

      if (
        nextState.files.some(
          (file) =>
            /\.md$/i.test(file.path) && (file.status === 'added' || file.status === 'untracked'),
        )
      ) {
        void preloadReviewMarkdown().catch(() => {});
      }
      const nextHistorySource: ReviewSource | null =
        getReloadHistorySource(reloadSelection, nextState) ??
        getHistorySource(nextState.source) ??
        null;
      const sourceRequest = sourceRequestRef.current;
      const filesPresent = nextState.files.length > 0;
      const reloadSelectedPath = getReloadSelectionPath(reloadSelection, nextState);
      const nextReloadDeltaPaths = getReloadDeltaPaths(reloadSelection, nextState);
      const reloadFilesChanged = haveReloadedFilesChanged(reloadSelection, nextState);
      // A pre-authored `--walkthrough-file` is an explicit request to open in
      // walkthrough mode, even without the `-w` flag. Treat it like `walkthrough`
      // so the file is actually loaded instead of being silently ignored.
      const walkthroughFilePath = nextLaunchOptions.walkthroughFile ?? null;
      const shouldLoadNarrative =
        (nextLaunchOptions.walkthrough || walkthroughFilePath != null) && filesPresent;
      const shouldStartInHistory =
        shouldStartInHistoryWhenEmpty(nextState.source) && nextState.files.length === 0;

      setLaunchOptions(nextLaunchOptions);
      setSidebarMode(
        shouldLoadNarrative ? 'walkthrough' : shouldStartInHistory ? 'history' : 'tree',
      );
      if (shouldLoadNarrative) {
        startWalkthroughLoading();
      } else {
        setWalkthroughLoading(false);
      }

      // Always consult the main process for a pre-authored walkthrough file, even
      // when the diff is empty, so it can diagnose *why* (e.g. the changes were
      // committed) rather than us guessing in the renderer.
      const shouldFetchNarrative = shouldLoadNarrative || walkthroughFilePath != null;
      const narrativePromise = shouldFetchNarrative
        ? reloadFilesChanged && walkthroughFilePath == null
          ? window.codophon.getNarrativeWalkthrough(nextState.source, { force: true })
          : window.codophon.getNarrativeWalkthrough(nextState.source)
        : null;
      // Publish the diff before history or walkthrough generation finishes.

      const restoreCommitView =
        getReloadMainMode(reloadSelection, nextState) === 'commit' &&
        nextState.source.type === 'working-tree' &&
        nextState.files.length > 0;
      if (restoreCommitView) {
        setSidebarMode('tree');
        setMainMode('commit');
      }

      sessionStore.install(nextState, {
        delta: nextReloadDeltaPaths,
        reason: 'launch',
        selectedPath: reloadSelectedPath,
      });
      setLoadError(null);
      resetCommentFocus();
      if (reloadSelectedPath) {
        scrollPathIntoReview(reloadSelectedPath, 'instant');
      }

      history.start(nextHistorySource);

      const narrativeResult = await narrativePromise;
      if (canceled) {
        return;
      }
      if (sourceRequestRef.current !== sourceRequest) {
        return;
      }
      const loadedNarrative =
        narrativeResult?.status === 'ready' ? narrativeResult.walkthrough : null;
      setNarrativeWalkthrough(loadedNarrative);

      if (narrativeResult?.status === 'unavailable') {
        setWalkthroughError(narrativeResult);
      } else {
        setWalkthroughError(null);
      }

      // When a walkthrough file was explicitly passed but did not anchor, drop
      // the reviewer into the history view and float a dismissible banner
      // explaining that the diff has moved on, rather than blocking with a modal.
      if (walkthroughFilePath != null && loadedNarrative == null) {
        setSidebarMode('history');
        setWalkthroughFileError({
          path: walkthroughFilePath,
          reason:
            narrativeResult?.status === 'unavailable'
              ? narrativeResult.reason
              : !filesPresent
                ? 'No changed files were found for this diff, so the walkthrough file has nothing to anchor to.'
                : 'The walkthrough file could not be loaded.',
        });
      } else {
        setWalkthroughFileError(null);
      }

      setWalkthroughLoading(false);
    };

    load().catch((error: unknown) => {
      if (canceled) {
        return;
      }

      setLoadError(getRepositoryLoadError(error));
      setWalkthroughLoading(false);
    });

    return () => {
      canceled = true;
      history.invalidate();
    };
  }, [
    history,
    getRepositoryState,
    initialLaunchOptions,
    sessionStore,
    resetCommentFocus,
    scrollPathIntoReview,
    setMainMode,
    setNarrativeWalkthrough,
    loadReviewComments,
    setSelectedPath,
    setSidebarMode,
    setWalkthroughError,
    setWalkthroughFileError,
    setWalkthroughLoading,
    startWalkthroughLoading,
  ]);

  useEffect(
    () =>
      window.codophon.onRepositoryChanged(() => {
        setLocalChangesDetected(true);
      }),
    [],
  );

  useEffect(() => {
    let canceled = false;

    window.codophon
      .getUpdateStatus()
      .then((status) => {
        if (!canceled) {
          setUpdateStatus(status);
        }
      })
      .catch(() => {});

    const unsubscribe = window.codophon.onUpdateStatusChanged(setUpdateStatus);
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let canceled = false;

    window.codophon
      .getGitIdentity()
      .then((identity) => {
        if (!canceled) {
          setGitIdentity(identity);
        }
      })
      .catch(() => {
        if (!canceled) {
          setGitIdentity(null);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!state || !supportsLazyDiffContent(state.source) || !selectedPath) {
      return;
    }

    const selectedFile = state.files.find((file) => file.path === selectedPath);
    if (!selectedFile) {
      return;
    }

    const loadableSections = selectedFile.sections.filter(shouldLoadDiffSectionContents);

    if (!loadableSections.length) {
      return;
    }

    for (const section of loadableSections) {
      loadDiffSection(selectedFile, section, state);
    }
  }, [loadDiffSection, selectedPath, state]);

  useEffect(() => {
    if (!state || !supportsDiffSearchContentPreload(state.source) || !diffSearchQuery.trim()) {
      return;
    }

    const requests = fileFilteredFiles.flatMap((file) =>
      file.sections.filter(shouldPreloadSectionContentsForSearch).map((section) => ({
        file,
        section,
      })),
    );

    if (!requests.length) {
      return;
    }

    let canceled = false;
    let cursor = 0;
    const sourceKey = getSourceKey(state.source);
    const stateGeneration = getGeneration();

    const loadNext = async (): Promise<void> => {
      if (canceled) {
        return;
      }

      const request = requests[cursor];
      cursor += 1;
      if (!request) {
        return;
      }

      const key = `${state.root}:${sourceKey}:${request.section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return loadNext();
      }

      loadingSectionKeysRef.current.add(key);

      try {
        const loadedSection = await window.codophon.getDiffSectionContent({
          force: true,
          kind: request.section.kind,
          path: request.file.path,
          showWhitespace: preferences.showWhitespace,
          source: state.source,
        });

        if (!canceled) {
          sessionStore.patchSection(stateGeneration, request.file.path, loadedSection);
        }
      } catch {
        if (!canceled) {
          sessionStore.patchSection(
            stateGeneration,
            request.file.path,
            getFailedSectionLoadState(request.section),
          );
        }
      } finally {
        loadingSectionKeysRef.current.delete(key);
      }

      return loadNext();
    };

    void Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => loadNext()));

    return () => {
      canceled = true;
    };
  }, [
    bumpItemVersion,
    diffSearchQuery,
    fileFilteredFiles,
    getGeneration,
    preferences.showWhitespace,
    sessionStore,
    state,
  ]);

  useEffect(() => {
    let canceled = false;

    if (!initialConfig) {
      window.codophon.getConfig().then(
        (nextConfig) => {
          if (!canceled) {
            const nextPreferences = nextConfig.settings;
            preferencesRef.current = nextPreferences;
            setCodophonConfig(nextConfig);

            setConfigLoaded(true);
          }
        },
        () => {
          if (!canceled) {
            setConfigLoaded(true);
          }
        },
      );
    }

    const removeConfigListener = window.codophon.onConfigChanged((nextConfig) => {
      const previousShowWhitespace = preferencesRef.current.showWhitespace;
      const nextPreferences = nextConfig.settings;
      preferencesRef.current = nextPreferences;
      setCodophonConfig(nextConfig);

      if (previousShowWhitespace === nextPreferences.showWhitespace) {
        return;
      }

      const currentState = getRepository();
      if (!currentState) {
        return;
      }

      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      // Invalidate in-flight section loads as soon as whitespace changes.
      sessionStore.invalidateSections();
      loadingSectionKeysRef.current.clear();
      setLoadingSectionIds(new Set());

      getRepositoryState(currentState.source)
        .then((nextState) => {
          if (sourceRequestRef.current !== request) {
            return;
          }

          sessionStore.install(nextState, { reason: 'whitespace' });
          setLoadError(null);
        })
        .catch((error: unknown) => {
          if (sourceRequestRef.current !== request) {
            return;
          }
          setLoadError(getRepositoryLoadError(error));
        });
    });

    return () => {
      canceled = true;
      removeConfigListener();
    };
  }, [
    getRepository,
    getRepositoryState,
    initialConfig,
    loadReviewComments,
    refreshWalkthroughForState,
    sessionStore,
    setReviewComments,
    setSelectedPath,
  ]);

  useDocumentAppearance({
    cleanupCodeFontProperties: true,
    clearEmptyCodeFontFamily: true,
    codeFontFamily: preferences.codeFontFamily,
    codeFontSize: preferences.codeFontSize,
    reviewTheme: preferences.reviewTheme,
    theme: preferences.theme,
  });

  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const removeListener = window.codophon.onCopyPendingCommentsRequest(() => {
      const currentState = getRepository();
      if (!currentState) {
        return '';
      }

      return buildReviewCommentsMarkdown(
        currentState.files,
        reviewCommentsRef.current,
        preferencesRef.current.showWhitespace,
        preferencesRef.current.reviewCommentsPrefix,
      );
    });
    return removeListener;
  }, [getRepository, reviewCommentsRef]);

  useEffect(() => {
    void window.codophon.isWindowFullScreen().then(setIsWindowFullScreen, () => {});
    return window.codophon.onWindowFullScreenChanged(setIsWindowFullScreen);
  }, []);

  const showOutdated = preferences.showOutdated;
  const diffStyle = preferences.diffStyle;
  const wordWrap = preferences.wordWrap;
  const visibleReviewComments = useMemo(
    () => getVisibleReviewComments(reviewComments, showOutdated),
    [reviewComments, showOutdated],
  );
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => !current);
  }, []);

  const toggleWordWrap = useCallback(() => {
    void window.codophon
      .updateSettings({ wordWrap: !preferencesRef.current.wordWrap })
      .catch(() => {});
  }, []);

  const expandSidebar = useCallback(() => {
    setSidebarCollapsed(false);
  }, []);

  const focusFileFilter = useCallback(() => {
    expandSidebar();
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.sidebar-search');
      input?.focus();
      input?.select();
    });
  }, [expandSidebar]);

  const openFile = useCallback((file: ChangedFile) => {
    // Deleted files are still shown in diffs, but there is no current file to open.
    if (file.status === 'deleted') {
      return;
    }

    void window.codophon.openFile(file.path).catch(() => {});
  }, []);

  const getReviewCommandTarget = useCallback(() => {
    const currentState = getRepository();
    if (!currentState) {
      return null;
    }

    return resolveReviewCommandTarget({
      activeTarget: activeReviewCommandTargetRef.current,
      files: currentState.files,
      selectedPath: sessionStore.getSnapshot().selectedPath,
      source: currentState.source,
      useActiveTarget:
        mainModeRef.current === 'review' &&
        sidebarModeRef.current === 'walkthrough' &&
        narrativeWalkthroughRef.current != null,
    });
  }, [
    activeReviewCommandTargetRef,
    getRepository,
    mainModeRef,
    narrativeWalkthroughRef,
    sessionStore,
    sidebarModeRef,
  ]);

  const openSelectedFile = useCallback(() => {
    const target = getReviewCommandTarget();

    if (target) {
      openFile(target.file);
    }
  }, [getReviewCommandTarget, openFile]);

  const shouldDeferHunkNavigation = useCallback(
    () => sidebarModeRef.current === 'walkthrough' && narrativeWalkthroughRef.current != null,
    [narrativeWalkthroughRef, sidebarModeRef],
  );
  const {
    closeCommandBar,
    closeShortcutsHelp,
    commandBarVisible,
    openCommandBar,
    openShortcutsHelp,
    shortcutsHelpOpen,
    shortcutsHelpVisible,
  } = useAppKeyboardShortcuts({
    keymap: codophonConfig.keymap,
    navigateHunks,
    onFocusFileFilter: focusFileFilter,
    onOpenDiffSearch: openDiffSearch,
    onOpenSelectedFile: openSelectedFile,
    onToggleSidebar: toggleSidebar,
    onToggleWordWrap: toggleWordWrap,
    shouldDeferHunkNavigation,
    sidebarCollapsed,
  });
  const commandButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => window.codophon.onFindInDiffs(openDiffSearch), [openDiffSearch]);

  const activatePath = useCallback(
    (path: string) => {
      setMainMode('review');
      setSelectedPath(path);
      scrollPathIntoReview(path, 'smooth');
    },
    [scrollPathIntoReview, setMainMode, setSelectedPath],
  );

  const navigateToAsk = useCallback(
    ({ filePath, lineNumber, reviewKey, reviewVersion, sectionId, side }: AskNotification) => {
      const current = getRepository();
      if (
        pendingSource ||
        !current ||
        getAskReviewKey(current) !== reviewKey ||
        getAskReviewVersion(current) !== reviewVersion
      ) {
        return;
      }
      const file = current.files.find(({ path }) => path === filePath);
      if (!file) {
        return;
      }
      changeSidebarMode('tree');
      setFileSearchQuery('');
      closeDiffSearch();
      toggleCollapsed(file, true);
      setSelectedPath(filePath);
      reviewMainRef.current?.focus({ preventScroll: true });
      setScrollTarget((previous) => ({
        anchor: { lineNumber, sectionId, side },
        behavior: 'smooth',
        path: filePath,
        request: (previous?.request ?? 0) + 1,
      }));
    },
    [
      changeSidebarMode,
      closeDiffSearch,
      getRepository,
      pendingSource,
      setSelectedPath,
      toggleCollapsed,
    ],
  );

  // Refresh local changes or the remote PR snapshot in place.
  // Unlike a window reload, this keeps all review UI state (selection, scroll,
  // search, walkthrough navigation, commit drafts, pending comments) and only
  // re-renders the files whose fingerprints actually moved.
  const refreshRepository = useCallback(async () => {
    const previousState = getRepository();
    if (!previousState || pendingSource || refreshInProgressRef.current) {
      return;
    }

    refreshInProgressRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    const request = sourceRequestRef.current + 1;
    sourceRequestRef.current = request;
    const refreshSource = getRefreshSource(previousState.source);
    try {
      const nextState = await getRepositoryState(refreshSource);
      if (sourceRequestRef.current !== request) {
        return;
      }

      // History must use the newly resolved PR snapshot, not its previous head/base.
      const acceptHistory = await history.prepareRefresh(nextState.source);
      if (sourceRequestRef.current !== request) {
        return;
      }

      sessionStore.install(nextState, { reason: 'refresh' });
      acceptHistory();
      if (
        mainModeRef.current === 'commit' &&
        (nextState.source.type !== 'working-tree' || nextState.files.length === 0)
      ) {
        setMainMode('review');
      }
      setLocalChangesDetected(false);
    } catch (error) {
      if (sourceRequestRef.current === request) {
        setRefreshError(getRepositoryLoadError(error).message);
      }
    } finally {
      refreshInProgressRef.current = false;
      setRefreshing(false);
    }
  }, [
    getRepository,
    getRepositoryState,
    history,
    mainModeRef,
    pendingSource,
    sessionStore,
    setMainMode,
  ]);

  // ⌘R / the View menu's "Refresh Changes" item route here from the main
  // process instead of reloading the window.
  useEffect(() => window.codophon.onRefreshRequest(refreshRepository), [refreshRepository]);

  useEffect(() => {
    const writeCurrentReloadSelection = () => {
      writeReloadSelection(
        getRepository(),
        sessionStore.getSnapshot().selectedPath,
        history.getSnapshot().source,
        mainModeRef.current,
      );
    };

    window.addEventListener('beforeunload', writeCurrentReloadSelection);
    return () => window.removeEventListener('beforeunload', writeCurrentReloadSelection);
  }, [getRepository, history, mainModeRef, sessionStore]);

  const selectSource = useCallback(
    (
      source: ReviewSource,
      { throwOnError = false }: { throwOnError?: boolean } = {},
    ): Promise<void> => {
      const currentState = getRepository();
      const sourceKey = getSourceKey(source);
      const currentDisplayKey = getSourceKey(pendingSource ?? currentState?.source ?? source);
      if (currentDisplayKey === sourceKey) {
        return Promise.resolve();
      }

      saveCurrentSourceSession();
      history.invalidate();
      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      setPendingSource(source);
      setAskHistory(null);
      setReviewBrief(null);
      setLoadError(null);
      setRefreshError(null);
      resetCommentFocus();

      resetDiffSearch();
      setScrollTarget(null);
      setMainMode('review');

      return getRepositoryState(source)
        .then((nextState) => {
          if (sourceRequestRef.current !== request) {
            return;
          }

          const session = sourceSessionsRef.current.get(getSourceKey(nextState.source));
          const sessionWalkthroughIsCurrent =
            session?.narrativeWalkthrough != null &&
            !haveChangedFiles(session.walkthroughFiles, nextState.files);
          const nextNarrativeWalkthrough = sessionWalkthroughIsCurrent
            ? (session?.narrativeWalkthrough ?? null)
            : null;

          sessionStore.install(nextState, { reason: 'switch', session });
          history.selectSource(nextState.source);
          setNarrativeWalkthrough(nextNarrativeWalkthrough);
          setWalkthroughError(
            sessionWalkthroughIsCurrent ? (session.walkthroughError ?? null) : null,
          );
          setWalkthroughLoading(false);
          setWalkthroughUnread(false);
          setLocalChangesDetected(false);
          setPendingSource(null);
          if (!sessionWalkthroughIsCurrent) {
            refreshWalkthroughForState(nextState, session?.narrativeWalkthrough ?? null);
          }
        })
        .catch((error: unknown) => {
          if (sourceRequestRef.current === request) {
            if (!throwOnError) {
              setLoadError(getRepositoryLoadError(error));
            }
            setWalkthroughLoading(false);
            setPendingSource(null);
          }
          if (throwOnError) {
            throw error;
          }
        });
    },
    [
      getRepository,
      getRepositoryState,
      history,
      pendingSource,
      refreshWalkthroughForState,
      resetCommentFocus,
      resetDiffSearch,
      saveCurrentSourceSession,
      sessionStore,
      setMainMode,
      setNarrativeWalkthrough,
      setWalkthroughError,
      setWalkthroughLoading,
      setWalkthroughUnread,
    ],
  );

  const openReviewSource = useCallback(
    async (kind: OpenReviewSourceKind, value: string) => {
      if (kind === 'pull-request') {
        const url = await window.codophon.resolvePullRequestUrl(value);
        await selectSource({ type: 'pull-request', url }, { throwOnError: true });
        return;
      }

      await selectSource(
        kind === 'branch'
          ? { ref: value, type: 'branch-working-tree' }
          : { ref: value, type: 'commit' },
        { throwOnError: true },
      );
    },
    [selectSource],
  );

  const showOpenReviewSourceDialog = useCallback((kind: OpenReviewSourceKind) => {
    setOpenReviewSourceKind(kind);
  }, []);
  const [agentSettings, setAgentSettings] = useState<AgentSettingsSection | null>(null);
  useEffect(() => window.codophon.onOpenAgentSettings?.(setAgentSettings), []);

  const openRepositoryFolder = useCallback(() => {
    void window.codophon.openRepositoryFolder().catch(() => {});
  }, []);

  useEffect(
    () => window.codophon.onOpenReviewSource(showOpenReviewSourceDialog),
    [showOpenReviewSourceDialog],
  );

  const changeReviewTheme = useCallback((reviewTheme: CodophonSettings['reviewTheme']) => {
    setReviewThemeError(null);
    void window.codophon.updateSettings({ reviewTheme }).catch((error: unknown) => {
      setReviewThemeError(getRepositoryLoadError(error).message);
    });
  }, []);

  const openReviewBrief = useCallback(() => {
    const current = getRepository();
    const source = current?.source;
    if (current && source?.type === 'pull-request') {
      setReviewBrief({
        notes: getReviewBriefQuestions({ root: current.root, source }, reviewCommentsRef.current),
        root: current.root,
        source,
      });
    }
  }, [getRepository, reviewCommentsRef]);
  const openAskHistory = useCallback(
    () => setAskHistory(getAskPR(getRepository())),
    [getRepository],
  );
  const commandBarCommands = useAppCommands({
    changeSidebarMode,
    focusFileFilter,
    getRepository,
    getReviewCommandTarget,
    getViewed,
    onOpenAgentSettings: setAgentSettings,
    onOpenAskHistory:
      !pendingSource && state?.source.type === 'pull-request' ? openAskHistory : null,
    onOpenDiffSearch: openDiffSearch,
    onOpenReviewBrief:
      !pendingSource && state?.source.type === 'pull-request' ? openReviewBrief : null,
    onOpenReviewSource: showOpenReviewSourceDialog,
    onOpenSelectedFile: openSelectedFile,
    onOpenShortcutsHelp: openShortcutsHelp,
    onRefreshRepository: refreshRepository,
    onSetReviewTheme: changeReviewTheme,
    onToggleSidebar: toggleSidebar,
    onToggleViewed: toggleViewed,
    onToggleWordWrap: toggleWordWrap,
    preferencesRef,
    reviewCommentsRef,
  });

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      const nextPath = getSelectedPathFromScroll(viewer, visibleFiles, showWhitespace);
      if (!nextPath) {
        return;
      }

      const programmaticScrollPath = programmaticScrollPathRef.current;
      if (programmaticScrollPath && nextPath !== programmaticScrollPath) {
        return;
      }

      if (programmaticScrollPath) {
        programmaticScrollPathRef.current = null;
        if (programmaticScrollTimerRef.current != null) {
          window.clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }

      setSelectedPath(nextPath);
    },
    [setSelectedPath, showWhitespace, visibleFiles],
  );

  const installTerminalHelper = useCallback(() => {
    setTerminalHelperInstalling(true);
    window.codophon
      .installTerminalHelper()
      .then((status) => setTerminalHelperStatus(status))
      .catch(() => {
        setTerminalHelperStatus(defaultTerminalHelperStatus);
      })
      .finally(() => {
        setTerminalHelperInstalling(false);
      });
  }, []);

  const installAgentSkill = useCallback(() => {
    setAgentSkillInstalling(true);
    window.codophon
      .installAgentSkill()
      .then((status) => setAgentSkillStatus(status))
      .catch(() => {
        setAgentSkillStatus(defaultAgentSkillStatus);
      })
      .finally(() => {
        setAgentSkillInstalling(false);
      });
  }, []);

  const activeAgentBackend = launchOptions.agentBackend ?? codophonConfig.settings.agentBackend;
  const showAgentUnavailablePanel =
    sidebarMode === 'walkthrough' &&
    !narrativeWalkthrough &&
    !walkthroughLoading &&
    isAgentNotFoundCode(walkthroughError?.code);
  const markInitialContentReady = useInitialWindowReveal(
    configLoaded &&
      Boolean(
        loadError ||
        (state &&
          (state.files.length === 0 ||
            visibleFiles.length === 0 ||
            showPlainCommitView ||
            showAgentUnavailablePanel ||
            showNarrativeWalkthrough)),
      ),
  );
  const agentLabel = getAgentLabel(activeAgentBackend);
  const agentSkillLabel = `${agentLabel} Skill`;
  const configuredModel = codophonConfig.settings.agents[activeAgentBackend].model;
  const settingsDialog = agentSettings ? (
    <AgentSettingsDialog
      backend={activeAgentBackend}
      configuredModel={configuredModel}
      initialSection={agentSettings}
      key={agentSettings}
      onClose={() => setAgentSettings(null)}
      overrides={codophonConfig.settings.agentPrompts}
    />
  ) : null;
  const withAgentSettings = (content: ReactNode) => (
    <>
      {content}
      {settingsDialog}
    </>
  );

  if (loadError) {
    const showFirstRun =
      loadError.kind === 'not-a-repository' &&
      !launchOptions.repositoryPathProvided &&
      !terminalHelperStatus.installed;

    return withAgentSettings(
      <main className="empty-state">
        <div className="empty-panel squircle">
          {showFirstRun ? (
            <FirstRunPanel
              agentSkillInstalled={agentSkillStatus.installed}
              agentSkillInstalling={agentSkillInstalling}
              agentSkillLabel={agentSkillLabel}
              installing={terminalHelperInstalling}
              onInstallAgentSkill={installAgentSkill}
              onInstallTerminalHelper={installTerminalHelper}
            />
          ) : (
            <RepositoryLoadErrorPanel error={loadError} />
          )}
        </div>
      </main>,
    );
  }

  if (!state || !configLoaded) {
    return withAgentSettings(
      <main className={`loading${launchOptions.walkthrough ? ' codex' : ' pulse'}`}>
        {launchOptions.walkthrough ? (
          <WalkthroughProgress
            phase={walkthroughProgress.phase}
            responseLabelIndex={walkthroughProgress.responseLabelIndex}
            stageRevision={walkthroughProgress.stageRevision}
          />
        ) : (
          <span className="startup-loading-message">Thinking…</span>
        )}
      </main>,
    );
  }

  const selectedOrSearchPath = activeDiffSearchMatch?.filePath ?? selectedPath;
  const visibleSelectedPath =
    selectedOrSearchPath && visibleFiles.some((file) => file.path === selectedOrSearchPath)
      ? selectedOrSearchPath
      : (visibleFiles[0]?.path ?? null);
  const isPullRequest = state.source.type === 'pull-request';
  const isSwitchingSource = pendingSource != null;

  const repositoryPathParts = splitRepositoryPath(state.root);
  const sidebarSourceLabel =
    state.source.type !== 'working-tree' ? getSourceLabel(state.source) : null;
  const pullRequestUrl = state.source.type === 'pull-request' ? state.source.url : null;
  const emptySourceDetail = getEmptySourceDetail(state.source, state.root);

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(preferences.codeFontSize),
  );
  const commitMetadata =
    state.source.type === 'commit' && state.commitMetadata
      ? (() => {
          const historyAvatarUrl = historyEntries.find(
            (entry) => entry.ref === state.commitMetadata?.ref,
          )?.gravatarUrl;
          return historyAvatarUrl
            ? {
                ...state.commitMetadata,
                author: {
                  ...state.commitMetadata.author,
                  gravatarUrl: historyAvatarUrl,
                },
              }
            : state.commitMetadata;
        })()
      : null;
  // Props shared by the full review and the per-stop scoped diffs, so the two
  // render paths can't drift apart.
  const commonReviewProps = {
    activeSearchMatch: activeDiffSearchMatch,
    codeEditingStore,
    collapsed,
    commentActions: {
      agentId: activeAgentBackend,
      agentLabel,
      focusCommentId,
      focusCommentRequest,
      identity: gitIdentity,
      onAskCodex: askCodex,
      onAskFollowUpDraftChange: updateAskFollowUpDraft,
      onCommentDraftChange: updateActiveReviewCommentDraft,
      onCreateComment: createComment,
      onDeleteComment: deleteComment,
      onSubmitComment: submitPullRequestComment,
      onUpdateComment: updateComment,
      supportsReviewCommentActions: isPullRequest,
    },
    comments: visibleReviewComments,
    commitMetadata,
    diffLineHeight,
    diffStyle,
    disableWorkerPool: disableCodeViewWorkerPool,
    expandedReviewKeys,
    expandUnchanged: preferences.expandUnchanged,
    hunkNavigation,
    itemVersionByKey,
    keymap: codophonConfig.keymap,
    loadingSectionIds,
    onFindDefinitions: window.codophon.findDefinitions,
    onLoadImageContent: window.codophon.getDiffImageContent,
    onLoadSection: loadDiffSection,
    onLoadSectionContents: loadDiffSectionContents,
    onOpenDefinition: (candidate: DefinitionCandidate) => {
      void window.codophon.openFile(candidate.path, candidate.lineNumber).catch(() => {});
    },
    onOpenFile: openFile,
    onReady: markInitialContentReady,
    onRefreshMarkdown: refreshMarkdownFile,
    onSelectPathFromScroll: updateSelectedPathFromScroll,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    renderMarkdownAs: preferences.renderMarkdownAs,
    searchQuery: diffSearchQuery,
    showWhitespace,
    source: state.source,
    sourceDescriptionActions: isPullRequest ? (
      <PullRequestReviewButtons
        disabled={pullRequestReviewSubmitting != null}
        hasPendingComments={hasPendingReviewComments}
        onSubmitReview={submitPullRequestReview}
        reviewStatus={state.source.type === 'pull-request' ? state.source.reviewStatus : undefined}
        showCommentReview={
          state.source.type === 'pull-request' &&
          (state.source.provider === 'github' ||
            state.source.provider === 'azure-devops' ||
            state.source.host === 'github.com' ||
            state.source.host === 'dev.azure.com')
        }
      />
    ) : undefined,
    theme: preferences.theme,
    viewed,
    wordWrap,
  };
  const renderWalkthroughDiffBlocks = (
    blocks: ReadonlyArray<ReviewDiffBlock>,
    blockScrollTarget: WalkthroughBlockScrollTarget | null,
    onActiveBlockChange: (blockId: string) => void,
  ) => {
    return (
      <WalkthroughDiffSurface
        blocks={blocks}
        forceExpandedPaths={diffSearchMatchPathSet}
        onActiveBlockChange={onActiveBlockChange}
        reviewProps={commonReviewProps}
        scrollTarget={blockScrollTarget}
      />
    );
  };
  const reviewModes = [
    {
      icon: <Path aria-hidden size={14} weight="bold" />,
      indicator: walkthroughUnread ? <span aria-hidden className="review-mode-dot" /> : undefined,
      label: 'Walkthrough',
      value: 'walkthrough',
    },
    {
      icon: <TreeStructure aria-hidden size={14} weight="bold" />,
      label: 'Tree',
      value: 'tree',
    },
    {
      icon: <ClockCounterClockwise aria-hidden size={14} weight="bold" />,
      label: 'History',
      value: 'history',
    },
  ] satisfies ReadonlyArray<ReviewModeItem<typeof sidebarMode>>;

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${
        isWindowFullScreen ? ' window-fullscreen' : ''
      }`}
      data-sidebar-position={preferences.sidebarPosition}
      style={
        sidebarCollapsed
          ? undefined
          : {
              gridTemplateColumns:
                preferences.sidebarPosition === 'right'
                  ? `minmax(0, 1fr) 0 ${sidebarWidth}px`
                  : `${sidebarWidth}px 0 minmax(0, 1fr)`,
            }
      }
    >
      <div aria-hidden className="window-drag-region" />
      <ReviewTopBar
        actions={
          <>
            <button
              aria-label="Open command palette"
              className="review-top-bar-icon-button review-top-bar-text-button"
              onClick={openCommandBar}
              ref={commandButtonRef}
              title={`Command palette (${getShortcutLabel(codophonConfig.keymap, 'commandBar')})`}
              type="button"
            >
              <MagnifyingGlass aria-hidden size={16} weight="bold" />
              Commands
            </button>
            {pullRequestUrl ? (
              <button
                aria-busy={refreshing}
                aria-label="Refresh pull request"
                className="review-top-bar-icon-button review-top-bar-text-button"
                disabled={refreshing || isSwitchingSource}
                onClick={refreshRepository}
                title="Refresh pull request from remote"
                type="button"
              >
                <ArrowClockwise aria-hidden size={16} weight="bold" />
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            ) : null}
            <CopyCommentsButton
              comments={isSwitchingSource ? emptyReviewComments : reviewComments}
              files={orderedFiles}
              reviewCommentsPrefix={preferences.reviewCommentsPrefix}
              showWhitespace={showWhitespace}
            />
          </>
        }
        context={
          <>
            {state.branch ? (
              <span className="review-top-bar-branch" title={state.branch}>
                {state.branch}
              </span>
            ) : null}
            {sidebarSourceLabel ? (
              pullRequestUrl ? (
                <a
                  className="review-top-bar-source"
                  href={pullRequestUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="review-top-bar-source-label">{sidebarSourceLabel}</span>
                  <ArrowSquareOut aria-hidden size={14} weight="bold" />
                </a>
              ) : (
                <span className="review-top-bar-source">
                  <span className="review-top-bar-source-label">{sidebarSourceLabel}</span>
                </span>
              )
            ) : null}
          </>
        }
        mode={sidebarMode}
        modes={reviewModes}
        onModeChange={changeSidebarMode}
        onToggleSidebar={toggleSidebar}
        repository={
          <span className="review-top-bar-repository review-top-bar-repository-path">
            <span className="review-top-bar-repository-head">{repositoryPathParts.head}</span>
            <span className="review-top-bar-repository-tail">{repositoryPathParts.tail}</span>
          </span>
        }
        repositoryTooltip={state.root}
        sidebarCollapsed={sidebarCollapsed}
        sidebarPosition={preferences.sidebarPosition}
        sourceMenu={
          <OpenReviewSourceMenu
            onOpen={showOpenReviewSourceDialog}
            onOpenFolder={openRepositoryFolder}
          />
        }
        toggleTitle={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${getShortcutLabel(
          codophonConfig.keymap,
          'toggleSidebar',
        )})`}
      />
      {reviewThemeError ? (
        <div className="repository-change-banner error visible" role="alert">
          <span className="repository-change-banner-content">
            Review theme change failed: {reviewThemeError}
          </span>
          <button onClick={() => setReviewThemeError(null)} type="button">
            Dismiss
          </button>
        </div>
      ) : null}
      {askCacheError ? (
        <div className="repository-change-banner error visible" role="alert">
          <span className="repository-change-banner-content">{askCacheError}</span>
        </div>
      ) : null}
      <RepositoryChangeBanner
        error={refreshError}
        onRefresh={refreshRepository}
        refreshing={refreshing}
        visible={
          localChangesDetected &&
          ((pendingSource ?? state.source).type === 'working-tree' ||
            (pendingSource ?? state.source).type === 'branch-working-tree')
        }
      />
      <WalkthroughOutdatedBanner
        onDismiss={() => setWalkthroughFileError(null)}
        reason={walkthroughFileError?.reason ?? null}
      />
      <DiffSearchPanel
        activeIndex={effectiveActiveDiffSearchMatchIndex}
        focusRequest={diffSearchFocusRequest}
        keymap={codophonConfig.keymap}
        matchCount={diffSearchMatches.length}
        onChange={updateDiffSearchQuery}
        onClose={closeDiffSearch}
        onNext={() => moveDiffSearchMatch(1)}
        onPrevious={() => moveDiffSearchMatch(-1)}
        query={diffSearchQuery}
        visible={diffSearchVisible}
      />
      <CommandBar
        commands={commandBarCommands}
        keymap={codophonConfig.keymap}
        onClose={closeCommandBar}
        visible={commandBarVisible}
      />
      {settingsDialog}
      {openReviewSourceKind ? (
        <OpenReviewSourceDialog
          kind={openReviewSourceKind}
          onClose={() => setOpenReviewSourceKind(null)}
          onOpen={(value) => openReviewSource(openReviewSourceKind, value)}
        />
      ) : null}
      {reviewBrief &&
      !isSwitchingSource &&
      reviewBrief.root === state.root &&
      state.source.type === 'pull-request' &&
      reviewBrief.source.url === state.source.url &&
      reviewBrief.source.headSha === state.source.headSha &&
      reviewBrief.source.baseSha === state.source.baseSha ? (
        <ReviewBriefDialog
          {...reviewBrief.notes}
          onClose={() => {
            setReviewBrief(null);
            commandButtonRef.current?.focus();
          }}
          source={reviewBrief.source}
        />
      ) : null}
      {askHistory && !isSwitchingSource ? (
        <AskHistoryDialog
          onClose={() => {
            setAskHistory(null);
            commandButtonRef.current?.focus();
          }}
          pr={askHistory}
        />
      ) : null}
      <KeyboardShortcutsHelp
        keymap={codophonConfig.keymap}
        onClose={() => {
          closeShortcutsHelp();
          commandButtonRef.current?.focus();
        }}
        open={shortcutsHelpOpen}
        visible={shortcutsHelpVisible}
      />
      <aside className="squircle sidebar">
        <Sidebar
          commitFiles={state.files}
          commitViewOpen={showPlainCommitView}
          currentSource={pendingSource ?? state.source}
          files={visibleFiles}
          history={history}
          keymap={codophonConfig.keymap}
          mode={sidebarMode}
          narrativeNavigation={narrativeNavigation}
          narrativeWalkthrough={narrativeWalkthrough}
          onActivatePath={activatePath}
          onSearchQueryChange={
            sidebarMode === 'history' ? setHistorySearchQuery : setFileSearchQuery
          }
          onSelectSource={selectSource}
          onToggleCommitView={showPlainCommitView ? closeCommitView : openCommitView}
          reloadDeltaPaths={reloadDeltaPaths}
          searchQuery={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
          selectedPath={visibleSelectedPath}
          showWhitespace={showWhitespace}
          summaryLoading={isSwitchingSource}
          viewed={viewed}
          walkthroughError={walkthroughError}
          walkthroughLoading={walkthroughLoading}
          walkthroughProgress={walkthroughProgress}
        />
        {updateStatus ? (
          <UpdatePill
            onDismiss={() => {
              window.codophon.dismissUpdate().then(setUpdateStatus, () => {});
            }}
            onInstall={() => {
              window.codophon.installUpdate().then(setUpdateStatus, () => {});
            }}
            status={updateStatus}
          />
        ) : null}
      </aside>
      <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />
      <main className="review" ref={reviewMainRef} tabIndex={-1}>
        {isSwitchingSource ? (
          <ReviewSourceLoading />
        ) : showPlainCommitView ? (
          <CommitView
            branch={state.branch}
            draft={narrativeNavigation}
            model={plainCommitModel}
            session={commitSession}
          />
        ) : showNarrativeWalkthrough && narrativeWalkthrough ? (
          <NarrativeWalkthroughView
            commitSession={commitSession}
            files={state.files}
            navigation={narrativeNavigation}
            onActiveReviewTargetChange={updateActiveWalkthroughReviewTarget}
            renderDiffBlocks={renderWalkthroughDiffBlocks}
            showWhitespace={showWhitespace}
            walkthrough={narrativeWalkthrough}
          />
        ) : showAgentUnavailablePanel ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <AgentUnavailablePanel
                agentLabel={agentLabel}
                onShowFiles={() => setSidebarMode('tree')}
                reason={walkthroughError?.reason}
              />
            </div>
          </div>
        ) : state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{getEmptySourceTitle(state.source)}</strong>
              {emptySourceDetail.kind === 'code' ? (
                <code className="walkthrough-inline-code" title={emptySourceDetail.title}>
                  {emptySourceDetail.text}
                </code>
              ) : (
                <span>{emptySourceDetail.text}</span>
              )}
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{hasDiffSearchQuery ? 'No matches in diffs' : 'No matching files'}</strong>
              <span>
                {diffSearchQuery ||
                  fileSearchQuery ||
                  (showWhitespace ? state.root : 'Whitespace-only changes hidden')}
              </span>
            </div>
          </div>
        ) : (
          <ReviewCodeView
            {...commonReviewProps}
            files={visibleFiles}
            forceExpandedPaths={diffSearchMatchPathSet}
            scrollTarget={scrollTarget}
            selectedPath={visibleSelectedPath}
          />
        )}
      </main>
      <AskNotifications
        notifications={isSwitchingSource ? [] : askNotifications}
        onDismiss={dismissAskNotification}
        onNavigate={navigateToAsk}
      />
    </div>
  );
}
