import { existsSync } from 'node:fs';
import './main/stdio.ts';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
} from 'electron';
import type { Invoke } from '../core/ipc.ts';
import { MAX_AGENT_PROMPT_LENGTH, agentPrompts, normalizeAgentPrompts } from './agent-prompts.ts';
import { buildInstallSkillMenuItem, listAgentSkills } from './agent-skills.ts';
import {
  detectInitialAgentBackend,
  getAgent,
  getAgentMenuModels,
  listAgents,
  normalizeAgentBackend,
} from './agent.ts';
import { readCodexModels } from './codex-models.ts';
import {
  createDefaultConfig,
  getConfigPath,
  initConfig,
  importPreviousConfig,
  mergeConfig,
  readConfig,
  watchConfig,
  writeConfig,
} from './config.ts';
import { createCopilotModelLoader } from './copilot-models.ts';
import { attachExternalLinkHandling } from './external-links.ts';
import {
  listRepositoryHistory,
  readDiffImageContent,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryState,
  readWalkthroughRepositoryState,
  setPullRequestFileViewed,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} from './git-state.ts';
import { readAzureDevOpsReviewBriefComments } from './git-state/azure-devops.ts';
import { readKeyboardLayout, watchKeyboardLayout } from './keyboard-layout.ts';
import { getInitialRepositoryPath, readLaunch } from './main/launch-request.ts';
import { renderOpenCodeCommand } from './opencode.ts';
import { createPendingCommentsClipboardController } from './pending-comments.ts';
import { readReviewAssistantReply } from './review-assist.ts';
import { parseReviewUrl, resolveReviewUrl } from './review-source.ts';
import { createUpdater, fetchLatestRelease, getInstallTarget } from './updater.ts';
import { readCommitMessageReply } from './walkthrough-commit-message.ts';
import { createWalkthroughCommit } from './walkthrough-commit.ts';
import { loadWalkthrough } from './walkthrough-service.ts';
import {
  findMatchingSession,
  type WindowIdentity,
  getWindowIdentity,
  getWindowIdentityForRepositoryState,
} from './window-identity.ts';
import { getRepositoryWindowTitle, restoreRepositoryWindowTitleAfterLoad } from './window-title.ts';

// What this process was started to open. Later launches arrive through `second-instance`.

let initialLaunch: ReturnType<typeof readLaunch> | undefined;
const getInitialLaunch = () => (initialLaunch ??= readLaunch(process.argv));
const getLaunchPath = () => getInitialLaunch().repositoryPath;
const getLaunchOptions = () => getInitialLaunch().launchOptions;
import type { MenuItemConstructorOptions } from 'electron';
import { isAgentBackend, type AgentBackend } from '../core/config/agents.ts';
import type { CodophonConfig } from '../core/config/types.ts';
import type {
  CodophonLaunchOptions,
  CodophonTheme,
  RepositoryState,
  ReviewSource,
} from '../core/types.ts';
import { createDefinitionSearchCoordinator } from './definition-search.ts';
import { createSkillInstaller } from './main/agent-skill.ts';
import { createEditorOpener } from './main/editor.ts';
import { createTerminalHelper } from './main/terminal-helper.ts';
import { createWalkthroughLaunchController } from './main/walkthrough-launch.ts';
import {
  MarkdownDocumentConflictError,
  readMarkdownDocument,
  resolveMarkdownPath,
  watchMarkdownDocument,
  writeMarkdownDocument,
} from './markdown-document.ts';
import { readRepositoryFile, writeRepositoryFile } from './repository-file.ts';
import {
  createRepositoryWatcherCoordinator,
  readRepositoryWatcherSnapshot,
} from './repository-watcher.ts';
import { createWalkthroughProgressReporter } from './walkthrough-progress.ts';
import { createWindowRevealController } from './window-reveal.ts';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
} from './window-state.ts';

export type GitHubRemote = { direction: string; name: string; owner: string; repo: string };

export type SingleInstanceAdditionalData = {
  repositoryPath: string;
  launchOptions?: CodophonLaunchOptions;
};

export type EditorCommand = { args: Array<string>; command: string };

export type ParsedCommandLineArguments = {
  launchOptions: CodophonLaunchOptions;
  pullRequestNumber: number | null;
  repositoryPath: string | null;
};

const root = dirname(import.meta.dirname);

type WindowSession = {
  window: BrowserWindow;
  repositoryPath: string;
  identity: WindowIdentity | null;
  launch: CodophonLaunchOptions;
  reveal: ReturnType<typeof createWindowRevealController>;
  initialState?: Promise<RepositoryState>;
  progressGeneration: number;
  markdownWatchers: Map<string, () => void>;
};
const sessions = new Map<number, WindowSession>();
const getSession = (id: number) => {
  const session = sessions.get(id);
  if (!session) throw new Error('The review window is closed.');
  return session;
};
const pendingCommentsClipboardController = createPendingCommentsClipboardController({ clipboard });

let config: CodophonConfig = createDefaultConfig();

let codexModels: ReadonlyArray<import('./codex-models.ts').CodexModel> | undefined;

let codexModelDiscovery: Promise<void> | undefined;
const loadCopilotModels = createCopilotModelLoader();
const codexModelDiscoveryAbort = new AbortController();

const skillInstallers: Map<string, ReturnType<typeof createSkillInstaller>> = new Map(
  listAgentSkills().map((skill) => [
    skill.id,
    createSkillInstaller({
      app,
      dialog,
      renderManagedFile:
        skill.id === 'opencode'
          ? (_file, template) =>
              renderOpenCodeCommand(template, config.settings.agents.opencode.model)
          : undefined,
      root,
      skill,
    }),
  ]),
);

const refreshInstalledAgentFiles = () => {
  for (const installer of skillInstallers.values()) {
    try {
      installer.refreshManagedFiles();
    } catch {
      // A stale or read-only managed file should not prevent Codophon from starting.
    }
  }
};

const getActiveAgent = () => getAgent(config.settings.agentBackend);

const readRepositoryStateWithConfig = (repositoryPath: string, source?: ReviewSource) =>
  readRepositoryState(repositoryPath, source, {
    showWhitespace: config.settings.showWhitespace,
  });

