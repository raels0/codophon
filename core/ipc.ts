import type { NativeKeyboardLayout } from './config/keyboard-layout.ts';
import type {
  AgentModelCatalog,
  AgentPromptId,
  AgentPromptModule,
  AgentPromptOverrides,
  AgentSettingsSection,
  CodophonAgentBackend,
  CodophonConfig,
  SettingsPatch,
} from './config/types.ts';
import type {
  AgentSkillStatus,
  CodophonLaunchOptions,
  CodophonMarkdownDocument,
  CodophonUpdateStatus,
  DefinitionSearchRequest,
  DefinitionSearchResult,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
  GitIdentity,
  NarrativeWalkthroughRequestOptions,
  NarrativeWalkthroughResult,
  OpenReviewSourceKind,
  RepositoryHistory,
  ReviewBriefPostedComment,
  RepositoryFileDocument,
  RepositoryState,
  ReviewAssistantRequest,
  ReviewAssistantResult,
  ReviewSource,
  SaveMarkdownDocumentRequest,
  SaveMarkdownDocumentResult,
  SaveRepositoryFileRequest,
  SaveRepositoryFileResult,
  SetPullRequestFileViewedRequest,
  SubmitPullRequestCommentRequest,
  PullRequestExistingReviewComment,
  SubmitPullRequestReviewRequest,
  TerminalHelperStatus,
  WalkthroughCommitMessageRequest,
  WalkthroughCommitMessageResult,
  WalkthroughCommitRequest,
  WalkthroughCommitResult,
  WalkthroughProgressEvent,
} from './types.ts';

export type Invoke = {
  askReviewAssistant: (request: ReviewAssistantRequest) => Promise<ReviewAssistantResult>;
  checkForUpdates: () => Promise<CodophonUpdateStatus>;
  createWalkthroughCommit: (request: WalkthroughCommitRequest) => Promise<WalkthroughCommitResult>;
  dismissUpdate: () => Promise<CodophonUpdateStatus>;
  findDefinitions: (request: DefinitionSearchRequest) => Promise<DefinitionSearchResult>;
  getAgentModelCatalog: (refresh?: boolean) => Promise<AgentModelCatalog>;
  getAgentPrompts: () => Promise<Array<AgentPromptModule>>;
  getAgentSkillStatus: () => Promise<AgentSkillStatus>;
  getConfig: () => Promise<CodophonConfig>;
  getDiffImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
  getGitIdentity: () => Promise<GitIdentity>;
  getKeyboardLayout: () => Promise<NativeKeyboardLayout | null>;
  getLaunchOptions: () => Promise<CodophonLaunchOptions>;
  getMarkdownDocument: (request: {
    kind: CodophonMarkdownDocument['kind'];
    path: string;
  }) => Promise<CodophonMarkdownDocument>;
  getNarrativeWalkthrough: (
    source?: ReviewSource,
    options?: NarrativeWalkthroughRequestOptions,
  ) => Promise<NarrativeWalkthroughResult>;
  getRepositoryFile: (path: string) => Promise<RepositoryFileDocument>;
  getRepositoryHistory: (limit?: number, source?: ReviewSource) => Promise<RepositoryHistory>;
  getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
  getReviewBriefComments: (
    source: Extract<ReviewSource, { type: 'pull-request' }>,
  ) => Promise<Array<ReviewBriefPostedComment>>;
  getTerminalHelperStatus: () => Promise<TerminalHelperStatus>;
  getUpdateStatus: () => Promise<CodophonUpdateStatus>;
  installAgentSkill: () => Promise<AgentSkillStatus>;
  installTerminalHelper: () => Promise<TerminalHelperStatus>;
  /** Restarts into a downloaded update, retries a failed download, or opens the release page. */
  installUpdate: () => Promise<CodophonUpdateStatus>;
  isWindowFullScreen: () => Promise<boolean>;
  openConfigFile: () => Promise<void>;
  openFile: (path: string, lineNumber?: number) => Promise<void>;
  openRepositoryFolder: () => Promise<void>;
  resolvePullRequestUrl: (value: string) => Promise<string>;
  saveMarkdownDocument: (
    request: SaveMarkdownDocumentRequest,
  ) => Promise<SaveMarkdownDocumentResult>;
  saveRepositoryFile: (request: SaveRepositoryFileRequest) => Promise<SaveRepositoryFileResult>;
  selectAgentModel: (agent: CodophonAgentBackend, model: string) => Promise<void>;
  setAgentPrompt: (id: AgentPromptId, text: string | null) => Promise<AgentPromptOverrides>;
  setPullRequestFileViewed: (request: SetPullRequestFileViewedRequest) => Promise<void>;
  submitPullRequestComment: (
    request: SubmitPullRequestCommentRequest,
  ) => Promise<PullRequestExistingReviewComment>;
  submitPullRequestReview: (request: SubmitPullRequestReviewRequest) => Promise<void>;
  updateSettings: (patch: SettingsPatch) => Promise<void>;
  updateWalkthroughCommitMessage: (
    request: WalkthroughCommitMessageRequest,
  ) => Promise<WalkthroughCommitMessageResult>;
};

export type Events = {
  configChanged: (config: CodophonConfig) => void;
  findInDiffs: () => void;
  keyboardLayoutChanged: (layout: NativeKeyboardLayout) => void;
  markdownDocumentChanged: (
    change:
      | { deleted: true; id: string }
      | { deleted: false; document: CodophonMarkdownDocument; id: string },
  ) => void;
  openAgentSettings: (section: AgentSettingsSection) => void;
  openReviewSource: (kind: OpenReviewSourceKind) => void;
  refreshRequest: () => void;
  repositoryChanged: (change: { root: string }) => void;
  updateStatusChanged: (status: CodophonUpdateStatus) => void;
  walkthroughCommitOutput: (chunk: string) => void;
  walkthroughProgress: (progress: WalkthroughProgressEvent) => void;
  windowFullScreenChanged: (isFullScreen: boolean) => void;
};

export type DesktopBridge = Invoke & {
  [K in keyof Events as `on${Capitalize<K>}`]: (callback: Events[K]) => () => void;
} & {
  markWindowReady: () => void;
  onCopyPendingCommentsRequest: (callback: () => string | Promise<string>) => () => void;
};
