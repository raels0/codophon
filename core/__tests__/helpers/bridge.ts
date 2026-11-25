import { vi } from 'vite-plus/test';
import { createDefaultConfig } from '../../config/defaults.ts';
import { repositoryState } from './fixtures.ts';
export const createFakeBridge = (
  overrides: Partial<Window['codophon']> = {},
): Window['codophon'] => ({
  askReviewAssistant: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  createWalkthroughCommit: vi.fn(async () => ({
    hash: '0000000000000000000000000000000000000000',
    status: 'committed' as const,
  })),
  dismissUpdate: vi.fn(async () => ({
    currentVersion: '1.9.2',
  })),
  findDefinitions: vi.fn(async (request) => ({
    candidates: [],
    identifier: request.identifier,
    status: 'ready' as const,
  })),
  getAgentModelCatalog: vi.fn(async () => ({ models: [] })),
  getAgentPrompts: vi.fn(async () => []),
  getAgentSkillStatus: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codophon',
  })),
  getConfig: vi.fn(async () => createDefaultConfig()),
  getDiffImageContent: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getDiffSectionContent: vi.fn(async () => {
    throw new Error('Unexpected diff section load.');
  }),
  getGitIdentity: vi.fn(async () => ({
    email: 'reviewer@example.com',
    name: 'Reviewer',
  })),
  getKeyboardLayout: vi.fn(async () => null),
  getLaunchOptions: vi.fn(async () => ({
    repositoryPathProvided: true,
    walkthrough: false,
  })),
  getMarkdownDocument: vi.fn(async ({ kind, path }) => ({
    content: '# Plan\n',
    id: `${kind}:${path}`,
    kind,
    path,
    version: 'version',
  })),
  getNarrativeWalkthrough: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getRepositoryFile: vi.fn(async (path) => ({
    content: 'new\n',
    path,
    root: '/repo',
    version: 'version',
  })),
  getRepositoryHistory: vi.fn(async () => ({
    entries: [],
    root: '/repo',
  })),
  getRepositoryState: vi.fn(async () => repositoryState({ files: [] })),
  getReviewBriefComments: vi.fn(async () => []),
  getTerminalHelperStatus: vi.fn(async () => ({
    command: 'codophon',
    installed: true,
    path: '/usr/local/bin/codophon',
  })),
  getUpdateStatus: vi.fn(async () => ({
    currentVersion: '1.9.2',
  })),
  installAgentSkill: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codophon',
  })),
  installTerminalHelper: vi.fn(async () => ({
    command: 'codophon',
    installed: true,
    path: '/usr/local/bin/codophon',
  })),
  isWindowFullScreen: vi.fn(async () => false),
  markWindowReady: vi.fn(),
  onConfigChanged: vi.fn(() => () => {}),
  onCopyPendingCommentsRequest: vi.fn(() => () => {}),
  onFindInDiffs: vi.fn(() => () => {}),
  onKeyboardLayoutChanged: vi.fn(() => () => {}),
  onMarkdownDocumentChanged: vi.fn(() => () => {}),
  onOpenAgentSettings: vi.fn(() => () => {}),
  onOpenReviewSource: vi.fn(() => () => {}),
  onRefreshRequest: vi.fn(() => () => {}),
  onRepositoryChanged: vi.fn(() => () => {}),
  onUpdateStatusChanged: vi.fn(() => () => {}),
  onWalkthroughCommitOutput: vi.fn(() => () => {}),
  onWalkthroughProgress: vi.fn(() => () => {}),
  onWindowFullScreenChanged: vi.fn(() => () => {}),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  openReleasePage: vi.fn(async () => {}),
  openRepositoryFolder: vi.fn(async () => {}),
  resolvePullRequestUrl: vi.fn(async () => 'https://github.com/owner/repo/pull/1'),
  saveMarkdownDocument: vi.fn(async (request) => ({
    document: {
      content: request.content,
      id: `${request.kind}:${request.path}`,
      kind: request.kind,
      path: request.path,
      version: 'next-version',
    },
    status: 'saved' as const,
  })),
  saveRepositoryFile: vi.fn(async (request) => ({
    document: { ...request, version: 'next-version' },
    status: 'saved' as const,
  })),
  selectAgentModel: vi.fn(async () => {}),
  setAgentPrompt: vi.fn(async () => ({})),
  setPullRequestFileViewed: vi.fn(async () => {}),
  submitPullRequestComment: vi.fn(async () => {
    throw new Error('Unexpected pull request comment submit.');
  }),
  submitPullRequestReview: vi.fn(async () => {}),
  updateSettings: vi.fn(async () => {}),
  updateWalkthroughCommitMessage: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  ...overrides,
});