const readInitialRepositoryStateWithConfig = (
  repositoryPath: string,
  launchOptions: CodophonLaunchOptions,
) =>
  launchOptions.walkthrough && !launchOptions.walkthroughFile
    ? readWalkthroughRepositoryState(repositoryPath, launchOptions.source, {
        showWhitespace: config.settings.showWhitespace,
      })
    : readRepositoryStateWithConfig(repositoryPath, launchOptions.source);

const resolveWindowAgent = (webContentsId: number) => {
  const override = getSession(webContentsId).launch.agentBackend;
  return getAgent(isAgentBackend(override) ? override : config.settings.agentBackend);
};

const skillInstallerFor = (agentId: AgentBackend) => skillInstallers.get(agentId);
const { getTerminalHelperStatus, installTerminalHelper } = createTerminalHelper({
  app,
  dialog,
  root,
});
const { openFileInEditor } = createEditorOpener({
  getEditorCommand: () => config.settings.editorCommand,
  shell,
});
const definitionSearchCoordinator = createDefinitionSearchCoordinator();

const openConfigFile = async () => {
  initConfig();
  await openFileInEditor(getConfigPath());
};

const getWindowRepositoryRoot = (webContentsId: number) => getSession(webContentsId).repositoryPath;

const getMarkdownDocumentContext = (webContentsId: number) => ({
  repositoryRoot: getWindowRepositoryRoot(webContentsId),
});

const storeResolvedRepositoryState = (webContentsId: number, state: RepositoryState) => {
  const session = sessions.get(webContentsId);
  if (!session) return;
  session.repositoryPath = state.root;
  session.launch = { ...session.launch, source: state.source };
  session.identity = getWindowIdentityForRepositoryState(state);
  session.window.setTitle(getRepositoryWindowTitle(state));
};

const ensureMarkdownDocumentWatcher = (
  webContents: import('electron').WebContents,
  request: { kind: 'repository'; path: string },
) => {
  const webContentsId = webContents.id;
  const resolved = resolveMarkdownPath(request, getMarkdownDocumentContext(webContentsId));
  const watchers = getSession(webContentsId).markdownWatchers;
  if (watchers.has(resolved.id)) {
    return;
  }

  watchers.set(
    resolved.id,
    watchMarkdownDocument({
      onChange: (document) => {
        if (!webContents.isDestroyed()) {
          webContents.send('codophon:markdownDocumentChanged', {
            deleted: false,
            document,
            id: document.id,
          });
        }
      },
      onDelete: (id) => {
        if (!webContents.isDestroyed()) {
          webContents.send('codophon:markdownDocumentChanged', { deleted: true, id });
        }
      },
      resolved,
    }),
  );
};

const sendConfigChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codophon:configChanged', config);
    }
  }
};

const updateConfig = (nextConfig: Partial<CodophonConfig>) => {
  const updatedConfig = mergeConfig({ ...config, ...nextConfig });
  writeConfig(updatedConfig);
  config = updatedConfig;
  nativeTheme.themeSource = config.settings.theme;
  refreshInstalledAgentFiles();
  sendConfigChanged();
  Menu.setApplicationMenu(buildApplicationMenu());
};

const selectAgentBackend = (backend: AgentBackend) => {
  const agentBackend = normalizeAgentBackend(backend);
  if (config.settings.agentBackend === agentBackend) {
    return;
  }

  updateConfig({ settings: { ...config.settings, agentBackend } });
  if (agentBackend === 'codex') void loadCodexModels();
};

const selectAgentModel = (agent: import('./agent.ts').Agent, model: string) => {
  const normalized = agent.normalizeModel(model);
  if (config.settings.agents[agent.id].model === normalized) {
    return;
  }

  const modelInfo =
    agent.id === 'codex' ? codexModels?.find((item) => item.id === normalized) : undefined;
  const effort = config.settings.agents.codex.reasoningEffort;
  updateConfig({
    settings: {
      ...config.settings,
      agents: {
        ...config.settings.agents,
        [agent.id]: {
          ...config.settings.agents[agent.id],
          model: normalized,
          ...(modelInfo && effort && !modelInfo.reasoningEfforts.includes(effort)
            ? { reasoningEffort: '' }
            : {}),
        },
      },
    },
  });
};

const getAgentOptions = (agent: import('./agent.ts').Agent) => ({
  fallbackModel: agent.fallbackModel,
  model: config.settings.agents[agent.id].model,
  ...(agent.id === 'codex'
    ? { reasoningEffort: config.settings.agents.codex.reasoningEffort || undefined }
    : {}),

  onModelFallback: async (fallbackModel: string, originalModel: string) => {
    if (config.settings.agents[agent.id].model === originalModel) {
      selectAgentModel(agent, fallbackModel);
    }
  },
});

const updateTheme = (theme: CodophonTheme) => {
  updateConfig({ settings: { ...config.settings, theme } });
};

const setCodeFontSize = (size: number) => {
  const codeFontSize = size;
  if (config.settings.codeFontSize === codeFontSize) {
    return;
  }

  updateConfig({ settings: { ...config.settings, codeFontSize } });
};

const increaseCodeFontSize = () => {
  setCodeFontSize(config.settings.codeFontSize + 1);
};

const decreaseCodeFontSize = () => {
  setCodeFontSize(config.settings.codeFontSize - 1);
};

const resetCodeFontSize = () => {
  setCodeFontSize(13);
};

const rememberLastRepositoryPath = (repositoryPath: string) => {
  if (config.settings.lastRepositoryPath === repositoryPath) {
    return;
  }

  config = {
    ...config,
    settings: {
      ...config.settings,
      lastRepositoryPath: repositoryPath,
    },
  };
  writeConfig(config);
};

