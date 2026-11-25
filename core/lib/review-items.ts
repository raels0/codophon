import {
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type LineAnnotation,
} from '@pierre/diffs';
import { type ReactNode } from 'react';
import type { useCodeViewAnnotations } from '../app/hooks/useCodeViewAnnotations.ts';
import type { useCodeViewPlaceholderFile } from '../app/hooks/useCodeViewPlaceholderFile.ts';
import type { CodophonDiffStyle } from '../config/types.ts';
import type { CodophonSettings } from '../config/types.ts';
import type { ChangedFile, DiffSection, ReviewSource } from '../types.ts';
import type {
  CodeViewItemMetadata,
  DiffSearchMatch,
  ReviewAnnotationMetadata,
  ReviewComment,
  ReviewIdentity,
  WalkthroughNote,
} from './app-types.ts';
import {
  canRenderImagePreview,
  getDiffLineCountFromVisibleSections,
  getItemId,
  getMarkdownPreviewContents,
  getVisibleDiffSections,
  isMarkdownFilePath,
} from './diff.ts';
import { getItemVersion } from './item-version.ts';
import { isGeneratedWalkthroughFile } from './narrative-walkthrough-diff.ts';
import { getCommentKey, getReviewCommentsDigest, isLineReviewComment } from './review-comments.ts';
import { getReviewIdentity, isReviewIdentityViewed } from './review-identity.ts';
export const isEditableWorkingTreeSection = (
  sourceType: ReviewSource['type'],
  file: ChangedFile,
  section: DiffSection,
) =>
  (sourceType === 'working-tree' || sourceType === 'branch-working-tree') &&
  file.status !== 'deleted' &&
  file.sections.at(-1)?.id === section.id &&
  (section.kind === 'staged' || section.kind === 'unstaged');

type FileReviewDiffBlock = {
  comments?: ReadonlyArray<ReviewComment>;
  file: ChangedFile;
  fileSelected?: boolean;
  header?: ReactNode;
  headerSelected?: boolean;
  id: string;
  itemIdPrefix?: string;
  note?: string;
  reviewIdentity?: ReviewIdentity;
  selected?: boolean;
};

type HeaderReviewDiffBlock = {
  file?: undefined;
  header: ReactNode;
  headerSelected?: boolean;
  id: string;
  selected?: boolean;
};

export type ReviewDiffBlock = FileReviewDiffBlock | HeaderReviewDiffBlock;

