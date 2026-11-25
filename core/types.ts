import type { AgentBackend, AgentNotFoundCode } from './config/agents.ts';

export type DiffSection = {
  binary: boolean;
  id: string;
  kind: 'commit' | 'pull-request' | 'staged' | 'unstaged';
  loadState?: 'binary' | 'deferred' | 'directory' | 'error' | 'ready' | 'too-large';
  newFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  oldFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  patch: string;
  summary?: {
    canLoad?: boolean;
    fileCount?: number;
    fingerprint?: string;
    limit?: number;
    reason: string;
    size?: number;
  };
};

export type GitFileStatus =
  | 'added'
  | 'conflicted'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked';

export type ChangedFile = {
  fingerprint: string;
  generated?: boolean;
  oldPath?: string;
  path: string;
  sections: ReadonlyArray<DiffSection>;
  status: GitFileStatus;
};

export type ReviewAuthor = {
  avatarUrl?: string;
  login: string;
  name?: string;
  url?: string;
};

export type PullRequestReviewer = ReviewAuthor & {
  approved: boolean;
  id: string;
};

export type PullRequestReviewActionStatus = {
  disabled?: boolean;
  reason?: string;
};

export type PullRequestReviewStatus = {
  approve?: PullRequestReviewActionStatus;
  comment?: PullRequestReviewActionStatus;
  requestChanges?: PullRequestReviewActionStatus;
};

export type ReviewSource =
  | {
      type: 'working-tree';
    }
  | {
      ref: string;
      type: 'commit';
    }
  | {
      ref: string;
      type: 'branch';
    }
  | {
      /** Resolved base commit for a branch diff snapshot. */
      baseRef: string;
      /** Resolved head commit for a branch diff snapshot. */
      headRef: string;
      /** Target branch the current branch was compared against. */
      ref: string;
      type: 'branch-diff';
    }
  | {
      /**
       * Resolved base commit for the branch part of the comparison. Optional
       * because the CLI can construct this source from just a branch name
       * (`codophon main`), before merge-base resolution happens; the resolved
       * state's `source` always carries a concrete value.
       */
      baseRef?: string;
      /** Resolved head commit for the branch part of the comparison. See {@link baseRef}. */
      headRef?: string;
      /** Target branch the current branch was compared against. */
      ref: string;
      type: 'branch-working-tree';
    }
  | {
      /** Base ref (left side). For symmetric ranges the diff starts at its merge-base with head. */
      base: string;
      /** Head ref (right side). */
      head: string;
      /** `true` for `base...head` (merge-base), `false` for `base..head` (direct). */
      symmetric: boolean;
      type: 'range';
    }
  | {
      author?: ReviewAuthor;
      baseSha?: string;
      description?: string;
      draft?: boolean;
      headSha?: string;
      host?: string;
      number?: number;
      owner?: string;
      projectPath?: string;
      provider?: 'github' | 'azure-devops';
      repo?: string;
      reviewers?: ReadonlyArray<PullRequestReviewer>;
      reviewStatus?: PullRequestReviewStatus;
      title?: string;
      type: 'pull-request';
      url: string;
    };

/** Sources that can be entered from the palette or native application menu. */
export type OpenReviewSourceKind = 'branch' | 'commit' | 'pull-request';

export type HistoryEntry = {
  author: string;
  committedAt: number;
  gravatarUrl?: string;
  parents: ReadonlyArray<string>;
  ref: string;
  scope?: 'base' | 'pull-request';
  subject: string;
};

export type CommitMetadataPerson = {
  date: string;
  email: string;
  gravatarUrl?: string;
  name: string;
};

export type CommitMetadataFile = {
  additions?: number;
  binary: boolean;
  deletions?: number;
  oldPath?: string;
  path: string;
  status: GitFileStatus;
};

export type CommitMetadata = {
  author: CommitMetadataPerson;
  body: string;
  committer: CommitMetadataPerson;
  files: ReadonlyArray<CommitMetadataFile>;
  parents: ReadonlyArray<string>;
  ref: string;
  refs: ReadonlyArray<string>;
  shortRef: string;
  signature: {
    key?: string;
    signer?: string;
    status: string;
  };
  stats: {
    additions: number;
    binaryFiles: number;
    deletions: number;
    files: number;
    renamedFiles: number;
  };
  subject: string;
  trailers: ReadonlyArray<{
    key: string;
    value: string;
  }>;
};

export type RepositoryHistory = {
  entries: ReadonlyArray<HistoryEntry>;
  root: string;
};

export type RepositoryState = {
  branch: string | null;
  commitMetadata?: CommitMetadata;
  files: ReadonlyArray<ChangedFile>;
  generalComments?: ReadonlyArray<PullRequestGeneralCommentThread>;
  generatedAt: number;
  launchPath: string;
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  root: string;
  source: ReviewSource;
  /** Remote Viewed files mapped to current fingerprints; absent when unavailable. */
  viewedFiles?: Readonly<Record<string, string>>;
};