const readSafeRepositoryWatcherSnapshot = async (
  repositoryRoot: string,
  exactPaths: Iterable<string> = [],
  knownDirtyPaths: Iterable<string> = [],
) => {
  try {
    return await readRepositoryWatcherSnapshot(repositoryRoot, exactPaths, knownDirtyPaths);
  } catch (error) {
    return {
      head: `error:${error instanceof Error ? error.message : String(error)}`,
      pathSignatures: {},
      pathVersions: {},
      root: repositoryRoot,
      signature: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const repositoryWatcherCoordinator = createRepositoryWatcherCoordinator({
  readSnapshot: readSafeRepositoryWatcherSnapshot,
});

const resetRepositoryWatcher = (webContentsId: number, repositoryPath: string) =>
  repositoryWatcherCoordinator.reset(webContentsId, repositoryPath);

const beginRepositorySelfWrite = (webContentsId: number, path: string) =>
  repositoryWatcherCoordinator.beginWrite(webContentsId, path);

const finishRepositorySelfWrite = (
  token: ReturnType<typeof beginRepositorySelfWrite>,
  version: string | null,
) => repositoryWatcherCoordinator.finishWrite(token, version);

const startRepositoryWatcher = (
  browserWindow: import('electron').BrowserWindow,
  repositoryPath: string,
) => {
  const webContentsId = browserWindow.webContents.id;
  void repositoryWatcherCoordinator.attach({
    getState: () => ({
      focused: !browserWindow.isDestroyed() && browserWindow.isFocused(),
      visible:
        !browserWindow.isDestroyed() && browserWindow.isVisible() && !browserWindow.isMinimized(),
    }),
    id: webContentsId,
    notify: (root) => {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send('codophon:repositoryChanged', { root });
      }
    },
    root: repositoryPath,
  });
};

const openRepositoryFolder = async (browserWindow: import('electron').BaseWindow | undefined) => {
  const options = {
    properties: ['openDirectory'] as Array<'openDirectory'>,
  };
  const result = browserWindow
    ? await dialog.showOpenDialog(browserWindow, options)
    : await dialog.showOpenDialog(options);

  if (!result.canceled && result.filePaths[0]) {
    focusOrCreateWindow(result.filePaths[0], { repositoryPathProvided: true, walkthrough: false });
  }
};

const buildAgentSubmenu = (): Array<import('electron').MenuItemConstructorOptions> =>
  listAgents().map((agent) => ({
    checked: config.settings.agentBackend === agent.id,
    click: () => selectAgentBackend(agent.id),
    label: agent.label,
    type: 'radio',
  }));

const loadCodexModels = () => {
  codexModelDiscovery ??= readCodexModels({ signal: codexModelDiscoveryAbort.signal })
    .then((models) => {
      if (models.length && !codexModelDiscoveryAbort.signal.aborted) {
        codexModels = models;
        Menu.setApplicationMenu(buildApplicationMenu());
      }
    })
    .catch(() => {
      codexModelDiscovery = undefined;
    });
  return codexModelDiscovery;
};

const getAgentModelCatalog = async (
  webContentsId: number,
  refresh: boolean,
): Promise<import('../core/config/types.ts').AgentModelCatalog> => {
  const agent = resolveWindowAgent(webContentsId);
  let models = agent.models;
  let note;
  if (agent.id === 'codex') {
    await loadCodexModels();
    models = codexModels ?? models;
  } else if (agent.id === 'opencode') {
    try {
      const discovered = await loadCopilotModels(refresh);
      models = [...models, ...discovered];
      note = discovered.length
        ? 'GitHub Copilot models are synced from Copilot CLI and matched against OpenCode’s provider catalog.'
        : 'Copilot CLI and OpenCode did not report any matching GitHub Copilot models.';
    } catch (error) {
      note = error instanceof Error ? error.message : 'Could not sync Copilot CLI models.';
    }
  }
  const selected = config.settings.agents[agent.id].model;
  return {
    models: selected.startsWith('github-copilot/')
      ? models
      : getAgentMenuModels(agent, selected, models),
    note,
  };
};

const buildReasoningEffortSubmenu = (): Array<import('electron').MenuItemConstructorOptions> => {
  const selected = config.settings.agents.codex.reasoningEffort;
  const model = codexModels?.find((item) => item.id === config.settings.agents.codex.model);
  const advertised = model ? model.reasoningEfforts : ['low', 'medium', 'high'];
  const efforts = [...new Set(['', ...advertised, ...(selected ? [selected] : [])])];
  return efforts.map((effort) => ({
    checked: selected === effort,
    click: () =>
      updateConfig({
        settings: {
          ...config.settings,
          agents: {
            ...config.settings.agents,
            codex: { ...config.settings.agents.codex, reasoningEffort: effort },
          },
        },
      }),
    label: !effort ? 'Default' : advertised.includes(effort) ? effort : `Custom: ${effort}`,
    type: 'radio',
  }));
};

const getInstallSkillMenuItem = () =>
  buildInstallSkillMenuItem(
    (skill, browserWindow) => void skillInstallers.get(skill.id)?.install(browserWindow),
  );

/**
 * Native menus live in the main process, so this event lets the renderer own
 * the actual source dialog and reuse it with the command palette.
 */
const requestOpenReviewSource = (
  browserWindow: import('electron').BrowserWindow | undefined,
  kind: import('../core/types.ts').OpenReviewSourceKind,
) => {
  if (browserWindow instanceof BrowserWindow && !browserWindow.isDestroyed()) {
    browserWindow.webContents.send('codophon:openReviewSource', kind);
  }
};

const openAgentSettings =
  (
    section: 'models' | 'prompts',
  ): NonNullable<import('electron').MenuItemConstructorOptions['click']> =>
  (_item, browserWindow) => {
    if (browserWindow instanceof BrowserWindow && !browserWindow.isDestroyed()) {
      browserWindow.webContents.send('codophon:openAgentSettings', section);
    }
  };

const buildAgentMenuItems = (): Array<import('electron').MenuItemConstructorOptions> => [
  {
    label: 'Agent',
    submenu: buildAgentSubmenu(),
  },
  {
    label: 'Choose Model…',
    click: openAgentSettings('models'),
  },
  ...(getActiveAgent().id === 'codex'
    ? [{ label: 'Reasoning Effort', submenu: buildReasoningEffortSubmenu() }]
    : []),
  { type: 'separator' },
  {
    click: () => {
      void openConfigFile();
    },
    label: 'Open Config File...',
  },
  { label: 'Agent Settings…', click: openAgentSettings('prompts') },
  { type: 'separator' },
  {
    click: ((
      _menuItem: any,
      browserWindow: Electron.CrossProcessExports.BaseWindow | null | undefined,
    ) => installTerminalHelper(browserWindow)) as NonNullable<MenuItemConstructorOptions['click']>,
    label: 'Install Terminal Helper',
  },
  getInstallSkillMenuItem(),
  { type: 'separator' },
];

const buildApplicationMenu = (): import('electron').Menu =>
  Menu.buildFromTemplate([
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Codophon',
            submenu: [
              { role: 'about' },
              {
                click: () => {
                  void checkForUpdatesFromMenu();
                },
                label: 'Check for Updates…',
              },
              { type: 'separator' },
              {
                click: (_menuItem: any, browserWindow: BrowserWindow | undefined) =>
                  requestOpenReviewSource(browserWindow, 'pull-request'),
                label: 'Open PR',
              },
              {
                click: (_menuItem: any, browserWindow: BrowserWindow | undefined) =>
                  requestOpenReviewSource(browserWindow, 'commit'),
                label: 'Open Commit',
              },
              {
                click: (_menuItem: any, browserWindow: BrowserWindow | undefined) =>
                  requestOpenReviewSource(browserWindow, 'branch'),
                label: 'Open Branch',
              },
              { type: 'separator' },
              ...buildAgentMenuItems(),
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...(process.platform === 'darwin' ? [] : buildAgentMenuItems()),
        {
          accelerator: 'CommandOrControl+O',
          click: (_menuItem, browserWindow) => openRepositoryFolder(browserWindow),
          label: 'Open Folder...',
        },
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? []
          : [
              {
                click: () => void checkForUpdatesFromMenu(),
                label: 'Check for Updates…',
              },
              { type: 'separator' as const },
            ]),
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          accelerator: 'CommandOrControl+F',
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.send('codophon:findInDiffs');
            }
          },
          label: 'Find in Diffs',
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Diff',
          submenu: [
            {
              checked: config.settings.diffStyle === 'split',
              click: () => {
                updateConfig({
                  settings: { ...config.settings, diffStyle: 'split' },
                });
              },
              label: 'Split',
              type: 'radio',
            },
            {
              checked: config.settings.diffStyle === 'unified',
              click: () => {
                updateConfig({
                  settings: { ...config.settings, diffStyle: 'unified' },
                });
              },
              label: 'Unified',
              type: 'radio',
            },
            { type: 'separator' },
            {
              checked: config.settings.wordWrap,
              click: (menuItem) => {
                updateConfig({
                  settings: { ...config.settings, wordWrap: menuItem.checked },
                });
              },
              label: 'Word Wrap',
              type: 'checkbox',
            },
            {
              checked: config.settings.showWhitespace,
              click: (menuItem) => {
                updateConfig({
                  settings: { ...config.settings, showWhitespace: menuItem.checked },
                });
              },
              label: 'Show Whitespace',
              type: 'checkbox',
            },
            {
              checked: config.settings.expandUnchanged,
              click: (menuItem) => {
                updateConfig({
                  settings: { ...config.settings, expandUnchanged: menuItem.checked },
                });
              },
              label: 'Expand Unchanged Lines',
              type: 'checkbox',
            },
            { type: 'separator' },
            {
              label: 'Font Size',
              submenu: [
                {
                  accelerator: process.platform === 'darwin' ? 'Command+Plus' : 'Control+Plus',
                  click: increaseCodeFontSize,
                  label: 'Increase',
                },
                {
                  accelerator: 'CommandOrControl+-',
                  click: decreaseCodeFontSize,
                  label: 'Decrease',
                },
                {
                  accelerator: 'CommandOrControl+0',
                  click: resetCodeFontSize,
                  label: 'Reset',
                },
              ],
            },
          ],
        },
        {
          label: 'Comments',
          submenu: [
            {
              checked: config.settings.showOutdated,
              click: (menuItem) => {
                updateConfig({
                  settings: { ...config.settings, showOutdated: menuItem.checked },
                });
              },
              label: 'Show Outdated Comments',
              type: 'checkbox',
            },
            {
              checked: config.settings.copyCommentsOnClose,
              click: (menuItem) => {
                updateConfig({
                  settings: { ...config.settings, copyCommentsOnClose: menuItem.checked },
                });
              },
              label: 'Copy Comments on Close',
              type: 'checkbox',
            },
          ],
        },
        {
          label: 'Theme',
          submenu: [
            {
              checked: config.settings.theme === 'system',
              click: () => updateTheme('system'),
              label: 'Match System',
              type: 'radio',
            },
            {
              checked: config.settings.theme === 'light',
              click: () => updateTheme('light'),
              label: 'Light',
              type: 'radio',
            },
            {
              checked: config.settings.theme === 'dark',
              click: () => updateTheme('dark'),
              label: 'Dark',
              type: 'radio',
            },
          ],
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          // In-place refresh handled by the renderer; the window itself is
          // only reloaded via Force Reload below.
          accelerator: 'CommandOrControl+R',
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.send('codophon:refreshRequest');
            }
          },
          label: 'Refresh Changes',
        },
        { role: 'forceReload' },
        {
          accelerator: 'CommandOrControl+Alt+J',
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.toggleDevTools();
            }
          },
          label: 'Toggle Developer Tools',
        },
      ],
    },
  ] as Array<import('electron').MenuItemConstructorOptions>);

