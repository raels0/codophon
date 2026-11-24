import type { NativeKeyboardLayout } from './config/keyboard-layout.ts';
import type {
  AgentModelCatalog,
  AgentPromptId,
  AgentPromptModule,
  AgentPromptOverrides,
  AgentSettingsSection,
  CodiffAgentBackend,
  CodiffConfig,
} from './config/types.ts';
import type {
  AgentSkillStatus,
  CodiffLaunchOptions,
  CodiffMarkdownDocument,
  CodiffPreferences,
  CodiffUpdateStatus,
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

declare module '*.css';

declare global {
  interface Window {
    codiff: {
      applyUpdate: () => Promise<CodiffUpdateStatus>;
      askReviewAssistant: (request: ReviewAssistantRequest) => Promise<ReviewAssistantResult>;
      createWalkthroughCommit: (
        request: WalkthroughCommitRequest,
      ) => Promise<WalkthroughCommitResult>;
      decreaseCodeFontSize: () => Promise<void>;
      dismissUpdate: () => Promise<CodiffUpdateStatus>;
      findDefinitions: (request: DefinitionSearchRequest) => Promise<DefinitionSearchResult>;
      getAgentModelCatalog?: (refresh?: boolean) => Promise<AgentModelCatalog>;
      getAgentPrompts?: () => Promise<Array<AgentPromptModule>>;
      getAgentSkillStatus: () => Promise<AgentSkillStatus>;
      getConfig: () => Promise<CodiffConfig>;
      getDiffImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
      getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
      getGitIdentity: () => Promise<GitIdentity>;
      getKeyboardLayout: () => Promise<NativeKeyboardLayout | null>;
      getLaunchOptions: () => Promise<CodiffLaunchOptions>;
      getMarkdownDocument: (request: {
        kind: CodiffMarkdownDocument['kind'];
        path: string;
      }) => Promise<CodiffMarkdownDocument>;
      getNarrativeWalkthrough: (
        source?: ReviewSource,
        options?: NarrativeWalkthroughRequestOptions,
      ) => Promise<NarrativeWalkthroughResult>;
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryFile: (path: string) => Promise<RepositoryFileDocument>;
      getRepositoryHistory: (limit?: number, source?: ReviewSource) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      getReviewBriefComments: (
        source: Extract<ReviewSource, { type: 'pull-request' }>,
      ) => Promise<Array<ReviewBriefPostedComment>>;
      getTerminalHelperStatus: () => Promise<TerminalHelperStatus>;
      getUpdateStatus: () => Promise<CodiffUpdateStatus>;
      increaseCodeFontSize: () => Promise<void>;
      installAgentSkill: () => Promise<AgentSkillStatus>;
      installTerminalHelper: () => Promise<TerminalHelperStatus>;
      isWindowFullScreen: () => Promise<boolean>;
      markWindowReady: () => void;
      onConfigChanged: (callback: (config: CodiffConfig) => void) => () => void;
      onCopyPendingCommentsRequest: (callback: () => string | Promise<string>) => () => void;
      onFindInDiffs: (callback: () => void) => () => void;
      onKeyboardLayoutChanged: (callback: (layout: NativeKeyboardLayout) => void) => () => void;
      onMarkdownDocumentChanged: (
        callback: (
          change:
            | { deleted: true; id: string }
            | { deleted: false; document: CodiffMarkdownDocument; id: string },
        ) => void,
      ) => () => void;
      onOpenAgentSettings?: (callback: (section: AgentSettingsSection) => void) => () => void;
      onOpenReviewSource: (callback: (kind: OpenReviewSourceKind) => void) => () => void;
      onRefreshRequest: (callback: () => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      onUpdateStatusChanged: (callback: (status: CodiffUpdateStatus) => void) => () => void;
      onWalkthroughCommitOutput: (callback: (chunk: string) => void) => () => void;
      onWalkthroughProgress: (callback: (progress: WalkthroughProgressEvent) => void) => () => void;
      onWindowFullScreenChanged: (callback: (isFullScreen: boolean) => void) => () => void;
      openConfigFile: () => Promise<void>;
      openFile: (path: string, lineNumber?: number) => Promise<void>;
      openReleasePage: () => Promise<void>;
      openRepositoryFolder: () => Promise<void>;
      resetCodeFontSize: () => Promise<void>;
      resolvePullRequestUrl: (value: string) => Promise<string>;
      saveMarkdownDocument: (
        request: SaveMarkdownDocumentRequest,
      ) => Promise<SaveMarkdownDocumentResult>;
      saveRepositoryFile: (request: SaveRepositoryFileRequest) => Promise<SaveRepositoryFileResult>;
      selectAgentModel?: (agent: CodiffAgentBackend, model: string) => Promise<void>;
      setAgentPrompt?: (id: AgentPromptId, text: string | null) => Promise<AgentPromptOverrides>;
      setDiffStyle: (value: CodiffPreferences['diffStyle']) => Promise<void>;
      setPullRequestFileViewed: (request: SetPullRequestFileViewedRequest) => Promise<void>;
      setReviewTheme: (value: CodiffPreferences['reviewTheme']) => Promise<void>;
      setShowOutdated: (value: boolean) => Promise<void>;
      setWordWrap: (value: boolean) => Promise<void>;
      showInFolder: (path: string) => Promise<void>;
      submitPullRequestComment: (
        request: SubmitPullRequestCommentRequest,
      ) => Promise<PullRequestExistingReviewComment>;
      submitPullRequestReview: (request: SubmitPullRequestReviewRequest) => Promise<void>;
      updateWalkthroughCommitMessage: (
        request: WalkthroughCommitMessageRequest,
      ) => Promise<WalkthroughCommitMessageResult>;
    };
  }
}