export const createFileReviewBlocks = (
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<ReviewDiffBlock> =>
  files.map((file) => ({
    file,
    id: `file:${file.path}`,
  }));

const getBlockItemId = (block: FileReviewDiffBlock, section: DiffSection) =>
  block.itemIdPrefix ? `${block.itemIdPrefix}:${getItemId(section)}` : getItemId(section);

const getBlockHeaderItemId = (block: ReviewDiffBlock) => `${block.id}:walkthrough-header`;

const createInlineWalkthroughNote = (reason: string): WalkthroughNote => ({
  action: 'review',
  context: reason,
  groupReason: 'Walkthrough',
  groupTitle: 'Walkthrough',
  impact: 'contained',
  order: 0,
  reason,
});

const getBlockWalkthroughNote = (block: FileReviewDiffBlock) =>
  block.note ? createInlineWalkthroughNote(block.note) : undefined;

export const lineIsVisibleInFileDiff = (
  fileDiff: FileDiffMetadata,
  side: ReviewComment['side'],
  lineNumber: number,
) =>
  fileDiff.hunks.some((hunk) => {
    const hunkStart = side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
    const hunkLineCount = side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
    return lineNumber >= hunkStart && lineNumber < hunkStart + hunkLineCount;
  });

const reviewCommentAnchorIsVisibleInFileDiff = (
  comment: ReviewComment,
  fileDiff: FileDiffMetadata,
) =>
  !isLineReviewComment(comment) ||
  lineIsVisibleInFileDiff(fileDiff, comment.side, comment.lineNumber);

const diffSearchMatchIsVisibleInFileDiff = (match: DiffSearchMatch, fileDiff: FileDiffMetadata) => {
  if (match.lineNumber == null) {
    return true;
  }

  return match.side
    ? lineIsVisibleInFileDiff(fileDiff, match.side, match.lineNumber)
    : lineIsVisibleInFileDiff(fileDiff, 'additions', match.lineNumber) ||
        lineIsVisibleInFileDiff(fileDiff, 'deletions', match.lineNumber);
};

const dedupeReviewComments = (
  comments: ReadonlyArray<ReviewComment>,
): ReadonlyArray<ReviewComment> => {
  const deduped: Array<ReviewComment> = [];
  const seen = new Set<string>();
  for (const comment of comments) {
    if (seen.has(comment.id)) {
      continue;
    }
    seen.add(comment.id);
    deduped.push(comment);
  }
  return deduped;
};

export const groupReviewCommentsBySection = (comments: ReadonlyArray<ReviewComment>) => {
  const map = new Map<string, Array<ReviewComment>>();
  for (const comment of comments) {
    const list = map.get(comment.sectionId);
    if (list) {
      list.push(comment);
    } else {
      map.set(comment.sectionId, [comment]);
    }
  }
  return map;
};

type RenderedSearchTarget = {
  fileDiff: FileDiffMetadata;
  itemId: string;
  path: string;
};

export const resolveRenderedSearchMatch = (
  match: DiffSearchMatch | null,
  itemMetadata: ReadonlyMap<string, CodeViewItemMetadata>,
  searchTargetsByBaseItemId: ReadonlyMap<string, ReadonlyArray<RenderedSearchTarget>>,
): DiffSearchMatch | null => {
  if (!match) {
    return null;
  }

  if (itemMetadata.has(match.itemId)) {
    return match;
  }

  const candidates = searchTargetsByBaseItemId.get(match.itemId) ?? [];
  const candidate =
    candidates.find(
      (candidate) =>
        candidate.path === match.filePath &&
        diffSearchMatchIsVisibleInFileDiff(match, candidate.fileDiff),
    ) ??
    candidates.find((candidate) => candidate.path === match.filePath) ??
    candidates.find((candidate) => diffSearchMatchIsVisibleInFileDiff(match, candidate.fileDiff)) ??
    candidates[0];

  return candidate ? { ...match, itemId: candidate.itemId } : null;
};

export type SectionMode =
  | { kind: 'diff' }
  | { kind: 'preview' }
  | { error?: string; finishing?: boolean; kind: 'edit' };
export const isPreviewSection = (
  mode: SectionMode | undefined,
  defaultMode: CodophonSettings['renderMarkdownAs'],
) => (mode ? mode.kind !== 'diff' : defaultMode === 'preview');

export function buildReviewItems({
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
  sourceType,
  supportsImages,
  viewed,
}: {
  collapsed: ReadonlySet<string>;
  commentLayoutPassByItem: Readonly<Record<string, number>>;
  commentsBySection: ReturnType<typeof groupReviewCommentsBySection>;
  diffLineHeight: number;
  diffStyle: CodophonDiffStyle;
  expandedReviewKeys: ReadonlySet<string>;
  forceExpandedPaths: ReadonlySet<string>;
  getAnnotations: ReturnType<typeof useCodeViewAnnotations>;
  getPlaceholderFile: ReturnType<typeof useCodeViewPlaceholderFile>;
  imagePreviewLayoutPassBySection: Readonly<Record<string, number>>;
  itemVersionByKey: Readonly<Record<string, number>>;
  markdownContentsVersion: number;
  markdownPreviewLayoutPassBySection: Readonly<Record<string, number>>;
  renderMarkdownAs: CodophonSettings['renderMarkdownAs'];
  reviewBlocks: ReadonlyArray<ReviewDiffBlock>;
  sectionModes: ReadonlyMap<string, SectionMode>;
  selectedPath: string | null;
  showWhitespace: boolean;
  sourceType: ReviewSource['type'];
  supportsImages: boolean;
  viewed: Readonly<Record<string, string>>;
}) {
  const nextItems: Array<CodeViewItem<ReviewAnnotationMetadata>> = [];
  const nextCommentTargetById = new Map<
    string,
    { id: string; lineNumber?: number; side?: 'additions' | 'deletions' }
  >();
  const nextFirstItemByBlockId = new Map<string, string>();
  const nextFirstItemByPath = new Map<string, string>();
  const nextItemBlockId = new Map<string, string>();
  const nextItemMetadata = new Map<string, CodeViewItemMetadata>();
  const nextSearchTargetsByBaseItemId = new Map<string, Array<RenderedSearchTarget>>();
  const nextSelectedHeaderItemIds = new Set<string>();
  const fontLayoutKey = `line-height:${diffLineHeight}`;

  for (const block of reviewBlocks) {
    if (block.header) {
      const headerId = getBlockHeaderItemId(block);
      nextFirstItemByBlockId.set(block.id, nextFirstItemByBlockId.get(block.id) ?? headerId);
      nextItemBlockId.set(headerId, block.id);
      if ((block.headerSelected ?? block.selected) === true) {
        nextSelectedHeaderItemIds.add(headerId);
      }
      nextItems.push({
        annotations: [
          {
            lineNumber: 1,
            metadata: {
              header: block.header,
              type: 'walkthrough-header',
            },
          } satisfies LineAnnotation<ReviewAnnotationMetadata>,
        ],
        collapsed: false,
        file: getPlaceholderFile(headerId),
        id: headerId,
        type: 'file',
        // Selection stays out of the version: a scroll-driven current-stop
        // change must not re-measure the header item, or the viewer's scroll
        // anchoring yanks the scroll position at every stop boundary. The
        // accent is applied through `codophon-selected-item` in onPostRender.
        version: getItemVersion(`${block.id}:walkthrough-header`),
      });
    }

    if (!block.file) {
      continue;
    }

    const file = block.file;
    const reviewIdentity = block.reviewIdentity ?? getReviewIdentity(file);
    const reviewKey = reviewIdentity.key;
    const isViewed = isReviewIdentityViewed(viewed, reviewIdentity);
    const isCollapsed =
      !forceExpandedPaths.has(file.path) &&
      !expandedReviewKeys.has(reviewKey) &&
      (isViewed || collapsed.has(reviewKey) || isGeneratedWalkthroughFile(file));
    const visibleSections = getVisibleDiffSections(file, showWhitespace);
    const lineCount = getDiffLineCountFromVisibleSections(visibleSections);
    const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;
    const walkthroughNote = getBlockWalkthroughNote(block);
    const blockCommentsBySection = groupReviewCommentsBySection(block.comments ?? []);

    for (const [index, { fileDiff, section }] of sections.entries()) {
      const baseItemId = getItemId(section);
      const id = getBlockItemId(block, section);
      nextItemBlockId.set(id, block.id);
      const searchTargets = nextSearchTargetsByBaseItemId.get(baseItemId) ?? [];
      searchTargets.push({ fileDiff, itemId: id, path: file.path });
      nextSearchTargetsByBaseItemId.set(baseItemId, searchTargets);
      const markdownPreview = getMarkdownPreviewContents(file, section, fileDiff);
      const canRenderImage = supportsImages && canRenderImagePreview(file.path, section);
      const canRenderMarkdown = markdownPreview != null;
      const canEditMarkdown =
        canRenderMarkdown && isEditableWorkingTreeSection(sourceType, file, section);
      const isMarkdownPreview =
        canRenderMarkdown && isPreviewSection(sectionModes.get(section.id), renderMarkdownAs);
      const isSelected = block.fileSelected ?? block.selected ?? selectedPath === file.path;
      const reviewVersionPrefix = `${isMarkdownFilePath(file.path) ? markdownContentsVersion : 0}:${itemVersionByKey[reviewKey] ?? 0}:${block.id}:${
        reviewIdentity.fingerprint
      }:${reviewKey}:${section.id}:${commentLayoutPassByItem[id] ?? 0}`;
      const sectionStateVersionKey = `${isCollapsed ? 'collapsed' : 'open'}:${
        isViewed ? 'viewed' : 'pending'
      }:${index}:${fontLayoutKey}:${walkthroughNote?.reason ?? ''}`;
      const annotationMap = new Map<string, DiffLineAnnotation<ReviewAnnotationMetadata>>();
      const globalSectionComments = commentsBySection.get(section.id) ?? [];
      const visibleGlobalComments = globalSectionComments.filter(
        (comment) =>
          comment.filePath === file.path &&
          reviewCommentAnchorIsVisibleInFileDiff(comment, fileDiff),
      );
      const blockSectionComments = blockCommentsBySection.get(section.id) ?? [];
      const sectionComments = dedupeReviewComments([
        ...visibleGlobalComments,
        ...blockSectionComments,
      ]);
      for (const comment of sectionComments) {
        if (!nextCommentTargetById.has(comment.id)) {
          nextCommentTargetById.set(
            comment.id,
            isLineReviewComment(comment)
              ? {
                  id,
                  lineNumber: comment.lineNumber,
                  side: comment.side,
                }
              : { id },
          );
        }
        const key = getCommentKey(comment);
        const existing = annotationMap.get(key);
        if (existing && existing.metadata.type === 'review-comment') {
          annotationMap.set(key, {
            ...existing,
            metadata: {
              commentIds: [...existing.metadata.commentIds, comment.id],
              type: 'review-comment',
            },
          });
        } else {
          const isLineComment = isLineReviewComment(comment);
          annotationMap.set(key, {
            lineNumber: isLineComment ? comment.lineNumber : 0,
            metadata: {
              commentIds: [comment.id],
              type: 'review-comment',
            },
            side: isLineComment
              ? comment.side
              : file.status === 'deleted'
                ? 'deletions'
                : 'additions',
          });
        }
      }
      const fileCommentAnnotations = [...annotationMap.values()].filter(
        (annotation) => annotation.lineNumber === 0,
      );
      nextItemMetadata.set(id, {
        blockId: block.id,
        canEditMarkdown,
        canRenderMarkdown,
        comments: sectionComments,
        file,
        isCollapsed,
        isMarkdownPreview,
        isSelected,
        isViewed,
        lineCount,
        reviewIdentity,
        section,
        sectionCount: file.sections.length,
        walkthroughNote,
      });
      nextFirstItemByBlockId.set(block.id, nextFirstItemByBlockId.get(block.id) ?? id);
      nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
      if (canRenderImage) {
        nextItems.push({
          annotations: [
            ...fileCommentAnnotations,
            {
              lineNumber: 1,
              metadata: {
                path: file.path,
                sectionId: section.id,
                type: 'image-preview',
              },
            } satisfies LineAnnotation<ReviewAnnotationMetadata>,
          ],
          collapsed: isCollapsed,
          file: getPlaceholderFile(file.path),
          id,
          type: 'file',
          version: getItemVersion(
            `${reviewVersionPrefix}:image:${sectionStateVersionKey}:${
              imagePreviewLayoutPassBySection[section.id] ?? 0
            }`,
          ),
        });
        continue;
      }
      if (isMarkdownPreview) {
        const markdownPreviewLayoutKey = `${section.id}:${file.fingerprint}`;
        nextItems.push({
          annotations: getAnnotations(
            id,
            JSON.stringify([
              markdownPreview.contents,
              markdownPreview.oldContents,
              sectionModes.get(section.id)?.kind === 'edit',
              [...annotationMap.values()],
            ]),
            [
              ...[...annotationMap.values()].map((annotation) => ({
                ...annotation,
                lineNumber: 1,
              })),
              {
                lineNumber: 1,
                metadata: {
                  contents: markdownPreview.contents,
                  editing: sectionModes.get(section.id)?.kind === 'edit',
                  layoutKey: markdownPreviewLayoutKey,
                  oldContents: markdownPreview.oldContents,
                  path: file.path,
                  sectionId: section.id,
                  type: 'markdown-preview',
                },
              } satisfies LineAnnotation<ReviewAnnotationMetadata>,
            ],
          ),
          collapsed: isCollapsed,
          file: getPlaceholderFile(file.path),
          id,
          type: 'file',
          version: getItemVersion(
            `${reviewVersionPrefix}:markdown:${sectionStateVersionKey}:${sectionModes.get(section.id)?.kind === 'edit'}:${
              markdownPreviewLayoutKey
            }:${markdownPreviewLayoutPassBySection[section.id] ?? 0}`,
          ),
        });
        continue;
      }
      nextItems.push({
        annotations: [...annotationMap.values()],
        collapsed: isCollapsed,
        fileDiff,
        id,
        type: 'diff',
        version: getItemVersion(
          `${reviewVersionPrefix}:${sectionStateVersionKey}:${
            showWhitespace ? 'ws' : 'ignore-ws'
          }:${diffStyle}:${getReviewCommentsDigest(sectionComments)}`,
        ),
      });
    }
  }

  return {
    commentTargetById: nextCommentTargetById,
    firstItemByBlockId: nextFirstItemByBlockId,
    firstItemByPath: nextFirstItemByPath,
    itemBlockId: nextItemBlockId,
    itemMetadata: nextItemMetadata,
    items: nextItems,
    searchTargetsByBaseItemId: nextSearchTargetsByBaseItemId,
    selectedHeaderItemIds: nextSelectedHeaderItemIds,
  };
}