let copyingPendingCommentsBeforeQuit = false;
let quitting = false;
let quitAfterCopyingPendingComments = false;

ipcMain.on(
  'codophon:copyPendingCommentsResult',
  pendingCommentsClipboardController.handleCopyPendingCommentsResult,
);

const createWindow = (
  repositoryPath: string,
  launchOptions: CodophonLaunchOptions = { repositoryPathProvided: true, walkthrough: false },
  identity: WindowIdentity | null = getWindowIdentity(repositoryPath, launchOptions),
  preloadedRepositoryState?: Promise<RepositoryState>,
): import('electron').BrowserWindow => {
  const savedState = readWindowState();
  const validatedState = savedState
    ? validateWindowStateOnScreen(savedState, screen.getAllDisplays())
    : null;

  const display = screen.getPrimaryDisplay();
  const { height, width } = display.workAreaSize;
  const useMacVibrancy = process.platform === 'darwin';
  const useStartupOpacity = process.platform === 'darwin' || process.platform === 'win32';
  const window = new BrowserWindow({
    autoHideMenuBar: process.platform !== 'linux',
    backgroundColor: useMacVibrancy
      ? '#00000000'
      : nativeTheme.shouldUseDarkColors
        ? '#141414'
        : '#ffffff',
    height: validatedState?.height ?? Math.max(720, Math.floor(height * 0.86)),
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    opacity: useStartupOpacity ? 0 : 1,
    show: false,
    titleBarStyle: useMacVibrancy ? 'hiddenInset' : 'default',
    ...(useMacVibrancy
      ? {
          trafficLightPosition: { x: 12, y: 12 },
          transparent: true,
          vibrancy: 'under-window',
          visualEffectState: 'followWindow',
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
    width: validatedState?.width ?? Math.max(1120, Math.floor(width * 0.86)),
    ...(validatedState ? { x: validatedState.x, y: validatedState.y } : { center: true }),
  });

  if (validatedState?.isMaximized) {
    window.maximize();
  }
  if (validatedState?.isFullScreen) {
    window.setFullScreen(true);
  }

  attachExternalLinkHandling(window.webContents, (url) => shell.openExternal(url));

  const webContentsId = window.webContents.id;
  const session: WindowSession = {
    window,
    identity,
    launch: launchOptions,
    repositoryPath: identity?.repositoryRoot || repositoryPath,
    reveal: createWindowRevealController(window, useStartupOpacity),
    markdownWatchers: new Map(),
    progressGeneration: 0,
  };
  sessions.set(webContentsId, session);
  const initialRepositoryStatePromise =
    preloadedRepositoryState || readInitialRepositoryStateWithConfig(repositoryPath, launchOptions);
  const initialRepositoryState = initialRepositoryStatePromise.then((state) => {
    if (!window.isDestroyed()) {
      storeResolvedRepositoryState(webContentsId, state);
    }
    return state;
  });
  initialRepositoryState.catch(() => {});
  session.initialState = initialRepositoryState;
  if (
    !launchOptions.source ||
    launchOptions.source.type === 'branch' ||
    launchOptions.source.type === 'branch-working-tree'
  ) {
    void initialRepositoryState
      .then((state) => {
        if (
          (state.source.type === 'working-tree' || state.source.type === 'branch-working-tree') &&
          !window.isDestroyed()
        ) {
          startRepositoryWatcher(window, state.root);
        }
      })
      .catch(() => {});
  }
  window.on('blur', () => repositoryWatcherCoordinator.visibilityChanged(webContentsId));
  window.on('enter-full-screen', () => {
    window.webContents.send('codophon:windowFullScreenChanged', true);
  });
  window.on('focus', () => repositoryWatcherCoordinator.focus(webContentsId));
  window.on('hide', () => repositoryWatcherCoordinator.visibilityChanged(webContentsId));
  window.on('leave-full-screen', () => {
    window.webContents.send('codophon:windowFullScreenChanged', false);
  });
  window.on('minimize', () => repositoryWatcherCoordinator.visibilityChanged(webContentsId));
  window.on('restore', () => repositoryWatcherCoordinator.focus(webContentsId));
  window.on('show', () => repositoryWatcherCoordinator.focus(webContentsId));
  let allowClose = false;
  let copyingPendingCommentsBeforeClose = false;
  window.webContents.on('will-prevent-unload', (event) => {
    const response = dialog.showMessageBoxSync(window, {
      buttons: ['Keep Editing', 'Close Anyway'],
      cancelId: 0,
      defaultId: 0,
      message: 'Close before saving finishes?',
      detail: 'Some edits have not reached disk yet. Already auto-saved edits will be kept.',
      type: 'warning',
    });
    // Electron uses preventDefault here to allow the otherwise blocked unload.
    if (response === 1) {
      event.preventDefault();
    }
  });
  window.on('close', (event) => {
    try {
      const normalBounds = window.getNormalBounds();
      writeWindowState({
        height: normalBounds.height,
        isFullScreen: window.isFullScreen(),
        isMaximized: window.isMaximized(),
        width: normalBounds.width,
        x: normalBounds.x,
        y: normalBounds.y,
      });
    } catch {}

    if (allowClose || quitting || !config.settings.copyCommentsOnClose) {
      return;
    }

    event.preventDefault();
    if (copyingPendingCommentsBeforeClose) {
      return;
    }

    copyingPendingCommentsBeforeClose = true;
    pendingCommentsClipboardController.copyPendingCommentsToClipboard([window]).finally(() => {
      allowClose = true;
      if (!window.isDestroyed()) {
        window.close();
      }
    });
  });
  window.on('closed', () => {
    sessions.delete(webContentsId);
    definitionSearchCoordinator.cancel(webContentsId);
    repositoryWatcherCoordinator.detach(webContentsId);
    for (const close of session.markdownWatchers.values()) close();
    walkthroughLaunchController.clear(webContentsId);
  });
  window.webContents.on('render-process-gone', () => {
    definitionSearchCoordinator.cancel(webContentsId);
  });
  window.webContents.on('did-finish-load', () => {
    // The renderer's static HTML title can replace the title set while repository state loads.
    // Reapply the resolved title after every navigation so the native window list stays useful.
    void restoreRepositoryWindowTitleAfterLoad(window, initialRepositoryState).catch(() => {});
  });

  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    window.loadURL(rendererURL);
  } else {
    window.loadURL(pathToFileURL(join(root, 'dist/index.html')).toString());
  }
  return window;
};

const focusWindow = (window: import('electron').BrowserWindow) => {
  if (sessions.get(window.webContents.id)?.reveal.isPending()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  window.focus();
};

const focusOrCreateWindow = (
  repositoryPath: string,
  launchOptions: CodophonLaunchOptions = { repositoryPathProvided: true, walkthrough: false },
  preloadedRepositoryState?: Promise<RepositoryState>,
) => {
  const identity = getWindowIdentity(repositoryPath, launchOptions);
  const matching = findMatchingSession(identity, sessions.values());
  if (matching) {
    if (launchOptions.walkthrough || launchOptions.walkthroughFile) {
      walkthroughLaunchController.clear(matching.window.webContents.id);
      matching.progressGeneration++;
      matching.repositoryPath = identity?.repositoryRoot || repositoryPath;
      matching.launch = launchOptions;
      matching.initialState =
        preloadedRepositoryState ||
        readInitialRepositoryStateWithConfig(repositoryPath, launchOptions);
      matching.initialState.catch(() => {});
      matching.window.reload();
    }
    focusWindow(matching.window);
    return matching.window;
  }

  return createWindow(repositoryPath, launchOptions, identity, preloadedRepositoryState);
};

const walkthroughLaunchController = createWalkthroughLaunchController({
  hasWindows: () => BrowserWindow.getAllWindows().length > 0,
  openWindow: focusOrCreateWindow,
  quit: () => app.quit(),
  readRepositoryState: readInitialRepositoryStateWithConfig,
});

const INITIAL_UPDATE_CHECK_DELAY_MS = 10 * 1000;
const UPDATE_CHECK_TIMER_INTERVAL_MS = 4 * 60 * 60 * 1000;

let updater: ReturnType<typeof createUpdater> | null = null;

const sendUpdateStatusChanged = (status: import('../core/types.ts').CodophonUpdateStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('codophon:updateStatusChanged', status);
    }
  }
};

