import './ReviewCodeView.css';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/PencilSimple';
import {
  type CodeViewLineSelection,
  type CodeViewItem,
  type CodeViewOptions,
  type CodeViewScrollTarget,
  type DiffLineAnnotation,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  type LineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs';
import {
  CodeView,
  type CodeViewHandle,
  EditProvider,
  WorkerPoolContextProvider,
} from '@pierre/diffs/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { getShortcutLabel, matchesShortcut } from '../../config/keymap.ts';
import type { CodophonDiffStyle, CodophonKeymap, CodophonSettings } from '../../config/types.ts';
import { EDIT_SELECTED_FILE_EVENT } from '../../lib/app-constants.ts';
import type {
  CodeViewInstance,
  CodeViewItemMetadata,
  DiffSearchMatch,
  ReviewAnnotationMetadata,
  ReviewComment,
  ReviewCommentAnnotationMetadata,
  ReviewIdentity,
  ReviewScrollBehavior,
  ReviewScrollTarget,
} from '../../lib/app-types.ts';
import {
  codeViewItemMetrics,
  codeViewLayout,
  codeViewUnsafeCSS,
  DEFAULT_PADDING,
  DIFF_LINE_HEIGHT,
  diffCollapsedContextThreshold,
  diffContextExpansionLineCount,
  getCodeViewWorkerPoolOptions,
  workerHighlighterOptions,
} from '../../lib/code-view-options.ts';
import {
  canRenderImagePreview,
  getDiffParseOptions,
  getItemId,
  getSectionForFileDiff,
  getVisibleDiffSections,
  isMarkdownFilePath,
  isPatchOnlyDiffSection,
  loadSectionContents,
  shouldLoadDiffSectionContents,
} from '../../lib/diff.ts';
import {
  applyIdentifierNavigationState,
  getIdentifierFromPointerEvent,
} from '../../lib/identifier-navigation.ts';
import { isNativeInputTarget, isPrimaryModifier } from '../../lib/keyboard.ts';
import {
  hasActiveTextSelection,
  isFileReviewComment,
  isInteractiveReviewEvent,
  isLineReviewComment,
  updateStickyHeaderState,
} from '../../lib/review-comments.ts';
import {
  buildReviewItems,
  createFileReviewBlocks,
  groupReviewCommentsBySection,
  isEditableWorkingTreeSection,
  isPreviewSection,
  lineIsVisibleInFileDiff,
  resolveRenderedSearchMatch,
  type ReviewDiffBlock,
  type SectionMode,
} from '../../lib/review-items.ts';
import { applySearchHighlights } from '../../lib/search-highlights.ts';
import { getSourceKey } from '../../lib/source.ts';
import type {
  ChangedFile,
  CommitMetadata,
  DefinitionCandidate,
  DefinitionSearchRequest,
  DefinitionSearchResult,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  ReviewSource,
} from '../../types.ts';
import {
  createCodeEditor,
  useCodeEditing,
  type CodeEditingStore,
} from '../hooks/useCodeEditing.ts';
import { useCodeViewAnnotations } from '../hooks/useCodeViewAnnotations.ts';
import { useCodeViewPlaceholderFile } from '../hooks/useCodeViewPlaceholderFile.ts';
import { Button } from './Button.tsx';
import { DefinitionPopover } from './DefinitionPopover.tsx';
import type { MarkdownDocumentEditorHandle } from './MarkdownDocumentEditor.tsx';
export type { ReviewDiffBlock } from '../../lib/review-items.ts';
import { ImageDiffPreview } from './ImageDiffPreview.tsx';
import {
  ReviewCommentsContext,
  ReviewAnnotation,
  type ReviewCommentActions,
} from './ReviewComments.tsx';
import { FileEditButton, CodeViewHeader } from './ReviewFileHeader.tsx';
import { MarkdownPreview } from './ReviewMarkdown.tsx';
import { getSourceDescription, SourceDescription } from './SourceDescription.tsx';
export { preloadReviewMarkdown } from './ReviewMarkdown.tsx';
const emptyExpandedReviewKeys = new Set<string>();
const scrollTargetRetryFrameLimit = 90;

const getEffectiveScrollBehavior = (behavior: ReviewScrollBehavior) =>
  behavior === 'smooth' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : behavior;

type HunkNavigationRequest = {
  direction: 1 | -1;
  request: number;
};

// A jumpable, selectable position (a hunk or a review comment) with its
// estimated absolute Y. The dominant term is the item's real top from
// getTopForItem; only the within-item line offset is estimated, so cross-item
// ordering stays exact. `selection` is the line range highlighted while the
// anchor is the active nav target (null for collapsed/preview header anchors).
type NavAnchor = {
  itemId: string;
  key: string;
  scrollTarget: CodeViewScrollTarget;
  selection: SelectedLineRange | null;
  top: number;
};

// Estimate the rendered row index of a file line inside a diff item so comment
// anchors sort against hunk anchors within the same item.
const estimateRenderedLineIndex = (
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: 'additions' | 'deletions',
  diffStyle: CodophonDiffStyle,
): number => {
  for (const hunk of fileDiff.hunks) {
    const start = side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
    const count = side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
    if (lineNumber < start || lineNumber >= start + count) {
      continue;
    }

    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;
    let splitLineIndex = hunk.splitLineStart;
    let unifiedLineIndex = hunk.unifiedLineStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        const currentLineNumber = side === 'deletions' ? deletionLineNumber : additionLineNumber;
        if (lineNumber < currentLineNumber + content.lines) {
          const difference = lineNumber - currentLineNumber;
          return (diffStyle === 'split' ? splitLineIndex : unifiedLineIndex) + difference;
        }

        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        splitLineIndex += content.lines;
        unifiedLineIndex += content.lines;
        continue;
      }

      const sideCount = side === 'deletions' ? content.deletions : content.additions;
      const currentLineNumber = side === 'deletions' ? deletionLineNumber : additionLineNumber;
      if (lineNumber < currentLineNumber + sideCount) {
        const difference = lineNumber - currentLineNumber;
        return (
          (diffStyle === 'split'
            ? splitLineIndex
            : unifiedLineIndex + (side === 'additions' ? content.deletions : 0)) + difference
        );
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
      splitLineIndex += Math.max(content.deletions, content.additions);
      unifiedLineIndex += content.deletions + content.additions;
    }
  }
  return 0;
};

const isInteractiveKeyboardTarget = (target: EventTarget | null) => {
  const candidate = target as
    | (EventTarget & {
        closest?: (selector: string) => Element | null;
        isContentEditable?: boolean;
      })
    | null;

  return (
    isNativeInputTarget(target) ||
    candidate?.closest?.(
      [
        'a[href]',
        'area[href]',
        'button',
        'summary',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '[role="option"]',
        '[role="radio"]',
        '[role="slider"]',
        '[role="switch"]',
        '[role="tab"]',
      ].join(', '),
    ) != null ||
    candidate?.isContentEditable === true
  );
};

// The span of changed lines in a hunk — the green/red bit, excluding the
// surrounding context — so navigating highlights just the change. Prefers the
// additions side; falls back to deletions for pure-deletion hunks.
const getHunkSelectionRange = (
  hunk: FileDiffMetadata['hunks'][number],
): SelectedLineRange | null => {
  const side: 'additions' | 'deletions' | null =
    hunk.additionLines > 0 ? 'additions' : hunk.deletionLines > 0 ? 'deletions' : null;
  if (!side) {
    return null;
  }

  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;
  let start: number | null = null;
  let end: number | null = null;

  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      additionLine += content.lines;
      deletionLine += content.lines;
      continue;
    }

    const changed = side === 'additions' ? content.additions : content.deletions;
    if (changed > 0) {
      const blockStart = side === 'additions' ? additionLine : deletionLine;
      start = start ?? blockStart;
      end = blockStart + changed - 1;
    }
    additionLine += content.additions;
    deletionLine += content.deletions;
  }

  return start != null && end != null ? { end, endSide: side, side, start } : null;
};

const isSameSelection = (a: SelectedLineRange, b: SelectedLineRange) =>
  a.start === b.start && a.end === b.end && a.side === b.side;