export type WalkthroughProgressPhase = 'agent-generation' | 'response-received';

export type WalkthroughProgressEvent = {
  phase: WalkthroughProgressPhase;
};

export type CodophonMarkdownDocument = {
  content: string;
  id: string;
  kind: 'repository';
  path: string;
  version: string;
};

export type SaveMarkdownDocumentRequest = {
  baseVersion: string;
  content: string;
  kind: CodophonMarkdownDocument['kind'];
  path: string;
};

export type SaveMarkdownDocumentResult =
  | {
      document: CodophonMarkdownDocument;
      status: 'conflict';
    }
  | {
      document: CodophonMarkdownDocument;
      status: 'saved';
    };

export type RepositoryFileDocument = {
  content: string;
  path: string;
  root: string;
  version: string;
};

export type SaveRepositoryFileRequest = Omit<RepositoryFileDocument, 'version'> & {
  baseVersion: string;
};

export type SaveRepositoryFileResult = {
  document: RepositoryFileDocument;
  status: 'conflict' | 'saved';
};

export type WalkthroughContext = {
  changedFiles?: ReadonlyArray<{
    path: string;
    rationale?: string;
    role: string;
  }>;
  constraints?: ReadonlyArray<string>;
  decisions?: ReadonlyArray<string>;
  implementationSummary?: string;
  messages?: ReadonlyArray<{
    role: 'assistant' | 'user';
    text: string;
  }>;
  objective?: string;
  risks?: ReadonlyArray<string>;
  source: {
    generatedAt: string;
    threadId?: string;
    type:
      | 'codex-session'
      | 'codex-session-excerpt'
      | 'claude-session'
      | 'claude-session-excerpt'
      | 'opencode-session'
      | 'opencode-session-excerpt';
  };
  validation?: ReadonlyArray<string>;
  version: 1;
};

export type CodophonLaunchOptions = {
  agentBackend?: AgentBackend;
  agentSessions?: ReadonlyArray<{ agent: AgentBackend; id: string }>;
  repositoryPathProvided: boolean;
  source?: ReviewSource;
  walkthrough: boolean;
  walkthroughContext?: WalkthroughContext;
  /** Path to a pre-authored {@link NarrativeWalkthrough} JSON file (--walkthrough-file). */
  walkthroughFile?: string;
  /** Result file where the app reports whether it applied {@link walkthroughFile}. */
  walkthroughResultFile?: string;
};

export type AgentSkillStatus = {
  installed: boolean;
  path: string;
};

/** @deprecated Use {@link AgentSkillStatus}. */
export type TerminalHelperStatus = {
  command: string;
  installed: boolean;
  path: string;
};

/**
 * Narrative Walkthrough. The agent authors chapters, stops, and support groups
 * around deterministic hunk ids. Codophon resolves those ids against the live diff
 * and computes file paths, anchors, and line counts.
 */
export type WalkthroughIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'beaker' | 'doc' | 'gear';

/** Where a walkthrough hunk points into the live diff. */
export type WalkthroughAnchor = {
  /** Human-readable location, e.g. 'src/App.tsx:311' or 'src/hooks/useHunkOrder.ts (new)'. */
  display: string;
  /** End line on the {@link side} (inclusive). */
  endLine?: number;
  /** Matches {@link DiffSection.id}, e.g. 'src/App.tsx:staged'. */
  sectionId?: string;
  sectionKind?: DiffSection['kind'];
  side?: 'additions' | 'deletions' | 'both';
  /** Start line on the {@link side}. */
  startLine?: number;
};

/** A short header note rendered above one focused walkthrough hunk diff. */
export type WalkthroughHunkNote = {
  body: string;
  hunkId: string;
};

/**
 * Change-type tag shown on a file row in the commit composer. Mirrors the
 * walkthrough's narrative roles so a reviewer recognises each file at a glance.
 */
export type WalkthroughChangeType =
  | 'fix'
  | 'feature'
  | 'refactor'
  | 'test'
  | 'generated'
  | 'lockfile'
  | 'snapshot'
  | 'i18n'
  | 'docs';

/** One resolved hunk selected by a walkthrough item, in agent-requested order. */
export type WalkthroughHunk = {
  added: number;
  additionEnd?: number;
  additionStart?: number;
  anchor: WalkthroughAnchor;
  deleted: number;
  deletionEnd?: number;
  deletionStart?: number;
  id: string;
  /** `synthetic` hunks represent binary, deferred, or metadata-only review units. */
  kind?: 'patch' | 'synthetic';
  oldPath?: string;
  path: string;
  status: GitFileStatus;
};