const checkForUpdatesFromMenu = async () => {
  const status = await updater?.check({ force: true });
  if (!updater || !status) {
    return;
  }
  if (!status.availableVersion) {
    void dialog.showMessageBox({
      message: `Codophon ${app.getVersion()} is the latest release.`,
      type: 'info',
    });
  } else if (!updater.canInstall()) {
    const { response } = await dialog.showMessageBox({
      buttons: ['Open Release Page', 'Later'],
      message: `Codophon ${status.availableVersion} is available.`,
      type: 'info',
    });
    if (response === 0) void shell.openExternal(updater.releaseUrl());
  } else {
    await updater.download();
    if (updater.getStatus().download?.state !== 'ready') return;
    const { response } = await dialog.showMessageBox({
      buttons: ['Restart to Update', 'Later'],
      detail: 'You can also restart from the sidebar, or the update installs when you quit.',
      message: `Codophon ${status.availableVersion} is ready to install.`,
      type: 'info',
    });
    if (response === 0) updater.installAndRestart();
  }
};

const lock = app.requestSingleInstanceLock({
  launchOptions: getLaunchOptions(),
  repositoryPath: getLaunchPath(),
});

if (!lock) {
  app.quit();
} else {
  app.setName('Codophon');

  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
    const data = (additionalData ?? {}) as Partial<SingleInstanceAdditionalData>;
    const launch = readLaunch(commandLine, workingDirectory);
    const launchOptions = data.launchOptions || launch.launchOptions;
    const launchPath = data.repositoryPath || launch.repositoryPath;
    void walkthroughLaunchController.open(
      getInitialRepositoryPath(launchPath, launchOptions, config.settings.lastRepositoryPath),
      launchOptions,
    );
  });

  app.on('ready', () => {
    importPreviousConfig();
    const shouldDetectInitialAgent = !existsSync(getConfigPath());
    config = readConfig();
    if (shouldDetectInitialAgent) config.settings.agentBackend = detectInitialAgentBackend();
    if (shouldDetectInitialAgent) {
      writeConfig(config);
    }
    refreshInstalledAgentFiles();
    nativeTheme.themeSource = config.settings.theme;
    Menu.setApplicationMenu(buildApplicationMenu());

    watchKeyboardLayout((layout) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('codophon:keyboardLayoutChanged', layout);
        }
      }
    });

    // End-to-end tests serve a release feed and a stand-in install locally.
    const updateFeed = process.env.CODOPHON_UPDATE_FEED;
    const updateTarget = process.env.CODOPHON_UPDATE_TARGET;
    const updatesEnabled = () =>
      config.settings.checkForUpdates && (app.isPackaged || !!updateFeed);
    updater = createUpdater({
      currentVersion: app.getVersion(),
      enabled: updatesEnabled(),
      ...(updateFeed ? { fetchRelease: () => fetchLatestRelease(updateFeed) } : {}),
      installTarget: updateTarget
        ? getInstallTarget(join(updateTarget, 'Contents', 'MacOS', 'Codophon'))
        : app.isPackaged
          ? getInstallTarget()
          : null,
      onChange: sendUpdateStatusChanged,
      quit: () => app.quit(),
      stateDirectory: app.getPath('userData'),
    });
    const runUpdateCheck = () => void updater?.check();
    setTimeout(runUpdateCheck, INITIAL_UPDATE_CHECK_DELAY_MS).unref();
    setInterval(runUpdateCheck, UPDATE_CHECK_TIMER_INTERVAL_MS).unref();

    const launchOptions = getLaunchOptions();
    void walkthroughLaunchController.open(
      getInitialRepositoryPath(getLaunchPath(), launchOptions, config.settings.lastRepositoryPath),
      launchOptions,
    );

    // Model discovery starts a login shell and an agent process. Keep it out
    // of the initial review's CPU and disk work.
    setTimeout(() => {
      if (!quitting && getActiveAgent().id === 'codex') void loadCodexModels();
    }, 1000).unref();

    watchConfig((nextConfig) => {
      const previousAgent = config.settings.agentBackend;
      config = nextConfig;
      updater?.setEnabled(updatesEnabled());
      refreshInstalledAgentFiles();
      nativeTheme.themeSource = config.settings.theme;
      sendConfigChanged();
      Menu.setApplicationMenu(buildApplicationMenu());
      if (previousAgent !== 'codex' && getActiveAgent().id === 'codex') void loadCodexModels();
    });
  });

  app.on('will-quit', () => {
    codexModelDiscoveryAbort.abort();
    updater?.installOnQuit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !walkthroughLaunchController.hasPending()) {
      const launchOptions = getLaunchOptions();
      focusOrCreateWindow(
        getInitialRepositoryPath(
          getLaunchPath(),
          launchOptions,
          config.settings.lastRepositoryPath,
        ),
        launchOptions,
      );
    }
  });

  app.on('window-all-closed', () => {
    walkthroughLaunchController.quitIfIdle();
  });

  app.on('before-quit', (event) => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
    );

    if (config.settings.copyCommentsOnClose && !quitAfterCopyingPendingComments && windows.length) {
      event.preventDefault();
      if (copyingPendingCommentsBeforeQuit) {
        return;
      }

      copyingPendingCommentsBeforeQuit = true;
      void pendingCommentsClipboardController
        .copyPendingCommentsToClipboard(windows)
        .finally(() => {
          quitAfterCopyingPendingComments = true;
          quitting = true;
          app.quit();
        });
      return;
    }

    quitting = true;
  });
}