export function ReviewCodeView({
  activeSearchMatch,
  blocks,

  bottomInset = codeViewLayout.paddingBottom,
  codeEditingStore,
  collapsed,
  commentActions,
  comments,
  commitMetadata,
  diffLineHeight = DIFF_LINE_HEIGHT,
  diffStyle,
  disableWorkerPool = false,
  expandedReviewKeys = emptyExpandedReviewKeys,
  expandUnchanged = false,
  files,
  forceExpandedPaths,
  hunkNavigation,

  itemVersionByKey,
  keymap,
  loadingSectionIds,
  onActiveBlockChange,
  onFindDefinitions,
  onLoadImageContent,
  onLoadSection,
  onLoadSectionContents,
  onOpenDefinition,
  onOpenFile,
  onReady,
  onRefreshMarkdown,
  onSelectPathFromScroll,
  onToggleCollapsed,
  onToggleViewed,
  renderMarkdownAs = 'preview',
  scrollTarget,
  searchQuery,
  selectedPath,
  showSourceDescription = true,
  showWhitespace,
  source,
  sourceDescriptionActions,
  sourceDescriptionFooter,
  theme = 'system',
  viewed,
  wordWrap,
}: {
  activeSearchMatch: DiffSearchMatch | null;
  blocks?: ReadonlyArray<ReviewDiffBlock>;

  bottomInset?: number;
  codeEditingStore?: CodeEditingStore;
  collapsed: ReadonlySet<string>;
  commentActions: ReviewCommentActions;
  comments: ReadonlyArray<ReviewComment>;
  commitMetadata: CommitMetadata | null;
  diffLineHeight?: number;
  diffStyle: CodophonDiffStyle;
  disableWorkerPool?: boolean;
  expandedReviewKeys?: ReadonlySet<string>;
  expandUnchanged?: boolean;
  files: ReadonlyArray<ChangedFile>;
  forceExpandedPaths: ReadonlySet<string>;
  hunkNavigation: HunkNavigationRequest | null;

  itemVersionByKey: Readonly<Record<string, number>>;
  keymap: CodophonKeymap;
  loadingSectionIds: ReadonlySet<string>;
  onActiveBlockChange?: (blockId: string) => void;
  onFindDefinitions?: (request: DefinitionSearchRequest) => Promise<DefinitionSearchResult>;
  onLoadImageContent?: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onLoadSectionContents?: (file: ChangedFile, section: DiffSection) => Promise<FileDiffLoadedFiles>;
  onOpenDefinition?: (candidate: DefinitionCandidate) => void;
  onOpenFile?: (file: ChangedFile) => void;
  onReady?: () => void;
  onRefreshMarkdown?: (file: ChangedFile, section: DiffSection) => Promise<boolean>;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean, reviewKey: string) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => void;
  renderMarkdownAs?: CodophonSettings['renderMarkdownAs'];
  scrollTarget: ReviewScrollTarget | null;
  searchQuery: string;
  selectedPath: string | null;
  showSourceDescription?: boolean;
  showWhitespace: boolean;
  source: ReviewSource;
  sourceDescriptionActions?: ReactNode;
  sourceDescriptionFooter?: ReactNode;
  theme?: CodophonSettings['theme'];
  viewed: Record<string, string>;
  wordWrap: boolean;
}) {
  const { onCommentDraftChange, onCreateComment, onDeleteComment } = commentActions;
  const codeViewRef = useRef<CodeViewHandle<ReviewAnnotationMetadata, undefined>>(null);
  const [codeViewElement, setCodeViewElement] = useState<HTMLDivElement | null>(null);
  const [compactHeaders, setCompactHeaders] = useState(false);
  useLayoutEffect(() => {
    if (!codeViewElement) {
      return;
    }
    const measure = () => {
      const width = codeViewElement.getBoundingClientRect().width;
      if (width > 0) {
        setCompactHeaders(width <= 760);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(codeViewElement);
    return () => observer.disconnect();
  }, [codeViewElement]);
  const headerHeight = compactHeaders ? 90 : codeViewItemMetrics.diffHeaderHeight;
  const itemMetrics = useMemo(
    () => ({ ...codeViewItemMetrics, diffHeaderHeight: headerHeight }),
    [headerHeight],
  );
  const codeViewStyle = { '--codophon-file-header-height': `${headerHeight}px` } as CSSProperties;

  const getPlaceholderFile = useCodeViewPlaceholderFile();
  const getAnnotations = useCodeViewAnnotations();
  const [markdownPreviewHeights] = useState(() => new Map<string, number>());
  const markdownEditorRefs = useRef(new Map<string, MarkdownDocumentEditorHandle>());
  const refreshingMarkdownSectionsRef = useRef(new Set<string>());
  const deferredTimersRef = useRef<Set<number>>(new Set());
  const handledScrollRequestRef = useRef<number | null>(null);
  const handledHunkNavRef = useRef<number | null>(hunkNavigation?.request ?? null);
  const emptyCommentDeleteTimersRef = useRef<Map<string, number>>(new Map());
  const activePointerIdsRef = useRef(new Set<number>());
  const pendingCommentBlursRef = useRef(new Map<string, () => void>());
  const pendingCommentBlurTimerRef = useRef<number | null>(null);
  const focusedCommentEditorIdRef = useRef<string | null>(null);
  const definitionHighlightFrameRef = useRef<number | null>(null);
  const highlightFrameRef = useRef<number | null>(null);
  const lastScrolledSearchMatchRef = useRef<{ itemId: string; match: DiffSearchMatch } | null>(
    null,
  );
  const ignoreNextLineSelectionEndRef = useRef(false);
  const navigatedSelectionRef = useRef<CodeViewLineSelection | null>(null);
  const [sectionModes, setSectionModes] = useState<ReadonlyMap<string, SectionMode>>(
    () => new Map(),
  );
  const setSectionMode = useCallback((id: string, mode: SectionMode) => {
    setSectionModes((current) => new Map(current).set(id, mode));
  }, []);
  const [markdownContentsVersion, setMarkdownContentsVersion] = useState(0);
  const loadingMarkdownPreviews = useRef(new WeakSet<FileDiffMetadata>());
  const pendingMarkdownSourceRef = useRef<{
    lineNumber: number;
    sectionId: string;
    side: 'additions' | 'deletions';
    sourceKey: string;
  } | null>(null);
  // Remeasure only after the preview's actual content height changes. Mounting
  // a loading placeholder must not invalidate a recycled document's layout.
  const [markdownPreviewLayoutPassBySection, setMarkdownPreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [imagePreviewLayoutPassBySection, setImagePreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [commentLayoutPassByItem, setCommentLayoutPassByItem] = useState<
    Readonly<Record<string, number>>
  >({});
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [definitionLookup, setDefinitionLookup] = useState<{
    anchor: { x: number; y: number };
    identifier: string;
    result: DefinitionSearchResult | null;
    sourceKey: string;
  } | null>(null);
  const definitionLookupRequestRef = useRef(0);
  const definitionModifierActiveRef = useRef(false);
  const sourceKey = getSourceKey(source);
  const [definitionLookupSourceKey, setDefinitionLookupSourceKey] = useState(sourceKey);
  if (definitionLookupSourceKey !== sourceKey) {
    setDefinitionLookupSourceKey(sourceKey);
    setDefinitionLookup(null);
  }
  const selectedLinesRef = useRef<CodeViewLineSelection | null>(null);
  const details = useMemo(
    () => getSourceDescription(source, commitMetadata, showSourceDescription),
    [source, commitMetadata, showSourceDescription],
  );
  const sourceDescriptionItemId = details?.sourceDescriptionItemId;
  const stickyHeaderFrameRef = useRef<number | null>(null);

  const reviewBlocks = useMemo(() => blocks ?? createFileReviewBlocks(files), [blocks, files]);
  const commentLookup = useMemo(() => {
    const map = new Map<string, ReviewComment>();
    for (const comment of comments) {
      map.set(comment.id, comment);
    }
    for (const block of reviewBlocks) {
      if (!block.file) {
        continue;
      }
      for (const comment of block.comments ?? []) {
        map.set(comment.id, comment);
      }
    }
    return map;
  }, [comments, reviewBlocks]);
  const commentsBySection = useMemo(() => groupReviewCommentsBySection(comments), [comments]);

  const markMarkdownPreviewLayoutReady = useCallback((sectionId: string) => {
    setMarkdownPreviewLayoutPassBySection((current) => ({
      ...current,
      [sectionId]: (current[sectionId] ?? 0) + 1,
    }));
  }, []);

  const markImagePreviewLayoutReady = useCallback((sectionId: string) => {
    setImagePreviewLayoutPassBySection((current) => ({
      ...current,
      [sectionId]: (current[sectionId] ?? 0) + 1,
    }));
  }, []);

  const markCommentLayoutChanged = useCallback((itemId: string) => {
    setCommentLayoutPassByItem((current) => ({
      ...current,
      [itemId]: (current[itemId] ?? 0) + 1,
    }));
  }, []);

  const {
    commentTargetById,
    firstItemByBlockId,
    firstItemByPath,
    itemBlockId,
    itemMetadata,
    items,
    searchTargetsByBaseItemId,
    selectedHeaderItemIds,
  } = useMemo(() => {
    return buildReviewItems({
      collapsed,
      commentLayoutPassByItem,
      commentsBySection,
      diffLineHeight,
      diffStyle,
      expandedReviewKeys,
      forceExpandedPaths,
      getAnnotations,
      getPlaceholderFile,
      imagePreviewLayoutPassBySection,
      itemVersionByKey,
      markdownContentsVersion,
      markdownPreviewLayoutPassBySection,
      renderMarkdownAs,
      reviewBlocks,
      sectionModes,
      selectedPath,
      showWhitespace,
      sourceType: source.type,
      supportsImages: onLoadImageContent != null,
      viewed,
    });
  }, [
    collapsed,
    commentLayoutPassByItem,
    commentsBySection,
    diffLineHeight,
    diffStyle,
    expandedReviewKeys,
    forceExpandedPaths,
    getAnnotations,
    getPlaceholderFile,
    imagePreviewLayoutPassBySection,

    itemVersionByKey,
    markdownPreviewLayoutPassBySection,
    sectionModes,
    markdownContentsVersion,
    onLoadImageContent,
    renderMarkdownAs,
    reviewBlocks,
    selectedPath,
    showWhitespace,
    source.type,
    viewed,
  ]);

  const codeViewItems = useMemo<ReadonlyArray<CodeViewItem<ReviewAnnotationMetadata>>>(() => {
    if (items.length > 0 || !sourceDescriptionItemId) {
      return items;
    }

    return [
      {
        collapsed: true,
        file: getPlaceholderFile(
          source.type === 'commit' ? 'commit-message.md' : 'source-description.md',
          '',
        ),
        id: sourceDescriptionItemId,
        type: 'file',
      },
    ];
  }, [getPlaceholderFile, items, source.type, sourceDescriptionItemId]);

  const highlightedCodeItems = codeViewItems.filter(
    (item) => itemMetadata.get(item.id)?.isSelected,
  );
  const selectedCodeItemId =
    highlightedCodeItems.find(
      (item) =>
        item.id === selectedLines?.id && itemMetadata.get(item.id)?.section.kind === 'unstaged',
    )?.id ??
    highlightedCodeItems.find((item) => itemMetadata.get(item.id)?.section.kind === 'unstaged')
      ?.id ??
    highlightedCodeItems[0]?.id;
  const codeEditing = useCodeEditing({
    codeViewRef,
    items: codeViewItems,
    keymap,
    onLoadSectionContents,
    onRefresh: onRefreshMarkdown,
    selectedItemId: selectedCodeItemId,
    sourceKey,
    store: codeEditingStore,
  });

  const canEditCodeItem = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>, meta: CodeViewItemMetadata | undefined) =>
      meta != null &&
      item.type === 'diff' &&
      !meta.section.binary &&
      (meta.section.loadState == null ||
        meta.section.loadState === 'ready' ||
        meta.section.loadState === 'deferred') &&
      !meta.isMarkdownPreview &&
      meta.section.kind === 'unstaged' &&
      isEditableWorkingTreeSection(source.type, meta.file, meta.section) &&
      onLoadSectionContents != null &&
      window.codophon?.getRepositoryFile != null,
    [onLoadSectionContents, source.type],
  );
  const startFileEdit = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>, meta: CodeViewItemMetadata) => {
      if (meta.isCollapsed) {
        onToggleCollapsed(meta.file, true, meta.reviewIdentity.key);
      }
      if (meta.canEditMarkdown && meta.isMarkdownPreview) {
        setSectionMode(meta.section.id, { kind: 'edit' });
        return;
      }
      if (isMarkdownFilePath(meta.file.path)) {
        setSectionMode(meta.section.id, { kind: 'diff' });
      }
      void codeEditing.startEdit(item, meta);
    },
    [codeEditing, onToggleCollapsed, setSectionMode],
  );
  const editAfterExpandRef = useRef<{ path: string; sourceKey: string } | null>(null);
  useEffect(() => {
    const pending = editAfterExpandRef.current;
    if (!pending) {
      return;
    }
    if (
      pending.sourceKey !== sourceKey ||
      !highlightedCodeItems.some((item) => itemMetadata.get(item.id)?.file.path === pending.path)
    ) {
      editAfterExpandRef.current = null;
      return;
    }
    const item = highlightedCodeItems.find((candidate) => {
      const meta = itemMetadata.get(candidate.id);
      return meta?.file.path === pending.path && canEditCodeItem(candidate, meta);
    });
    const meta = item && itemMetadata.get(item.id);
    if (item && meta) {
      editAfterExpandRef.current = null;
      startFileEdit(item, meta);
    }
  }, [canEditCodeItem, highlightedCodeItems, itemMetadata, sourceKey, startFileEdit]);

  useEffect(() => {
    /** Enter edit mode for the highlighted file. Returns whether it handled the request. */
    const editSelectedFile = () => {
      const item = codeViewItems.find((candidate) => candidate.id === selectedCodeItemId);
      const meta = item && itemMetadata.get(item.id);
      if (!item || !meta || !codeEditing.canStartEdit(item.id, meta.file.path)) {
        return false;
      }
      if (!(meta.canEditMarkdown && meta.isMarkdownPreview) && !canEditCodeItem(item, meta)) {
        // Collapsed files render only their first section, which may be staged.
        // Expand first so editing uses the actual unstaged item and its annotations.
        if (
          !meta.isCollapsed ||
          !getVisibleDiffSections(meta.file, showWhitespace).some(({ fileDiff, section }) =>
            canEditCodeItem({ fileDiff, id: item.id, type: 'diff' }, { ...meta, section }),
          )
        ) {
          return false;
        }
        editAfterExpandRef.current = { path: meta.file.path, sourceKey };
        onToggleCollapsed(meta.file, true, meta.reviewIdentity.key);
        return true;
      }
      startFileEdit(item, meta);
      return true;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.repeat &&
        !event.isComposing &&
        !isNativeInputTarget(event.target) &&
        matchesShortcut(event, keymap, 'editFile') &&
        editSelectedFile()
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(EDIT_SELECTED_FILE_EVENT, editSelectedFile);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(EDIT_SELECTED_FILE_EVENT, editSelectedFile);
    };
  }, [
    canEditCodeItem,
    codeEditing,
    codeViewItems,
    itemMetadata,
    keymap,
    onToggleCollapsed,
    selectedCodeItemId,
    showWhitespace,
    sourceKey,
    startFileEdit,
  ]);

  const clearCommentLineHighlight = useCallback(() => {
    codeViewRef.current?.clearSelectedLines();
    navigatedSelectionRef.current = null;
    setSelectedLines(null);
  }, []);

  const resolvedActiveSearchMatch = useMemo(
    () => resolveRenderedSearchMatch(activeSearchMatch, itemMetadata, searchTargetsByBaseItemId),
    [activeSearchMatch, itemMetadata, searchTargetsByBaseItemId],
  );
  const getDefinitionDiffTarget = useCallback(
    (candidate: DefinitionCandidate) => {
      for (const item of items) {
        if (item.type !== 'diff') {
          continue;
        }
        const metadata = itemMetadata.get(item.id);
        const path =
          candidate.side === 'deletions'
            ? (metadata?.file.oldPath ?? metadata?.file.path)
            : metadata?.file.path;
        if (
          metadata &&
          path === candidate.path &&
          lineIsVisibleInFileDiff(item.fileDiff, candidate.side, candidate.lineNumber)
        ) {
          return { item, metadata };
        }
      }
      return null;
    },
    [itemMetadata, items],
  );

  const setCodeViewSelectedLines = useCallback((selection: CodeViewLineSelection | null) => {
    if (
      selection == null ||
      navigatedSelectionRef.current == null ||
      selection.id !== navigatedSelectionRef.current.id ||
      !isSameSelection(selection.range, navigatedSelectionRef.current.range)
    ) {
      navigatedSelectionRef.current = null;
    }
    setSelectedLines(selection);
  }, []);

  const deferCommentLineHighlightClear = useCallback(() => {
    const timer = window.setTimeout(() => {
      deferredTimersRef.current.delete(timer);
      clearCommentLineHighlight();
    }, 0);
    deferredTimersRef.current.add(timer);
  }, [clearCommentLineHighlight]);

  const cancelPendingEmptyCommentDeletes = useCallback(() => {
    for (const timer of emptyCommentDeleteTimersRef.current.values()) {
      window.clearTimeout(timer);
      deferredTimersRef.current.delete(timer);
    }
    emptyCommentDeleteTimersRef.current.clear();
  }, []);

  const flushPendingCommentBlurs = useCallback(() => {
    if (activePointerIdsRef.current.size > 0) {
      return;
    }

    const callbacks = [...pendingCommentBlursRef.current.values()];
    pendingCommentBlursRef.current.clear();
    for (const callback of callbacks) {
      callback();
    }
  }, []);

  const schedulePendingCommentBlurFlush = useCallback(() => {
    if (
      activePointerIdsRef.current.size > 0 ||
      pendingCommentBlursRef.current.size === 0 ||
      pendingCommentBlurTimerRef.current != null
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      deferredTimersRef.current.delete(timer);
      pendingCommentBlurTimerRef.current = null;
      flushPendingCommentBlurs();
    }, 0);
    pendingCommentBlurTimerRef.current = timer;
    deferredTimersRef.current.add(timer);
  }, [flushPendingCommentBlurs]);

  useEffect(() => {
    const activePointerIds = activePointerIdsRef.current;
    const deferredTimers = deferredTimersRef.current;
    const pendingCommentBlurs = pendingCommentBlursRef.current;
    const handlePointerDown = (event: PointerEvent) => {
      const timer = pendingCommentBlurTimerRef.current;
      if (timer != null) {
        window.clearTimeout(timer);
        deferredTimers.delete(timer);
        pendingCommentBlurTimerRef.current = null;
      }
      activePointerIds.add(event.pointerId);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      activePointerIds.delete(event.pointerId);
      schedulePendingCommentBlurFlush();
    };
    const handleWindowBlur = () => {
      activePointerIds.clear();
      schedulePendingCommentBlurFlush();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointercancel', handlePointerEnd, true);
    window.addEventListener('pointerup', handlePointerEnd, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointercancel', handlePointerEnd, true);
      window.removeEventListener('pointerup', handlePointerEnd, true);
      window.removeEventListener('blur', handleWindowBlur);
      activePointerIds.clear();
      pendingCommentBlurs.clear();
      const timer = pendingCommentBlurTimerRef.current;
      if (timer != null) {
        window.clearTimeout(timer);
        deferredTimers.delete(timer);
        pendingCommentBlurTimerRef.current = null;
      }
    };
  }, [schedulePendingCommentBlurFlush]);

  const deferCommentBlurUntilPointerEnd = useCallback((commentId: string, callback: () => void) => {
    if (activePointerIdsRef.current.size > 0 || pendingCommentBlurTimerRef.current != null) {
      pendingCommentBlursRef.current.set(commentId, callback);
    } else {
      callback();
    }
  }, []);

  const scrollFileItemToTop = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return;
    }

    handle.scrollTo({
      behavior: 'smooth-auto',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });
  }, []);

  const canCreateFileComments =
    source.type === 'pull-request' && source.provider === 'azure-devops';

  const createFileComment = useCallback(
    (meta: CodeViewItemMetadata, itemId: string) => {
      if (!canCreateFileComments) {
        return;
      }

      cancelPendingEmptyCommentDeletes();
      scrollFileItemToTop(itemId);
      if (meta.isCollapsed) {
        onToggleCollapsed(meta.file, true, meta.reviewIdentity.key);
      }
      if (meta.isMarkdownPreview) {
        setSectionMode(meta.section.id, { kind: 'diff' });
      }
      onCreateComment({
        anchor: 'file',
        filePath: meta.file.path,
        sectionId: meta.section.id,
      });
      clearCommentLineHighlight();
    },
    [
      canCreateFileComments,
      cancelPendingEmptyCommentDeletes,
      clearCommentLineHighlight,
      onCreateComment,
      onToggleCollapsed,
      scrollFileItemToTop,
      setSectionMode,
    ],
  );

  const createCommentForRange = useCallback(
    (
      range: CodeViewLineSelection['range'],
      context: { item: CodeViewItem<ReviewAnnotationMetadata> },
    ) => {
      if (context.item.type !== 'diff') {
        return;
      }

      const meta = itemMetadata.get(context.item.id);
      if (!meta || meta.isCollapsed) {
        return;
      }

      const startSide = range.side ?? range.endSide ?? 'additions';
      const endSide = range.endSide ?? startSide;
      if (startSide !== endSide) {
        window.alert('Review comments cannot span added and deleted lines.');
        return;
      }

      const start = Math.min(range.start, range.end);
      const end = Math.max(range.start, range.end);
      cancelPendingEmptyCommentDeletes();
      onCreateComment({
        filePath: meta.file.path,
        lineNumber: end,
        sectionId: meta.section.id,
        side: endSide,
        ...(end !== start ? { startLineNumber: start } : {}),
      });
      deferCommentLineHighlightClear();
    },
    [
      cancelPendingEmptyCommentDeletes,
      deferCommentLineHighlightClear,

      itemMetadata,
      onCreateComment,
    ],
  );

  // Lets the library fetch full file contents when the user expands unchanged
  // context on a patch-only diff; the partial FileDiffMetadata is hydrated in
  // place (see `parseSectionDiffWithOptions` for the identity contract).
  const loadDiffFiles = useMemo(() => {
    if (!onLoadSectionContents) {
      return undefined;
    }

    return (fileDiff: FileDiffMetadata) => {
      const target = getSectionForFileDiff(fileDiff);
      if (!target) {
        return Promise.reject(
          new Error(`No loadable diff section registered for '${fileDiff.name}'.`),
        );
      }

      return loadSectionContents(target.file, target.section, onLoadSectionContents);
    };
  }, [onLoadSectionContents]);

  const codeViewOptions: CodeViewOptions<ReviewAnnotationMetadata, undefined> = useMemo(
    () =>
      ({
        collapsedContextThreshold: diffCollapsedContextThreshold,
        diffIndicators: 'bars',
        diffStyle,
        enableGutterUtility: true,
        enableLineSelection: true,
        expandUnchanged: expandUnchanged && loadDiffFiles != null,
        expansionLineCount: diffContextExpansionLineCount,
        hunkSeparators: 'line-info-basic',
        itemMetrics,
        layout: {
          ...codeViewLayout,
          paddingBottom: bottomInset,
        },
        lineDiffType: workerHighlighterOptions.lineDiffType,
        lineHoverHighlight: 'both',
        loadDiffFiles,
        maxLineDiffLength: workerHighlighterOptions.maxLineDiffLength,
        onGutterUtilityClick: (range, context) => {
          if (context.item.edit) {
            return;
          }
          ignoreNextLineSelectionEndRef.current = context.item.type === 'diff';
          createCommentForRange(range, context);
        },
        onLineClick: (line, context) => {
          if (context.item.edit) {
            return;
          }
          const lineElement = 'lineElement' in line ? line.lineElement : null;
          const isDefinitionNavigation = isPrimaryModifier(line.event);
          if (isDefinitionNavigation && onFindDefinitions) {
            line.event.preventDefault();
            line.event.stopPropagation();
            const identifier = lineElement
              ? getIdentifierFromPointerEvent(line.event, lineElement)
              : null;
            const meta = itemMetadata.get(context.item.id);
            const side = 'annotationSide' in line ? line.annotationSide : null;
            if (!identifier || !meta || !side) {
              setDefinitionLookup(null);
              return;
            }
            const requestId = ++definitionLookupRequestRef.current;
            setDefinitionLookup({
              anchor: { x: line.event.clientX, y: line.event.clientY },
              identifier,
              result: null,
              sourceKey,
            });
            void onFindDefinitions({
              identifier,
              kind: meta.section.kind,
              lineNumber: line.lineNumber,
              path: side === 'deletions' ? (meta.file.oldPath ?? meta.file.path) : meta.file.path,
              side,
              source,
            })
              .then((result) => {
                if (definitionLookupRequestRef.current === requestId) {
                  setDefinitionLookup((current) =>
                    current?.identifier === identifier && current.sourceKey === sourceKey
                      ? { ...current, result }
                      : current,
                  );
                }
              })
              .catch(() => {
                if (definitionLookupRequestRef.current === requestId) {
                  setDefinitionLookup((current) =>
                    current?.identifier === identifier && current.sourceKey === sourceKey
                      ? {
                          ...current,
                          result: {
                            reason: 'Definition search is unavailable for this repository.',
                            status: 'unavailable',
                          },
                        }
                      : current,
                  );
                }
              });
            return;
          }
          if (isInteractiveReviewEvent(line.event)) {
            return;
          }

          const meta = itemMetadata.get(context.item.id);
          if (!meta || meta.isCollapsed) {
            return;
          }

          if (shouldLoadDiffSectionContents(meta.section)) {
            onLoadSection(meta.file, meta.section);
            return;
          }

          if (hasActiveTextSelection(lineElement)) {
            return;
          }

          const side = 'annotationSide' in line ? line.annotationSide : null;
          if (!side) {
            return;
          }

          cancelPendingEmptyCommentDeletes();
          onCreateComment({
            filePath: meta.file.path,
            lineNumber: line.lineNumber,
            sectionId: meta.section.id,
            side,
          });
        },
        onLineSelectionEnd: (range, context) => {
          if (context.item.edit) {
            return;
          }
          if (ignoreNextLineSelectionEndRef.current) {
            ignoreNextLineSelectionEndRef.current = false;
            return;
          }

          if (!range) {
            return;
          }

          createCommentForRange(range, context);
        },
        onPostRender: (node, _instance, phase, context) => {
          if (phase !== 'unmount') {
            onReady?.();
          }
          const metadata = itemMetadata.get(context.item.id);
          // Load full Markdown once an item reaches the viewport so diffs can offer a preview.
          // Fetching every document before startup defeats CodeView's virtualization.
          if (
            phase !== 'unmount' &&
            onLoadSectionContents &&
            context.item.type === 'diff' &&
            metadata &&
            !metadata.isCollapsed &&
            isMarkdownFilePath(metadata.file.path) &&
            isPatchOnlyDiffSection(metadata.section) &&
            metadata.section.summary?.canLoad !== false &&
            !loadingMarkdownPreviews.current.has(context.item.fileDiff)
          ) {
            loadingMarkdownPreviews.current.add(context.item.fileDiff);
            // Retry a failed load once; if it fails again, the file stays a text diff.
            const load = () =>
              loadSectionContents(metadata.file, metadata.section, onLoadSectionContents);
            void load()
              .catch(() => load())
              .then(() => setMarkdownContentsVersion((version) => version + 1))
              .catch(() => {});
          }
          const isWalkthroughHeaderItem = context.item.id.endsWith(':walkthrough-header');
          node.classList.toggle('codophon-walkthrough-header-item', isWalkthroughHeaderItem);
          node.classList.toggle(
            'codophon-selected-item',
            metadata?.isSelected === true || selectedHeaderItemIds.has(context.item.id),
          );
          node.classList.toggle(
            'codophon-markdown-preview-item',
            metadata?.isMarkdownPreview === true,
          );
          node.classList.toggle(
            'codophon-image-preview-item',
            context.item.type === 'file' &&
              Boolean(metadata && canRenderImagePreview(metadata.file.path, metadata.section)),
          );
          node.classList.toggle(
            'codophon-loadable-summary-item',
            !context.item.edit &&
              metadata != null &&
              shouldLoadDiffSectionContents(metadata.section),
          );
          node.classList.toggle(
            'codophon-loading-summary-item',
            Boolean(metadata && loadingSectionIds.has(metadata.section.id)),
          );
          if (definitionModifierActiveRef.current) {
            window.requestAnimationFrame(() => {
              if (
                definitionModifierActiveRef.current &&
                node.isConnected &&
                !codeViewRef.current?.getItem(context.item.id)?.edit
              ) {
                applyIdentifierNavigationState([{ element: node }], true);
              }
            });
          }
        },
        overflow: wordWrap ? 'wrap' : 'scroll',
        parseDiffOptions: getDiffParseOptions(showWhitespace),
        preferredHighlighter: workerHighlighterOptions.preferredHighlighter,
        stickyHeaders: true,
        theme: {
          dark: 'Dunkel',
          light: 'Licht',
        },
        themeType: theme,
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
        useTokenTransformer: workerHighlighterOptions.useTokenTransformer,
      }) satisfies CodeViewOptions<ReviewAnnotationMetadata, undefined>,
    [
      bottomInset,
      cancelPendingEmptyCommentDeletes,
      createCommentForRange,
      diffStyle,
      expandUnchanged,

      itemMetadata,
      itemMetrics,
      loadDiffFiles,
      loadingSectionIds,
      onCreateComment,
      onFindDefinitions,
      onLoadSection,
      onLoadSectionContents,
      onReady,
      selectedHeaderItemIds,
      showWhitespace,
      source,
      sourceKey,
      theme,
      wordWrap,
    ],
  );

  const focusComment = useCallback(
    (comment: ReviewComment) => {
      focusedCommentEditorIdRef.current = comment.id;
      pendingCommentBlursRef.current.delete(comment.id);
      onCommentDraftChange?.({ body: comment.body, id: comment.id });
      const timer = emptyCommentDeleteTimersRef.current.get(comment.id);
      if (timer == null) {
        return;
      }

      window.clearTimeout(timer);
      deferredTimersRef.current.delete(timer);
      emptyCommentDeleteTimersRef.current.delete(comment.id);
    },
    [onCommentDraftChange],
  );

  const blurComment = useCallback(
    (comment: ReviewComment, body: string, flushDraft: () => void) => {
      deferCommentBlurUntilPointerEnd(comment.id, () => {
        if (focusedCommentEditorIdRef.current === comment.id) {
          focusedCommentEditorIdRef.current = null;
          onCommentDraftChange?.(null);
        }
        flushDraft();
        clearCommentLineHighlight();
        if (!comment.isReadOnly && body.trim().length === 0) {
          const existingTimer = emptyCommentDeleteTimersRef.current.get(comment.id);
          if (existingTimer != null) {
            window.clearTimeout(existingTimer);
            deferredTimersRef.current.delete(existingTimer);
          }

          const timer = window.setTimeout(() => {
            deferredTimersRef.current.delete(timer);
            emptyCommentDeleteTimersRef.current.delete(comment.id);
            onDeleteComment(comment.id);
          }, 120);
          deferredTimersRef.current.add(timer);
          emptyCommentDeleteTimersRef.current.set(comment.id, timer);
        }
      });
    },
    [
      clearCommentLineHighlight,
      deferCommentBlurUntilPointerEnd,
      onCommentDraftChange,
      onDeleteComment,
    ],
  );

  const replyToThread = useCallback(
    (threadId: string, comment: ReviewComment) => {
      clearCommentLineHighlight();
      cancelPendingEmptyCommentDeletes();
      onCreateComment({
        ...(isFileReviewComment(comment) ? { anchor: 'file' as const } : {}),
        filePath: comment.filePath,
        ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
        sectionId: comment.sectionId,
        ...(comment.side ? { side: comment.side } : {}),
        ...(comment.startLineNumber != null ? { startLineNumber: comment.startLineNumber } : {}),
        ...(comment.startSide ? { startSide: comment.startSide } : {}),
        threadId,
      });
    },
    [cancelPendingEmptyCommentDeletes, clearCommentLineHighlight, onCreateComment],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      clearCommentLineHighlight();
      onDeleteComment(commentId);
    },
    [clearCommentLineHighlight, onDeleteComment],
  );

  const setMarkdownEditorRef = useCallback(
    (sectionId: string, editor: MarkdownDocumentEditorHandle | null) => {
      if (editor) {
        markdownEditorRefs.current.set(sectionId, editor);
      } else {
        markdownEditorRefs.current.delete(sectionId);
      }
    },
    [],
  );

  const finishMarkdownEdit = useCallback(
    async (meta: CodeViewItemMetadata) => {
      const sectionId = meta.section.id;
      setSectionMode(sectionId, { finishing: true, kind: 'edit' });
      try {
        const editor = markdownEditorRefs.current.get(sectionId);
        if (
          (editor && !(await editor.flush())) ||
          (onRefreshMarkdown && !(await onRefreshMarkdown(meta.file, meta.section)))
        ) {
          setSectionMode(sectionId, { kind: 'edit' });
          return;
        }
        setSectionMode(sectionId, { kind: 'preview' });
      } catch (error: unknown) {
        setSectionMode(sectionId, {
          error: error instanceof Error ? error.message : String(error),
          kind: 'edit',
        });
      }
    },
    [onRefreshMarkdown, setSectionMode],
  );

  const toggleMarkdownPreview = useCallback(
    async (file: ChangedFile, section: DiffSection) => {
      clearCommentLineHighlight();
      if (
        isPreviewSection(sectionModes.get(section.id), renderMarkdownAs) &&
        isEditableWorkingTreeSection(source.type, file, section)
      ) {
        if (refreshingMarkdownSectionsRef.current.has(section.id)) {
          return;
        }
        refreshingMarkdownSectionsRef.current.add(section.id);
        try {
          const editor = markdownEditorRefs.current.get(section.id);
          if (editor && !(await editor.flush())) {
            return;
          }
          if (editor && onRefreshMarkdown && !(await onRefreshMarkdown(file, section))) {
            return;
          }
        } finally {
          refreshingMarkdownSectionsRef.current.delete(section.id);
        }
      }
      setSectionMode(section.id, {
        kind: isPreviewSection(sectionModes.get(section.id), renderMarkdownAs) ? 'diff' : 'preview',
      });
    },
    [
      clearCommentLineHighlight,
      sectionModes,
      setSectionMode,
      onRefreshMarkdown,
      renderMarkdownAs,
      source.type,
    ],
  );

  useEffect(() => {
    const target = pendingMarkdownSourceRef.current;
    if (!target) {
      return;
    }
    if (target.sourceKey !== sourceKey) {
      pendingMarkdownSourceRef.current = null;
      return;
    }
    const item = items.find(
      (item) => item.type === 'diff' && itemMetadata.get(item.id)?.section.id === target.sectionId,
    );
    if (!item) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      codeViewRef.current?.scrollTo({
        align: 'center',
        behavior: 'instant',
        id: item.id,
        lineNumber: target.lineNumber,
        side: target.side,
        type: 'line',
      });
      pendingMarkdownSourceRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [itemMetadata, items, sourceKey]);

  const workerPoolOptions = useMemo(() => getCodeViewWorkerPoolOptions(), []);

  const requestScrollTargetIntoView = useCallback(
    (
      itemId: string,
      behavior: ReviewScrollBehavior = 'instant',
      commentTarget?: {
        lineNumber?: number;
        side?: 'additions' | 'deletions';
      },
    ) => {
      const handle = codeViewRef.current;
      const viewer = handle?.getInstance();
      if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
        return false;
      }

      handle.scrollTo(
        commentTarget?.lineNumber != null && commentTarget.side
          ? {
              align: 'center',
              behavior: getEffectiveScrollBehavior(behavior),
              id: itemId,
              lineNumber: commentTarget.lineNumber,
              offset: DEFAULT_PADDING,
              side: commentTarget.side,
              type: 'line',
            }
          : {
              behavior: getEffectiveScrollBehavior(behavior),
              id: itemId,
              offset: DEFAULT_PADDING,
              type: 'item',
            },
      );

      return true;
    },
    [],
  );

  useLayoutEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    const behavior = scrollTarget.behavior ?? 'instant';
    const commentTarget = scrollTarget.commentId
      ? commentTargetById.get(scrollTarget.commentId)
      : undefined;
    const anchor = scrollTarget.anchor;
    const anchorItem = anchor
      ? searchTargetsByBaseItemId
          .get(getItemId({ id: anchor.sectionId }))
          ?.find(
            ({ itemId, path }) =>
              path === scrollTarget.path &&
              (!scrollTarget.blockId || itemBlockId.get(itemId) === scrollTarget.blockId),
          )
      : undefined;
    const lineTarget =
      commentTarget ??
      (anchorItem &&
      anchor?.lineNumber != null &&
      anchor.side &&
      lineIsVisibleInFileDiff(anchorItem.fileDiff, anchor.side, anchor.lineNumber)
        ? anchor
        : undefined);
    const itemId =
      commentTarget?.id ??
      anchorItem?.itemId ??
      (scrollTarget.blockId
        ? firstItemByBlockId.get(scrollTarget.blockId)
        : scrollTarget.path
          ? firstItemByPath.get(scrollTarget.path)
          : null);
    if (!itemId) {
      return;
    }
    const meta = itemMetadata.get(itemId);
    if (anchorItem && meta?.isCollapsed) {
      const frame = requestAnimationFrame(() =>
        onToggleCollapsed(meta.file, true, meta.reviewIdentity.key),
      );
      return () => cancelAnimationFrame(frame);
    }
    if (lineTarget?.lineNumber != null && meta?.isMarkdownPreview) {
      const frame = requestAnimationFrame(
        () => void toggleMarkdownPreview(meta.file, meta.section),
      );
      return () => cancelAnimationFrame(frame);
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      if (requestScrollTargetIntoView(itemId, behavior, lineTarget)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (attempts < scrollTargetRetryFrameLimit) {
        attempts += 1;
        frame = window.requestAnimationFrame(tryScroll);
      }
    };

    tryScroll();

    return () => {
      canceled = true;
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [
    commentTargetById,
    firstItemByBlockId,
    firstItemByPath,
    itemBlockId,
    itemMetadata,
    onToggleCollapsed,
    requestScrollTargetIntoView,
    scrollTarget,
    searchTargetsByBaseItemId,
    toggleMarkdownPreview,
  ]);

  useEffect(() => {
    selectedLinesRef.current = selectedLines;
  }, [selectedLines]);

  useEffect(() => {
    if (!hunkNavigation || handledHunkNavRef.current === hunkNavigation.request) {
      return;
    }

    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer) {
      return;
    }

    handledHunkNavRef.current = hunkNavigation.request;

    const anchors: Array<NavAnchor> = [];
    const seen = new Set<string>();
    const lineScrollTarget = (
      id: string,
      lineNumber: number,
      side: 'additions' | 'deletions',
    ): CodeViewScrollTarget => ({
      align: 'center',
      behavior: 'smooth-auto',
      id,
      lineNumber,
      offset: DEFAULT_PADDING,
      side,
      type: 'line',
    });
    const push = (anchor: NavAnchor) => {
      if (seen.has(anchor.key)) {
        return;
      }
      seen.add(anchor.key);
      anchors.push(anchor);
    };

    for (const item of items) {
      const itemTop = viewer.getTopForItem(item.id);
      if (itemTop == null) {
        continue;
      }

      const meta = itemMetadata.get(item.id);
      if (meta?.isMarkdownPreview && !meta.isCollapsed && codeViewElement) {
        const preview = [
          ...codeViewElement.querySelectorAll<HTMLElement>('[data-codophon-markdown-item]'),
        ].find((element) => element.dataset.codophonMarkdownItem === item.id);
        const changes = preview?.querySelectorAll<HTMLElement>('[data-markdown-change]');
        if (changes?.length) {
          for (const [index, change] of [...changes].entries()) {
            const position = Math.max(
              0,
              viewer.getScrollTop() +
                change.getBoundingClientRect().top -
                codeViewElement.getBoundingClientRect().top -
                headerHeight -
                DEFAULT_PADDING,
            );
            push({
              itemId: item.id,
              key: `markdown:${item.id}:${index}`,
              scrollTarget: { behavior: 'smooth-auto', position, type: 'position' },
              selection: null,
              top: position,
            });
          }
          continue;
        }
      }
      // Collapsed files and non-diff previews (markdown/image) jump to the header.
      if (!meta || meta.isCollapsed || item.type !== 'diff') {
        push({
          itemId: item.id,
          key: `item:${item.id}`,
          scrollTarget: {
            align: 'start',
            behavior: 'smooth-auto',
            id: item.id,
            offset: DEFAULT_PADDING,
            type: 'item',
          },
          selection: null,
          top: itemTop,
        });
        continue;
      }

      // Collect this item's hunks and comments, then order them by rendered row
      // so navigation matches what's on screen. `items` is already in visual
      // order, so structural order (item order, then row order) is exactly
      // top-to-bottom — and stable across keypresses, unlike sorting by the
      // estimated absolute top, which shifts as items measure.
      const headerTop = itemTop + headerHeight;
      const entries: Array<{ anchor: NavAnchor; renderedIndex: number }> = [];
      const addLineEntry = (
        lineNumber: number,
        side: 'additions' | 'deletions',
        selection: SelectedLineRange,
      ) => {
        const renderedIndex = estimateRenderedLineIndex(item.fileDiff, lineNumber, side, diffStyle);
        entries.push({
          anchor: {
            itemId: item.id,
            key: `line:${item.id}:${side}:${lineNumber}`,
            scrollTarget: lineScrollTarget(item.id, lineNumber, side),
            selection,
            top: headerTop + renderedIndex * diffLineHeight,
          },
          renderedIndex,
        });
      };

      for (const hunk of item.fileDiff.hunks) {
        const selection = getHunkSelectionRange(hunk);
        const side = selection?.side ?? (hunk.additionLines > 0 ? 'additions' : 'deletions');
        const lineNumber =
          selection?.start ?? (side === 'additions' ? hunk.additionStart : hunk.deletionStart);
        addLineEntry(
          lineNumber,
          side,
          selection ?? { end: lineNumber, endSide: side, side, start: lineNumber },
        );
      }

      for (const comment of meta.comments) {
        if (!isLineReviewComment(comment)) {
          push({
            itemId: item.id,
            key: `file-comment:${item.id}:${comment.id}`,
            scrollTarget: {
              align: 'start',
              behavior: 'smooth-auto',
              id: item.id,
              offset: DEFAULT_PADDING,
              type: 'item',
            },
            selection: null,
            top: itemTop,
          });
        } else {
          addLineEntry(comment.lineNumber, comment.side, {
            end: comment.lineNumber,
            endSide: comment.side,
            side: comment.side,
            start: comment.lineNumber,
          });
        }
      }

      entries.sort((a, b) => a.renderedIndex - b.renderedIndex);
      for (const entry of entries) {
        push(entry.anchor);
      }
    }

    if (!anchors.length) {
      return;
    }

    // Treat the current line selection as the active anchor so j/k step one hunk
    // at a time from it. A selection the user made (e.g. dragging to comment)
    // won't match any anchor, so we fall back to seeding from the scroll offset.
    const current = selectedLinesRef.current;
    const activeIndex = current
      ? anchors.findIndex(
          (anchor) =>
            anchor.selection != null &&
            anchor.itemId === current.id &&
            isSameSelection(anchor.selection, current.range),
        )
      : -1;

    let targetIndex: number;
    if (activeIndex !== -1) {
      targetIndex = Math.min(
        Math.max(activeIndex + hunkNavigation.direction, 0),
        anchors.length - 1,
      );
    } else {
      const baseTop = viewer.getScrollTop() + DEFAULT_PADDING;
      const epsilon = 4;
      if (hunkNavigation.direction === 1) {
        const found = anchors.findIndex((anchor) => anchor.top > baseTop + epsilon);
        targetIndex = found === -1 ? anchors.length - 1 : found;
      } else {
        targetIndex = 0;
        for (let index = anchors.length - 1; index >= 0; index -= 1) {
          if (anchors[index].top < baseTop - epsilon) {
            targetIndex = index;
            break;
          }
        }
      }
    }

    const target = anchors[targetIndex];
    if (!target) {
      return;
    }

    if (target.selection) {
      const nextSelection = { id: target.itemId, range: target.selection };
      navigatedSelectionRef.current = nextSelection;
      setSelectedLines(nextSelection);
    } else {
      clearCommentLineHighlight();
    }
    handle.scrollTo(target.scrollTarget);
  }, [
    clearCommentLineHighlight,
    codeViewElement,
    diffLineHeight,
    diffStyle,
    headerHeight,
    hunkNavigation,
    itemMetadata,
    items,
  ]);

  // Enter on a navigated hunk starts a review comment on its selection and moves
  // focus into the new comment input.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Enter' ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        isInteractiveKeyboardTarget(event.target)
      ) {
        return;
      }

      const selection = selectedLinesRef.current;
      if (
        !selection ||
        navigatedSelectionRef.current == null ||
        selection.id !== navigatedSelectionRef.current.id ||
        !isSameSelection(selection.range, navigatedSelectionRef.current.range)
      ) {
        return;
      }

      const item = items.find((candidate) => candidate.id === selection.id);
      if (!item) {
        return;
      }

      event.preventDefault();
      createCommentForRange(selection.range, { item });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [createCommentForRange, items]);

  const scheduleSearchHighlights = useCallback(() => {
    const viewer = codeViewRef.current?.getInstance();
    if (!viewer) {
      return;
    }

    if (highlightFrameRef.current != null) {
      window.cancelAnimationFrame(highlightFrameRef.current);
    }

    highlightFrameRef.current = window.requestAnimationFrame(() => {
      highlightFrameRef.current = null;
      applySearchHighlights(
        viewer.getRenderedItems().filter(({ item }) => !item.edit),
        searchQuery,
        resolvedActiveSearchMatch,
      );
    });
  }, [resolvedActiveSearchMatch, searchQuery]);

  const updateRenderedIdentifierNavigation = useCallback(
    (active: boolean, viewer?: CodeViewInstance) => {
      const nextViewer = viewer ?? codeViewRef.current?.getInstance();
      if (!nextViewer) {
        return;
      }
      if (definitionHighlightFrameRef.current != null) {
        window.cancelAnimationFrame(definitionHighlightFrameRef.current);
        definitionHighlightFrameRef.current = null;
      }
      if (!active) {
        applyIdentifierNavigationState(
          nextViewer.getRenderedItems().filter(({ item }) => !item.edit),
          false,
        );
        return;
      }
      definitionHighlightFrameRef.current = window.requestAnimationFrame(() => {
        definitionHighlightFrameRef.current = null;
        applyIdentifierNavigationState(
          nextViewer.getRenderedItems().filter(({ item }) => !item.edit),
          true,
        );
      });
    },
    [],
  );

  const scheduleStickyHeaderStateUpdate = useCallback((viewer?: CodeViewInstance) => {
    const nextViewer = viewer ?? codeViewRef.current?.getInstance();
    if (!nextViewer) {
      return;
    }

    if (stickyHeaderFrameRef.current != null) {
      window.cancelAnimationFrame(stickyHeaderFrameRef.current);
    }

    stickyHeaderFrameRef.current = window.requestAnimationFrame(() => {
      stickyHeaderFrameRef.current = null;
      updateStickyHeaderState(nextViewer);
    });
  }, []);

  useEffect(
    () => () => {
      for (const timer of deferredTimersRef.current) {
        window.clearTimeout(timer);
      }
      deferredTimersRef.current.clear();
      emptyCommentDeleteTimersRef.current.clear();
      if (definitionHighlightFrameRef.current != null) {
        window.cancelAnimationFrame(definitionHighlightFrameRef.current);
      }
      if (highlightFrameRef.current != null) {
        window.cancelAnimationFrame(highlightFrameRef.current);
      }
      if (stickyHeaderFrameRef.current != null) {
        window.cancelAnimationFrame(stickyHeaderFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    scheduleSearchHighlights();
    scheduleStickyHeaderStateUpdate();
  }, [items, scheduleSearchHighlights, scheduleStickyHeaderStateUpdate]);

  useEffect(() => {
    if (!onFindDefinitions) {
      return;
    }

    let pointerDown = false;
    const updateDefinitionModifierState = (active: boolean) => {
      if (definitionModifierActiveRef.current === active) {
        return;
      }
      definitionModifierActiveRef.current = active;
      updateRenderedIdentifierNavigation(active);
    };
    const handleModifierChange = (event: KeyboardEvent) => {
      updateDefinitionModifierState(isPrimaryModifier(event) && !pointerDown);
    };
    const handleModifierPointer = (event: PointerEvent) => {
      pointerDown = (event.buttons & 1) !== 0;
      updateDefinitionModifierState(isPrimaryModifier(event) && !pointerDown);
    };
    const handleSelectionChange = () => {
      // A selection can start or clear without the modifier changing.
      updateRenderedIdentifierNavigation(definitionModifierActiveRef.current);
    };
    const clearDefinitionModifierState = () => {
      pointerDown = false;
      updateDefinitionModifierState(false);
    };

    window.addEventListener('keydown', handleModifierChange);
    window.addEventListener('keyup', handleModifierChange);
    window.addEventListener('pointerdown', handleModifierPointer);
    window.addEventListener('pointermove', handleModifierPointer);
    window.addEventListener('pointerup', handleModifierPointer);
    window.addEventListener('pointercancel', clearDefinitionModifierState);
    window.addEventListener('blur', clearDefinitionModifierState);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      clearDefinitionModifierState();
      window.removeEventListener('keydown', handleModifierChange);
      window.removeEventListener('keyup', handleModifierChange);
      window.removeEventListener('pointerdown', handleModifierPointer);
      window.removeEventListener('pointermove', handleModifierPointer);
      window.removeEventListener('pointerup', handleModifierPointer);
      window.removeEventListener('pointercancel', clearDefinitionModifierState);
      window.removeEventListener('blur', clearDefinitionModifierState);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [onFindDefinitions, updateRenderedIdentifierNavigation]);

  const invalidateDefinitionLookup = useCallback(() => {
    definitionLookupRequestRef.current++;
  }, []);
  useEffect(() => invalidateDefinitionLookup, [invalidateDefinitionLookup]);

  useEffect(() => {
    if (!activeSearchMatch) {
      lastScrolledSearchMatchRef.current = null;
      return;
    }

    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || !resolvedActiveSearchMatch) {
      return;
    }
    const meta = itemMetadata.get(resolvedActiveSearchMatch.itemId);
    if (resolvedActiveSearchMatch.lineNumber != null && meta?.isMarkdownPreview) {
      const frame = requestAnimationFrame(
        () => void toggleMarkdownPreview(meta.file, meta.section),
      );
      return () => cancelAnimationFrame(frame);
    }

    // Walkthrough blocks re-resolve the match into a fresh object whenever the
    // rendered items change, e.g. when opening a comment. Only scroll when the
    // active match itself or its rendered item changes, so editing the diff
    // while searching does not yank the view back to the match.
    const lastScrolledSearchMatch = lastScrolledSearchMatchRef.current;
    if (
      lastScrolledSearchMatch?.match === activeSearchMatch &&
      lastScrolledSearchMatch.itemId === resolvedActiveSearchMatch.itemId
    ) {
      scheduleSearchHighlights();
      return;
    }
    lastScrolledSearchMatchRef.current = {
      itemId: resolvedActiveSearchMatch.itemId,
      match: activeSearchMatch,
    };

    if (resolvedActiveSearchMatch.lineNumber == null) {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: resolvedActiveSearchMatch.itemId,
        type: 'item',
      });
    } else {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: resolvedActiveSearchMatch.itemId,
        lineNumber: resolvedActiveSearchMatch.lineNumber,
        offset: DEFAULT_PADDING,
        side: resolvedActiveSearchMatch.side,
        type: 'line',
      });
    }

    scheduleSearchHighlights();
  }, [
    activeSearchMatch,
    itemMetadata,
    resolvedActiveSearchMatch,
    scheduleSearchHighlights,
    toggleMarkdownPreview,
  ]);

  // Rendered as a non-virtualized element at the top of the CodeView scroll
  // content. Height changes (async markdown layout, editing) are re-measured
  // by the viewer automatically.
  const renderCodeViewHeader = useCallback(
    () =>
      details && (
        <SourceDescription
          actions={sourceDescriptionActions}
          details={details}
          footer={sourceDescriptionFooter}
        />
      ),
    [details, sourceDescriptionActions, sourceDescriptionFooter],
  );

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>) => {
      const editSession = codeEditing.sessions.get(item.id);
      const meta = editSession?.metadata ?? itemMetadata.get(item.id);
      const canEditMarkdown = meta?.isMarkdownPreview === true && meta.canEditMarkdown;
      const mode = meta && sectionModes.get(meta.section.id);
      const markdownEdit = canEditMarkdown && mode?.kind === 'edit' ? mode : undefined;
      const isEditingMarkdown = markdownEdit != null;
      const isEditing = editSession != null || isEditingMarkdown;
      const isBusy = codeEditing.isBusy(item.id) || Boolean(markdownEdit?.finishing);
      const isAutosaving = editSession?.saving && !isBusy;
      const canEdit = canEditMarkdown || canEditCodeItem(item, meta);
      const editError = canEditMarkdown ? markdownEdit?.error : codeEditing.getError(item.id);
      return meta ? (
        <>
          <CodeViewHeader
            canCreateFileComment={canCreateFileComments}
            editActions={
              isEditing ? (
                <>
                  {editSession ? (
                    <Button
                      aria-label={`${editSession?.hasChanges ? 'Revert edits to' : 'Cancel editing'} ${meta.file.path}`}
                      className="codophon-edit-revert-button"
                      data-autosaving={isAutosaving ? '' : undefined}
                      disabled={isBusy || editSession.saving}
                      onClick={() => void codeEditing.revertEdit(item.id)}
                      title={
                        editSession?.hasChanges
                          ? 'Restore the file to when editing started'
                          : 'Cancel editing'
                      }
                      type="button"
                      variant={editSession?.hasChanges ? 'destructive' : 'default'}
                    >
                      {editSession?.hasChanges ? 'Revert' : 'Cancel'}
                    </Button>
                  ) : null}
                  <span className="codophon-edit-mode-badge" role="status">
                    <PencilSimple aria-hidden size={12} weight="bold" />
                    Editing
                  </span>
                  <Button
                    aria-keyshortcuts={getShortcutLabel(keymap, 'doneEditing')}
                    aria-label={`Done editing ${meta.file.path}`}
                    data-autosaving={isAutosaving ? '' : undefined}
                    disabled={isBusy || editSession?.saving}
                    onClick={() =>
                      void (isEditingMarkdown
                        ? finishMarkdownEdit(meta)
                        : codeEditing.doneEdit(item.id))
                    }
                    title={`Finish editing (${getShortcutLabel(keymap, 'doneEditing')}). Changes are already saved.`}
                    type="button"
                  >
                    <Check aria-hidden size={14} weight="bold" />
                    Done
                  </Button>
                </>
              ) : canEdit ? (
                <FileEditButton
                  disabled={!codeEditing.canStartEdit(item.id, meta.file.path)}
                  isBusy={isBusy}
                  item={item}
                  keymap={keymap}
                  meta={meta}
                  onEdit={() => startFileEdit(item, meta)}
                  onPrepare={canEditMarkdown ? undefined : codeEditing.prepareEdit}
                />
              ) : null
            }
            isEditing={isEditing}
            isSectionLoading={loadingSectionIds.has(meta.section.id)}
            meta={meta}
            onCreateFileComment={() => createFileComment(meta, item.id)}
            onLoadSection={onLoadSection}
            onOpenFile={onOpenFile}
            onToggleCollapsed={onToggleCollapsed}
            onToggleMarkdownPreview={toggleMarkdownPreview}
            onToggleViewed={onToggleViewed}
          />
          {editError ? (
            <div className="codophon-code-edit-error" role="alert">
              {editError}
            </div>
          ) : null}
        </>
      ) : null;
    },
    [
      canCreateFileComments,
      canEditCodeItem,
      createFileComment,
      codeEditing,
      sectionModes,
      finishMarkdownEdit,
      itemMetadata,

      keymap,
      loadingSectionIds,
      onLoadSection,
      onOpenFile,
      onToggleCollapsed,
      onToggleViewed,
      startFileEdit,
      toggleMarkdownPreview,
    ],
  );

  const commentContext = useMemo(
    () => ({
      ...commentActions,
      comments: commentLookup,
      keymap,
      onCommentBlur: blurComment,
      onCommentFocus: focusComment,
      onDeleteComment: deleteComment,
      onReplyToThread: replyToThread,
    }),
    [
      commentActions,
      commentLookup,
      keymap,
      blurComment,
      focusComment,
      deleteComment,
      replyToThread,
    ],
  );

  const renderAnnotation = useCallback(
    (
      annotation:
        | DiffLineAnnotation<ReviewAnnotationMetadata>
        | LineAnnotation<ReviewAnnotationMetadata>,
      _fileOrDiff: unknown,
      item: CodeViewItem<ReviewAnnotationMetadata>,
    ) => {
      if (annotation.metadata.type === 'image-preview') {
        const meta = itemMetadata.get(item.id);
        return meta && onLoadImageContent ? (
          <ImageDiffPreview
            file={meta.file}
            loadImageContent={onLoadImageContent}
            onLayoutReady={markImagePreviewLayoutReady}
            section={meta.section}
            source={source}
          />
        ) : null;
      }

      if (annotation.metadata.type === 'markdown-preview') {
        const metadata = annotation.metadata;
        return (
          <MarkdownPreview
            cacheKey={`${sourceKey}:${item.id}`}
            contents={annotation.metadata.contents}
            editing={metadata.editing}
            heightCache={markdownPreviewHeights}
            itemId={item.id}
            oldContents={metadata.oldContents}
            onEditorRef={setMarkdownEditorRef}
            onLayoutReady={markMarkdownPreviewLayoutReady}
            onViewSource={(lineNumber, side) => {
              pendingMarkdownSourceRef.current = {
                lineNumber,
                sectionId: metadata.sectionId,
                side,
                sourceKey,
              };
              setSectionMode(metadata.sectionId, { kind: 'diff' });
            }}
            path={annotation.metadata.path}
            sectionId={annotation.metadata.sectionId}
          />
        );
      }

      if (annotation.metadata.type === 'walkthrough-header') {
        return annotation.metadata.header;
      }

      return (
        <ReviewAnnotation
          annotation={annotation as DiffLineAnnotation<ReviewCommentAnnotationMetadata>}
          onHeightChange={() => markCommentLayoutChanged(item.id)}
        />
      );
    },
    [
      itemMetadata,

      markMarkdownPreviewLayoutReady,
      markdownPreviewHeights,
      markImagePreviewLayoutReady,
      markCommentLayoutChanged,

      onLoadImageContent,

      setMarkdownEditorRef,
      setSectionMode,
      source,
      sourceKey,
    ],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
      if (onActiveBlockChange) {
        const activationTop = viewer.getScrollTop() + DEFAULT_PADDING;
        let activeBlockId: string | null = null;
        for (const item of items) {
          const top = viewer.getTopForItem(item.id);
          if (top == null) {
            continue;
          }
          if (top > activationTop) {
            break;
          }
          activeBlockId = itemBlockId.get(item.id) ?? activeBlockId;
        }
        if (activeBlockId) {
          onActiveBlockChange(activeBlockId);
        }
      }
      scheduleSearchHighlights();
      scheduleStickyHeaderStateUpdate(viewer);
      if (definitionModifierActiveRef.current) {
        updateRenderedIdentifierNavigation(true, viewer);
      }
    },
    [
      itemBlockId,
      items,
      onActiveBlockChange,
      onSelectPathFromScroll,
      scheduleSearchHighlights,
      scheduleStickyHeaderStateUpdate,
      updateRenderedIdentifierNavigation,
    ],
  );

  const codeView = (
    <CodeView
      className={`code-view${compactHeaders ? ' compact-file-headers' : ''}`}
      containerRef={setCodeViewElement}
      disableWorkerPool={disableWorkerPool}
      editorOptions={codeEditing.editorOptions}
      items={codeEditing.items}
      onItemEditChange={codeEditing.onItemEditChange}
      onItemEditComplete={codeEditing.onItemEditComplete}
      onScroll={handleScroll}
      onSelectedLinesChange={setCodeViewSelectedLines}
      options={codeViewOptions}
      ref={codeViewRef}
      renderAnnotation={renderAnnotation}
      renderCodeViewHeader={sourceDescriptionItemId ? renderCodeViewHeader : undefined}
      renderCustomHeader={renderCustomHeader}
      selectedLines={selectedLines}
      style={codeViewStyle}
    />
  );

  const renderedCodeView = disableWorkerPool ? (
    codeView
  ) : (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      {codeView}
    </WorkerPoolContextProvider>
  );

  return (
    <>
      <ReviewCommentsContext value={commentContext}>
        <EditProvider createEditor={createCodeEditor}>{renderedCodeView}</EditProvider>
      </ReviewCommentsContext>
      {definitionLookup?.sourceKey === sourceKey && onOpenDefinition ? (
        <DefinitionPopover
          anchor={definitionLookup.anchor}
          getDestination={(candidate) =>
            getDefinitionDiffTarget(candidate)
              ? 'diff'
              : candidate.canOpenInEditor
                ? 'editor'
                : 'unavailable'
          }
          identifier={definitionLookup.identifier}
          onClose={() => {
            invalidateDefinitionLookup();
            setDefinitionLookup(null);
          }}
          onOpen={(candidate) => {
            const target = getDefinitionDiffTarget(candidate);
            if (target) {
              if (target.metadata.isCollapsed) {
                onToggleCollapsed(target.metadata.file, true, target.metadata.reviewIdentity.key);
              }
              const scrollToDefinition = () =>
                codeViewRef.current?.scrollTo({
                  align: 'center',
                  behavior: 'smooth-auto',
                  id: target.item.id,
                  lineNumber: candidate.lineNumber,
                  offset: DEFAULT_PADDING,
                  side: candidate.side,
                  type: 'line',
                });
              if (target.metadata.isCollapsed) {
                window.requestAnimationFrame(() =>
                  window.requestAnimationFrame(scrollToDefinition),
                );
              } else {
                scrollToDefinition();
              }
            } else if (candidate.canOpenInEditor) {
              onOpenDefinition(candidate);
            }
            invalidateDefinitionLookup();
            setDefinitionLookup(null);
          }}
          result={definitionLookup.result}
        />
      ) : null}
    </>
  );
}