/** Shared hunk-backed fields for a stop or support group. */
export type WalkthroughHunkGroup = {
  added: number;
  /** Change-type tag for the commit composer's file row. */
  changeType?: WalkthroughChangeType;
  /** One-line note the generated commit body uses for this file (falls back to {@link summary}). */
  commitNote?: string;
  deleted: number;
  /** Deterministic hunk ids selected by the authoring agent, in display order. */
  hunkIds: ReadonlyArray<string>;
  /** Resolved hunks with Codophon-computed anchors, file paths, status, and line counts. */
  hunks: ReadonlyArray<WalkthroughHunk>;
  /** Stable within the document, e.g. 's1'. */
  id: string;
  /** Optional header notes for individual hunk ids in this item. */
  notes?: ReadonlyArray<WalkthroughHunkNote>;
  /** Short, plain-text gist of the slice. */
  summary?: string;
  title?: string;
};

/** One stop in the main walkthrough path. */
export type WalkthroughStop = WalkthroughHunkGroup & {
  importance: 'critical' | 'normal' | 'context';
  /** Agent narration (markdown / inline code). */
  prose: string;
};

/** A changed hunk group kept off the main path. */
export type WalkthroughSupportGroup = WalkthroughHunkGroup & {
  note?: string;
  /** Why it is off the path, e.g. 'Generated' | 'Lockfile' | 'Snapshot' | 'Mechanical'. */
  reason: string;
};

/** A named chapter in the walkthrough. */
export type WalkthroughChapter = {
  blurb: string;
  icon: WalkthroughIcon;
  id: string;
  stops: ReadonlyArray<WalkthroughStop>;
  title: string;
};

/**
 * Marks the walkthrough's diff as a staging set that can be committed and seeds
 * the commit composer Codophon renders as the walkthrough's terminal stop. Only
 * honored when {@link NarrativeWalkthrough.source} is a working tree — you can
 * only commit a live staging set, never a past commit, branch, or pull request.
 */
export type WalkthroughCommit = {
  /**
   * The agent-drafted commit body — a few paragraphs of prose describing the
   * change as a whole. Shown editable by default; the reviewer can rewrite it,
   * or ask the agent to regenerate it for a narrowed file selection.
   */
  body?: string;
  /** Suggested first line for the commit message. */
  title?: string;
};

export type WalkthroughDesignOverview = {
  after: string;
  before: string;
  diagram?: { mermaid: string; title: string };
  goal: string;
  goalSource: 'stated' | 'inferred';
  implementation: ReadonlyArray<{ description: string; hunkId: string; title: string }>;
  /** Set by Codophon when the overview used incomplete patch text. */
  partialEvidence?: boolean;
  unchanged?: string;
};

export type NarrativeWalkthrough = {
  agent: AgentBackend;
  chapters: ReadonlyArray<WalkthroughChapter>;
  /**
   * When present, the diff is a committable staging set: Codophon adds a commit
   * composer at the end of the walkthrough. Stripped unless `source` is a working tree.
   */
  commit?: WalkthroughCommit;
  /** The originating conversation, embedded for in-app Q&A. */
  context?: WalkthroughContext;
  designOverview?: WalkthroughDesignOverview;
  /** 1–2 sentence summary of the change. */
  focus: string;
  /** ISO timestamp. */
  generatedAt: string;
  kind: 'narrative';
  /** Display string, e.g. '6 stops · 4 chapters'. */
  meta?: string;
  repo: {
    branch: string | null;
    root: string;
  };
  source: ReviewSource;
  support: ReadonlyArray<WalkthroughSupportGroup>;
  title: string;
  version: 4;
};

export type NarrativeWalkthroughResult =
  | {
      status: 'ready';
      walkthrough: NarrativeWalkthrough;
    }
  | {
      code?: AgentNotFoundCode;
      reason: string;
      status: 'unavailable';
    };

export type NarrativeWalkthroughRequestOptions = {
  /** Ignore an exact cache hit and replace it with a newly generated result. */
  force?: boolean;
  /**
   * The walkthrough currently shown. Regeneration uses its prose as continuity
   * while re-anchoring every stop against the current diff.
   */
  previousWalkthrough?: NarrativeWalkthrough;
};

/** Commit the selected files from a walkthrough's staging set. */
export type WalkthroughCommitRequest = {
  /** Body of the commit message (everything after the subject line). */
  body: string;
  /** Repo-relative paths to commit; other staged changes are left untouched. */
  paths: ReadonlyArray<string>;
  source?: ReviewSource;
  /** First line of the commit message. */
  subject: string;
};

export type WalkthroughCommitResult =
  | {
      /** Full SHA of the new commit. */
      hash: string;
      status: 'committed';
    }
  | {
      reason: string;
      status: 'failed';
    };

/**
 * Ask the connected agent to rewrite the commit message for the current file
 * selection — used when the reviewer drops files from the staging set and the
 * pre-drafted body no longer matches what is being committed.
 */