function handle<K extends keyof Invoke>(
  method: K,
  listener: (
    event: Electron.IpcMainInvokeEvent,
    ...args: Parameters<Invoke[K]>
  ) => Awaited<ReturnType<Invoke[K]>> | ReturnType<Invoke[K]>,
) {
  ipcMain.handle('codophon:' + method, listener);
}

handle('getUpdateStatus', () => updater?.getStatus() ?? { currentVersion: app.getVersion() });

handle('dismissUpdate', () => updater?.dismiss() ?? { currentVersion: app.getVersion() });

handle('checkForUpdates', async () =>
  updater ? updater.check({ force: true }) : { currentVersion: app.getVersion() },
);

handle('installUpdate', async () => {
  if (!updater) {
    return { currentVersion: app.getVersion() };
  }
  if (updater.getStatus().download?.state === 'ready') {
    updater.installAndRestart();
  } else if (updater.canInstall()) {
    void updater.download();
  } else {
    await shell.openExternal(updater.releaseUrl());
  }
  return updater.getStatus();
});

handle('getRepositoryState', async (event, source) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  const launchOptions = getSession(event.sender.id).launch;
  const walkthroughState = walkthroughLaunchController.getInitialRepositoryState(
    event.sender.id,
    source,
  );
  const initialState = walkthroughState
    ? Promise.resolve(walkthroughState)
    : !source
      ? getSession(event.sender.id).initialState
      : undefined;
  if (initialState) {
    getSession(event.sender.id).initialState = undefined;
  }
  const state = initialState
    ? await initialState
    : await readRepositoryStateWithConfig(repositoryPath, source || launchOptions?.source);
  storeResolvedRepositoryState(event.sender.id, state);
  rememberLastRepositoryPath(state.root);
  void resetRepositoryWatcher(event.sender.id, state.root);
  return state;
});

