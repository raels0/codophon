import type { CodeViewHandle } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
import type {
  ChangedFile,
  DiffSection,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  PullRequestExistingReviewComment,
  ReviewAssistantContext,
  ReviewAssistantTurn,
  ReviewSource,
} from '../types.ts';

export type WalkthroughError = Extract<NarrativeWalkthroughResult, { status: 'unavailable' }>;

export type ReviewCommentAnnotationMetadata = {
  commentIds: ReadonlyArray<string>;
  type: 'review-comment';
};

type MarkdownPreviewAnnotationMetadata = {
  contents: string;
  editing: boolean;
  layoutKey: string;
  oldContents?: string;
  path: string;
  sectionId: string;
  type: 'markdown-preview';
};

type ImagePreviewAnnotationMetadata = {
  path: string;
  sectionId: string;
  type: 'image-preview';
};

type WalkthroughHeaderAnnotationMetadata = {
  header: ReactNode;
  type: 'walkthrough-header';
};

export type ReviewAnnotationMetadata =
  | ImagePreviewAnnotationMetadata
  | MarkdownPreviewAnnotationMetadata
  | ReviewCommentAnnotationMetadata
  | WalkthroughHeaderAnnotationMetadata;

export type CodeViewInstance = NonNullable<
  ReturnType<CodeViewHandle<ReviewAnnotationMetadata, undefined>['getInstance']>
>;

export type DiffSearchMatch = {
  filePath: string;
  itemId: string;
  lineNumber?: number;
  side?: 'additions' | 'deletions';
};

export type DiffSearchResult = {
  file: ChangedFile;
  matchCount: number;
  matches: ReadonlyArray<DiffSearchMatch>;
};

export type ReviewScrollBehavior = 'instant' | 'smooth';

export type ReviewScrollTarget = {
  anchor?: Pick<ReviewComment, 'sectionId' | 'lineNumber' | 'side'>;
  behavior?: ReviewScrollBehavior;
  blockId?: string;
  commentId?: string;
  path?: string;
  request: number;
};

export type ReviewIdentity = {
  coverage?: {
    allHunkIds: ReadonlyArray<string>;
    file: { fingerprint: string; key: string };
    hunkIds: ReadonlyArray<string>;
  };
  fingerprint: string;
  key: string;
};

export type DiffLineCount = {
  additions: number;
  countable: boolean;
  deletions: number;
};

type ReviewCommentBase = {
  anchor?: 'file' | 'line';
  body: string;
  /** The Ask conversation attached to this comment, if any. */
  codexReply?: {
    body?: string;
    context?: ReviewAssistantContext;
    error?: string;
    followUpDraft?: string;
    isFollowUp?: boolean;
    question?: string;
    reviewKey?: string;
    status: 'error' | 'loading' | 'ready';
    turns?: ReadonlyArray<ReviewAssistantTurn>;
  };
  filePath: string;
  id: string;
  lineNumber?: number;
  sectionId: string;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  /** The pull request thread this comment belongs to or replies to. */
  threadId?: string;
};

/** A note written in Codophon: kept locally, posted on submit, or sent to Ask. */
export type DraftComment = ReviewCommentBase & {
  kind: 'draft';
  remoteSubmit?: { error?: string; status: 'error' | 'submitting' };
};

/** A comment that already exists on the pull request. */
export type PostedComment = ReviewCommentBase & {
  author?: PullRequestExistingReviewComment['author'];
  canReplyThread?: boolean;
  isOutdated?: boolean;
  kind: 'posted';
  submittedAt?: string;
  url?: string;
};

export type ReviewComment = DraftComment | PostedComment;

export type SidebarMode = 'tree' | 'walkthrough' | 'history';

export type PullRequestSource = Extract<ReviewSource, { type: 'pull-request' }>;

export type WalkthroughNote = {
  action: 'review' | 'scan' | 'skim';
  context: string;
  groupReason: string;
  groupTitle: string;
  impact: 'wide' | 'contained' | 'mechanical';
  order: number;
  reason: string;
};

export type SourceSession = {
  collapsed: Set<string>;
  expandedReviewKeys: Set<string>;
  /** Populated by a generated or pre-authored narrative walkthrough document. */
  narrativeWalkthrough?: NarrativeWalkthrough | null;
  reviewComments: ReadonlyArray<ReviewComment>;
  selectedPath: string | null;
  viewed: Record<string, string>;
  walkthroughError: WalkthroughError | null;
  walkthroughFiles: ReadonlyArray<{
    fingerprint: string;
    path: string;
    status: ChangedFile['status'];
  }>;
};

export type RepositoryLoadError = {
  kind: 'generic' | 'not-a-repository';
  message: string;
};

export type CodeViewItemMetadata = {
  blockId: string;
  canEditMarkdown: boolean;
  canRenderMarkdown: boolean;
  comments: ReadonlyArray<ReviewComment>;
  file: ChangedFile;
  isCollapsed: boolean;
  isMarkdownPreview: boolean;
  isSelected: boolean;
  isViewed: boolean;
  lineCount: DiffLineCount;
  reviewIdentity: ReviewIdentity;
  section: DiffSection;
  sectionCount: number;
  walkthroughNote?: WalkthroughNote;
};