export type WalkthroughCommitMessageRequest = {
  /** The current body, given to the agent as the message to revise. */
  body: string;
  /** Repo-relative paths still selected for the commit. */
  paths: ReadonlyArray<string>;
  source?: ReviewSource;
  /** The current subject line. */
  subject: string;
};

export type WalkthroughCommitMessageResult =
  | {
      body: string;
      status: 'ready';
      subject: string;
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type ReviewAssistantTurn = {
  context?: ReviewAssistantContext;
  question: string;
  reply: string;
};

export type ReviewAssistantRequest = {
  comment: {
    anchor?: 'file' | 'line';
    body: string;
    filePath: string;
    lineNumber?: number;
    sectionId: string;
    side?: 'additions' | 'deletions';
    startLineNumber?: number;
    startSide?: 'additions' | 'deletions';
  };
  previousTurns?: ReadonlyArray<ReviewAssistantTurn>;
  source?: ReviewSource;
  walkthroughNote?: {
    action: 'review' | 'scan' | 'skim';
    context: string;
    groupReason: string;
    groupTitle: string;
    impact: 'wide' | 'contained' | 'mechanical';
    reason: string;
  };
};

export type ReviewAssistantContext = {
  fileCount: number;
  filesRead: number;
  label: string;
  version?: string;
  warnings: ReadonlyArray<string>;
};

export type ReviewAssistantResult =
  | {
      context?: ReviewAssistantContext;
      reply: string;
      status: 'ready';
    }
  | {
      code?: AgentNotFoundCode;
      context?: ReviewAssistantContext;
      reason: string;
      status: 'unavailable';
    };

export type GitIdentity = {
  email: string;
  gravatarUrl?: string;
  name: string;
  username?: string;
};

export type DiffSectionContentRequest = {
  force?: boolean;
  kind: DiffSection['kind'];
  path: string;
  showWhitespace?: boolean;
  source?: ReviewSource;
};

export type DefinitionSearchRequest = {
  identifier: string;
  kind: DiffSection['kind'];
  lineNumber: number;
  path: string;
  side: 'additions' | 'deletions';
  source: ReviewSource;
};

export type DefinitionCandidate = {
  canOpenInEditor: boolean;
  kind: string;
  line: string;
  lineNumber: number;
  path: string;
  side: 'additions' | 'deletions';
};

export type DefinitionSearchResult =
  | {
      candidates: ReadonlyArray<DefinitionCandidate>;
      identifier: string;
      status: 'ready';
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type DiffImageContentRequest = {
  kind: DiffSection['kind'];
  path: string;
  source?: ReviewSource;
};

export type DiffImageRevision = {
  dataUrl: string;
  mimeType: string;
  name: string;
  size: number;
};

export type DiffImageContentResult =
  | {
      newImage?: DiffImageRevision;
      oldImage?: DiffImageRevision;
      status: 'ready';
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type CodophonTheme = 'system' | 'light' | 'dark';

/** A newer GitHub release than the running build, if one is known and not dismissed. */
export type CodophonUpdateStatus = {
  availableVersion?: string;
  currentVersion: string;
  /** Absent when the update has to be downloaded by hand from the release page. */
  download?:
    | { progress: number; state: 'downloading' }
    | { state: 'ready' }
    | { error: string; state: 'failed' };
};

export type PullRequestReviewComment = {
  anchor?: 'file' | 'line';
  body: string;
  filePath: string;
  lineNumber?: number;
  sectionId?: string;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  threadId?: string;
};

export type PullRequestExistingReviewComment = PullRequestReviewComment & {
  author: ReviewAuthor;
  canReplyThread?: boolean;
  id: string;
  isOutdated?: boolean;
  submittedAt?: string;
  url?: string;
};

export type PullRequestGeneralComment = {
  author: ReviewAuthor;
  body: string;
  id: string;
  submittedAt?: string;
  url?: string;
};

export type PullRequestGeneralCommentThread = {
  canReply?: boolean;
  canResolve?: boolean;
  comments: ReadonlyArray<PullRequestGeneralComment>;
  id: string;
  isResolved?: boolean;
};

export type ReviewBriefPostedComment = {
  body: string;
  filePath?: string;
  lineNumber?: number;
  resolved: boolean;
  side?: PullRequestReviewComment['side'];
  startLineNumber?: number;
  url: string;
};

export type PullRequestReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type SubmitPullRequestCommentRequest = {
  comment: PullRequestReviewComment;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};

export type SetPullRequestFileViewedRequest = {
  path: string;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
  viewed: boolean;
};

export type SubmitPullRequestReviewRequest = {
  body?: string;
  comments: ReadonlyArray<PullRequestReviewComment>;
  event: PullRequestReviewEvent;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};