handle('resolvePullRequestUrl', (event, value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  const parsedUrl = parseReviewUrl(input);
  if (parsedUrl) {
    return parsedUrl.url;
  }

  const number = input.match(/^#?([1-9]\d*)$/);
  if (!number) {
    throw new Error('Enter a pull request number or a GitHub or Azure DevOps pull request link.');
  }

  // Reuse the CLI resolver so a bare number follows the repository's preferred remote.
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return resolveReviewUrl(repositoryPath, Number(number[1]));
});

handle('getMarkdownDocument', async (event, request) => {
  const document = await readMarkdownDocument(request, getMarkdownDocumentContext(event.sender.id));
  ensureMarkdownDocumentWatcher(event.sender, request);
  return document;
});

handle('getRepositoryFile', (event, path) =>
  readRepositoryFile(getWindowRepositoryRoot(event.sender.id), path),
);

handle('saveRepositoryFile', async (event, request) => {
  const root = getWindowRepositoryRoot(event.sender.id);
  const current = await readRepositoryFile(root, request.path);
  const selfWrite = beginRepositorySelfWrite(event.sender.id, current.path);
  try {
    const result = await writeRepositoryFile(root, request);
    finishRepositorySelfWrite(
      selfWrite,
      result.status === 'saved' ? result.document.version : null,
    );
    return result;
  } catch (error) {
    finishRepositorySelfWrite(selfWrite, null);
    throw error;
  }
});

handle('saveMarkdownDocument', async (event, request) => {
  const context = getMarkdownDocumentContext(event.sender.id);
  let selfWrite = null;
  try {
    if (request.kind === 'repository') {
      selfWrite = beginRepositorySelfWrite(
        event.sender.id,
        resolveMarkdownPath(request, context).path,
      );
    }
    const document = await writeMarkdownDocument(request, context);
    finishRepositorySelfWrite(selfWrite, document.version);
    return { document, status: 'saved' };
  } catch (error) {
    finishRepositorySelfWrite(selfWrite, null);
    if (error instanceof MarkdownDocumentConflictError) {
      return { document: error.document, status: 'conflict' };
    }
    throw error;
  }
});

handle('getLaunchOptions', (event) => getSession(event.sender.id).launch);

handle('getAgentSkillStatus', (event) => {
  const installer = skillInstallerFor(resolveWindowAgent(event.sender.id).id);
  return installer ? installer.getStatus() : { installed: false, path: '' };
});

handle('installAgentSkill', async (event) => {
  const installer = skillInstallerFor(resolveWindowAgent(event.sender.id).id);
  if (!installer) {
    return { installed: false, path: '' };
  }

  await installer.install(BrowserWindow.fromWebContents(event.sender));
  return installer.getStatus();
});

handle('getTerminalHelperStatus', () => getTerminalHelperStatus());

handle('installTerminalHelper', async (event) => {
  await installTerminalHelper(BrowserWindow.fromWebContents(event.sender));
  return getTerminalHelperStatus();
});

handle('getNarrativeWalkthrough', async (event, source, options) => {
  const session = getSession(event.sender.id);
  const generation = ++session.progressGeneration;
  const agent = resolveWindowAgent(event.sender.id);
  return loadWalkthrough({
    agent,
    agentOptions: {
      ...getAgentOptions(agent),
      onProgress: createWalkthroughProgressReporter(
        event.sender,
        () => session.progressGeneration === generation,
      ),
    },
    launch: session.launch,
    initial: walkthroughLaunchController.takeInitialWalkthrough(event.sender.id, source),
    options,
    prompts: config.settings.agentPrompts,
    customPrompt: config.settings.agentPrompts.walkthrough,
    readState: () =>
      readRepositoryStateWithConfig(session.repositoryPath, source || session.launch.source),
  });
});

handle('askReviewAssistant', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  const launchOptions = getSession(event.sender.id).launch;
  const state = await readRepositoryStateWithConfig(
    repositoryPath,
    request?.source || launchOptions?.source,
  );
  const agent = resolveWindowAgent(event.sender.id);
  return readReviewAssistantReply(
    state,
    request,
    agent,
    getAgentOptions(agent),
    config.settings.agentPrompts,
  );
});

handle('createWalkthroughCommit', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  const result = await createWalkthroughCommit(repositoryPath, request, (chunk) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('codophon:walkthroughCommitOutput', chunk);
    }
  });
  if (result.status === 'committed') {
    await resetRepositoryWatcher(event.sender.id, repositoryPath);
  }
  return result;
});

handle('updateWalkthroughCommitMessage', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  const launchOptions = getSession(event.sender.id).launch;
  const state = await readRepositoryStateWithConfig(
    repositoryPath,
    request?.source || launchOptions?.source,
  );
  const agent = resolveWindowAgent(event.sender.id);
  return readCommitMessageReply(
    state,
    request,
    agent,
    getAgentOptions(agent),
    config.settings.agentPrompts,
  );
});

handle('submitPullRequestComment', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return submitPullRequestComment(repositoryPath, request);
});

handle('getReviewBriefComments', async (event, source) => {
  if (source?.type !== 'pull-request' || source.provider !== 'azure-devops') {
    throw new Error('Posted-comment export requires an Azure DevOps pull request.');
  }
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return readAzureDevOpsReviewBriefComments(repositoryPath, source);
});

handle('submitPullRequestReview', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return submitPullRequestReview(repositoryPath, request);
});

handle('setPullRequestFileViewed', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return setPullRequestFileViewed(repositoryPath, request);
});

handle('getDiffSectionContent', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return readDiffSectionContent(repositoryPath, {
    ...request,
    showWhitespace: request?.showWhitespace ?? config.settings.showWhitespace,
  });
});

handle('getDiffImageContent', async (event, request) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return readDiffImageContent(repositoryPath, request);
});

handle('getRepositoryHistory', async (event, limit, source) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return listRepositoryHistory(repositoryPath, limit, source);
});

handle('getGitIdentity', async (event) => {
  const repositoryPath = getSession(event.sender.id).repositoryPath;
  return readGitIdentity(repositoryPath);
});

handle('getConfig', () => config);
handle('getAgentModelCatalog', (event, refresh) =>
  getAgentModelCatalog(event.sender.id, refresh === true),
);
handle('selectAgentModel', (event, agentId, model) => {
  const agent = resolveWindowAgent(event.sender.id);
  if (agent.id !== agentId) throw new Error('The active agent changed. Refresh the model list.');
  if (typeof model !== 'string' || !model || agent.normalizeModel(model) !== model) {
    throw new Error('Invalid model for the active agent.');
  }
  selectAgentModel(agent, model);
});
handle('getAgentPrompts', () => agentPrompts);
handle('setAgentPrompt', (_event, id, text) => {
  const module = agentPrompts.find((prompt) => prompt.id === id);
  if (
    !module ||
    (text !== null &&
      (typeof text !== 'string' || !text.trim() || text.length > MAX_AGENT_PROMPT_LENGTH))
  ) {
    throw new Error('Invalid prompt. Enter non-empty guidance or restore the default.');
  }
  const overrides = normalizeAgentPrompts({ ...config.settings.agentPrompts, [module.id]: text });
  updateConfig({ settings: { ...config.settings, agentPrompts: overrides } });
  return overrides;
});

handle('getKeyboardLayout', () => readKeyboardLayout());

handle('isWindowFullScreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window?.isFullScreen() ?? false;
});

ipcMain.on('codophon:windowReady', (event) => {
  sessions.get(event.sender.id)?.reveal.markContentReady();
});

handle('updateSettings', (_event, patch) => {
  const { diffStyle, reviewTheme, showOutdated, wordWrap, codeFontSize } = patch;
  if (reviewTheme !== undefined && reviewTheme !== 'neutral' && reviewTheme !== 'blue-amber') {
    throw new TypeError('Unknown review theme.');
  }
  updateConfig({
    settings: {
      ...config.settings,
      ...(diffStyle !== undefined && { diffStyle }),
      ...(reviewTheme !== undefined && { reviewTheme }),
      ...(typeof showOutdated === 'boolean' && { showOutdated }),
      ...(typeof wordWrap === 'boolean' && { wordWrap }),
      ...(codeFontSize === 'increase' && { codeFontSize: config.settings.codeFontSize + 1 }),
      ...(codeFontSize === 'decrease' && { codeFontSize: config.settings.codeFontSize - 1 }),
      ...(codeFontSize === 'reset' && {
        codeFontSize: createDefaultConfig().settings.codeFontSize,
      }),
    },
  });
});

handle('openConfigFile', () => openConfigFile());

handle('openRepositoryFolder', (event) =>
  openRepositoryFolder(BrowserWindow.fromWebContents(event.sender) ?? undefined),
);

handle('findDefinitions', (event, request) =>
  definitionSearchCoordinator.find(
    event.sender.id,
    getWindowRepositoryRoot(event.sender.id),
    request,
  ),
);

handle('openFile', async (event, filePath, lineNumber) => {
  const repositoryRoot = getWindowRepositoryRoot(event.sender.id);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(repositoryRoot, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath, {
      lineNumber:
        lineNumber !== undefined && Number.isSafeInteger(lineNumber) && lineNumber > 0
          ? lineNumber
          : undefined,
      repoPath: repositoryRoot,
    });
  } else {
    await shell.openPath(repositoryRoot);
  }
});
