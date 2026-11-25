import './main/stdio.ts';
import { existsSync, readFileSync } from 'node:fs';
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
import { MAX_AGENT_PROMPT_LENGTH, agentPrompts, normalizeAgentPrompts } from './agent-prompts.ts';
import { buildInstallSkillMenuItem, listAgentSkills } from './agent-skills.ts';
import {
  detectInitialAgentBackend,
  getAgent,
  getAgentMenuModels,
  listAgents,
  normalizeAgentBackend,
} from './agent.ts';
import { normalizeClaudeModel } from './claude.ts';
import { readCodexModels } from './codex-models.ts';
import { normalizeOpenAIModel } from './codex.ts';
import {
  createDefaultConfig,
  getConfigPath,
  initConfig,
  importPreviousConfig,
  normalizeCodeFontFamily,
  normalizeCodeFontSize,
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
import { normalizeOpenCodeModel, renderOpenCodeCommand } from './opencode.ts';
import { createPendingCommentsClipboardController } from './pending-comments.ts';
import { createReleaseCheck } from './release-check.ts';
import { readReviewAssistantReply } from './review-assist.ts';
import { parseReviewUrl, resolveReviewUrl } from './review-source.ts';
import { readCommitMessageReply } from './walkthrough-commit-message.ts';
import { createWalkthroughCommit } from './walkthrough-commit.ts';
import { diagnoseWalkthroughMismatch } from './walkthrough-diagnosis.ts';
import {
  findMatchingWindowIdentity,
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
import {
  assertWalkthroughHunkIdsResolve,
  getNarrativeWalkthroughCacheKey,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} from './narrative-walkthrough.ts';
import { readRepositoryFile, writeRepositoryFile } from './repository-file.ts';
import {
  createRepositoryWatcherCoordinator,
  readRepositoryWatcherSnapshot,
} from './repository-watcher.ts';
import { mergeWalkthroughContexts } from './walkthrough-context.ts';
import { createWalkthroughProgressReporter } from './walkthrough-progress.ts';
import { readStoredWalkthrough, writeStoredWalkthrough } from './walkthrough-store.ts';
import { createWindowRevealController } from './window-reveal.ts';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
} from './window-state.ts';

export type WindowIdentity = { key: string; repositoryRoot: string; sourceKey: string };

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

const windowRevealControllers: Map<
  number,
  ReturnType<typeof createWindowRevealController>
> = new Map();

const windowIdentities: Map<number, WindowIdentity | null> = new Map();

const windowRepositories: Map<number, string> = new Map();

const windowLaunchOptions: Map<number, CodophonLaunchOptions> = new Map();

const windowInitialRepositoryStates: Map<number, Promise<RepositoryState>> = new Map();

const walkthroughProgressGenerations: Map<number, number> = new Map();

const markdownDocumentWatchers: Map<number, Map<string, () => void>> = new Map();

const openWindows: Set<import('electron').BrowserWindow> = new Set();
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
          ? (_file, template) => renderOpenCodeCommand(template, config.settings.opencodeModel)
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
  const override = windowLaunchOptions.get(webContentsId)?.agentBackend;
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

const getWindowRepositoryRoot = (webContentsId: number) =>
  windowIdentities.get(webContentsId)?.repositoryRoot ||
  windowRepositories.get(webContentsId) ||
  getLaunchPath();

const getMarkdownDocumentContext = (webContentsId: number) => ({
  repositoryRoot: getWindowRepositoryRoot(webContentsId),
});

const storeResolvedRepositoryState = (webContentsId: number, state: RepositoryState) => {
  windowRepositories.set(webContentsId, state.root);
  const browserWindow = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === webContentsId,
  );
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.setTitle(getRepositoryWindowTitle(state));
  }
  const launchOptions = windowLaunchOptions.get(webContentsId);
  if (launchOptions) {
    windowLaunchOptions.set(webContentsId, {
      ...launchOptions,
      source: state.source,
    });
  }
  const identity = getWindowIdentityForRepositoryState(state);
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
};

const clearMarkdownDocumentWatchers = (webContentsId: number) => {
  const watchers = markdownDocumentWatchers.get(webContentsId);
  if (!watchers) {
    return;
  }
  for (const close of watchers.values()) {
    close();
  }
  markdownDocumentWatchers.delete(webContentsId);
};

const ensureMarkdownDocumentWatcher = (
  webContents: import('electron').WebContents,
  request: { kind: 'repository'; path: string },
) => {
  const webContentsId = webContents.id;
  const resolved = resolveMarkdownPath(request, getMarkdownDocumentContext(webContentsId));
  const watchers = markdownDocumentWatchers.get(webContentsId) ?? new Map();
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
  markdownDocumentWatchers.set(webContentsId, watchers);
};

const sendConfigChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codophon:configChanged', config);
    }
  }
};

const updateConfig = (nextConfig: Partial<CodophonConfig>) => {
  const updatedConfig = {
    keymap: { ...config.keymap, ...nextConfig.keymap },
    settings: {
      ...config.settings,
      ...nextConfig.settings,
      agentBackend: normalizeAgentBackend(
        nextConfig.settings?.agentBackend ?? config.settings.agentBackend,
      ),
      claudeModel: normalizeClaudeModel(
        nextConfig.settings?.claudeModel ?? config.settings.claudeModel,
      ),
      codeFontFamily: normalizeCodeFontFamily(
        nextConfig.settings?.codeFontFamily ?? config.settings.codeFontFamily,
      ),
      codeFontSize: normalizeCodeFontSize(
        nextConfig.settings?.codeFontSize ?? config.settings.codeFontSize,
      ),
      openAIModel: normalizeOpenAIModel(
        nextConfig.settings?.openAIModel ?? config.settings.openAIModel,
      ),
      opencodeModel: normalizeOpenCodeModel(
        nextConfig.settings?.opencodeModel ?? config.settings.opencodeModel,
      ),
    },
  };
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
  if (config.settings[agent.modelSettingKey] === normalized) {
    return;
  }

  const modelInfo =
    agent.id === 'codex' ? codexModels?.find((item) => item.id === normalized) : undefined;
  const effort = config.settings.openAIReasoningEffort;
  updateConfig({
    settings: {
      ...config.settings,
      [agent.modelSettingKey]: normalized,
      ...(modelInfo && effort && !modelInfo.reasoningEfforts.includes(effort)
        ? { openAIReasoningEffort: '' }
        : {}),
    },
  });
};

const getAgentOptions = (agent: import('./agent.ts').Agent) => ({
  fallbackModel: agent.fallbackModel,
  model: config.settings[agent.modelSettingKey],
  ...(agent.id === 'codex'
    ? { reasoningEffort: config.settings.openAIReasoningEffort || undefined }
    : {}),

  onModelFallback: async (fallbackModel: string, originalModel: string) => {
    if (config.settings[agent.modelSettingKey] === originalModel) {
      updateConfig({ settings: { ...config.settings, [agent.modelSettingKey]: fallbackModel } });
    }
  },
});

const updateTheme = (theme: CodophonTheme) => {
  updateConfig({ settings: { ...config.settings, theme } });
};

const setCodeFontSize = (size: number) => {
  const codeFontSize = normalizeCodeFontSize(size);
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
  const selected = config.settings[agent.modelSettingKey];
  return {
    models: selected.startsWith('github-copilot/')
      ? models
      : getAgentMenuModels(agent, selected, models),
    note,
  };
};

const buildReasoningEffortSubmenu = (): Array<import('electron').MenuItemConstructorOptions> => {
  const selected = config.settings.openAIReasoningEffort;
  const model = codexModels?.find((item) => item.id === config.settings.openAIModel);
  const advertised = model ? model.reasoningEfforts : ['low', 'medium', 'high'];
  const efforts = [...new Set(['', ...advertised, ...(selected ? [selected] : [])])];
  return efforts.map((effort) => ({
    checked: selected === effort,
    click: () => updateConfig({ settings: { ...config.settings, openAIReasoningEffort: effort } }),
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
  windowRevealControllers.set(
    webContentsId,
    createWindowRevealController(window, useStartupOpacity),
  );
  openWindows.add(window);
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
  windowRepositories.set(webContentsId, identity?.repositoryRoot || repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  const initialRepositoryStatePromise =
    preloadedRepositoryState || readInitialRepositoryStateWithConfig(repositoryPath, launchOptions);
  const initialRepositoryState = initialRepositoryStatePromise?.then((state) => {
    if (!window.isDestroyed()) {
      storeResolvedRepositoryState(webContentsId, state);
    }
    return state;
  });
  initialRepositoryState?.catch(() => {});
  if (initialRepositoryState) {
    windowInitialRepositoryStates.set(webContentsId, initialRepositoryState);
  }
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
    openWindows.delete(window);
    definitionSearchCoordinator.cancel(webContentsId);
    repositoryWatcherCoordinator.detach(webContentsId);
    clearMarkdownDocumentWatchers(webContentsId);
    windowIdentities.delete(webContentsId);
    windowRevealControllers.delete(webContentsId);
    windowInitialRepositoryStates.delete(webContentsId);
    walkthroughLaunchController.clear(webContentsId);
    walkthroughProgressGenerations.delete(webContentsId);
    windowRepositories.delete(webContentsId);
    windowLaunchOptions.delete(webContentsId);
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
  if (windowRevealControllers.get(window.webContents.id)?.isPending()) {
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
  const matchingWebContentsId = findMatchingWindowIdentity(identity, windowIdentities);
  const matchingWindow =
    matchingWebContentsId == null
      ? null
      : BrowserWindow.getAllWindows().find(
          (window) => window.webContents.id === matchingWebContentsId,
        );

  if (matchingWindow && matchingWebContentsId != null) {
    if (launchOptions.walkthrough || launchOptions.walkthroughFile) {
      walkthroughLaunchController.clear(matchingWebContentsId);
      windowRepositories.set(matchingWebContentsId, identity?.repositoryRoot || repositoryPath);
      windowLaunchOptions.set(matchingWebContentsId, launchOptions);
      windowInitialRepositoryStates.set(
        matchingWebContentsId,
        preloadedRepositoryState ||
          readInitialRepositoryStateWithConfig(repositoryPath, launchOptions),
      );
      if (identity) {
        windowIdentities.set(matchingWebContentsId, identity);
      }
      matchingWindow.reload();
    }
    focusWindow(matchingWindow);
    return matchingWindow;
  }

  return createWindow(repositoryPath, launchOptions, identity, preloadedRepositoryState);
};

const walkthroughLaunchController = createWalkthroughLaunchController({
  hasWindows: () => BrowserWindow.getAllWindows().length > 0,
  openWindow: focusOrCreateWindow,
  quit: () => app.quit(),
  readRepositoryState: readInitialRepositoryStateWithConfig,
});

const INITIAL_RELEASE_CHECK_DELAY_MS = 10 * 1000;
const RELEASE_CHECK_TIMER_INTERVAL_MS = 4 * 60 * 60 * 1000;

let releaseCheck: ReturnType<typeof createReleaseCheck> | null = null;

const sendUpdateStatusChanged = (status: import('../core/types.ts').CodophonUpdateStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('codophon:updateStatusChanged', status);
    }
  }
};

const checkForUpdatesFromMenu = async () => {
  const status = await releaseCheck?.check({ force: true });
  if (status && !status.availableVersion) {
    void dialog.showMessageBox({
      message: `Codophon ${app.getVersion()} is the latest release.`,
      type: 'info',
    });
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
    config.settings.openAIModel = normalizeOpenAIModel(config.settings.openAIModel);
    config.settings.opencodeModel = normalizeOpenCodeModel(config.settings.opencodeModel);
    config.settings.claudeModel = normalizeClaudeModel(config.settings.claudeModel);
    config.settings.agentBackend = shouldDetectInitialAgent
      ? detectInitialAgentBackend()
      : normalizeAgentBackend(config.settings.agentBackend);
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

    releaseCheck = createReleaseCheck({
      currentVersion: app.getVersion(),
      enabled: config.settings.checkForUpdates && app.isPackaged,
      onChange: sendUpdateStatusChanged,
      stateDirectory: app.getPath('userData'),
    });
    const runReleaseCheck = () => void releaseCheck?.check();
    setTimeout(runReleaseCheck, INITIAL_RELEASE_CHECK_DELAY_MS).unref();
    setInterval(runReleaseCheck, RELEASE_CHECK_TIMER_INTERVAL_MS).unref();

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
      config = {
        ...nextConfig,
        settings: {
          ...nextConfig.settings,
          agentBackend: normalizeAgentBackend(nextConfig.settings.agentBackend),
          claudeModel: normalizeClaudeModel(nextConfig.settings.claudeModel),
          codeFontFamily: normalizeCodeFontFamily(nextConfig.settings.codeFontFamily),
          codeFontSize: normalizeCodeFontSize(nextConfig.settings.codeFontSize),
          openAIModel: normalizeOpenAIModel(nextConfig.settings.openAIModel),
          opencodeModel: normalizeOpenCodeModel(nextConfig.settings.opencodeModel),
        },
      };
      releaseCheck?.setEnabled(config.settings.checkForUpdates && app.isPackaged);
      refreshInstalledAgentFiles();
      nativeTheme.themeSource = config.settings.theme;
      sendConfigChanged();
      Menu.setApplicationMenu(buildApplicationMenu());
      if (previousAgent !== 'codex' && getActiveAgent().id === 'codex') void loadCodexModels();
    });
  });

  app.on('will-quit', () => codexModelDiscoveryAbort.abort());

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

ipcMain.handle(
  'codophon:getUpdateStatus',
  () => releaseCheck?.getStatus() ?? { currentVersion: app.getVersion() },
);

ipcMain.handle(
  'codophon:dismissUpdate',
  () => releaseCheck?.dismiss() ?? { currentVersion: app.getVersion() },
);

ipcMain.handle('codophon:openReleasePage', () => {
  if (releaseCheck) {
    return shell.openExternal(releaseCheck.releaseUrl());
  }
});

ipcMain.handle('codophon:getRepositoryState', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const walkthroughState = walkthroughLaunchController.getInitialRepositoryState(
    event.sender.id,
    source,
  );
  const initialState = walkthroughState
    ? Promise.resolve(walkthroughState)
    : !source
      ? windowInitialRepositoryStates.get(event.sender.id)
      : undefined;
  if (initialState) {
    windowInitialRepositoryStates.delete(event.sender.id);
  }
  const state = initialState
    ? await initialState
    : await readRepositoryStateWithConfig(repositoryPath, source || launchOptions?.source);
  storeResolvedRepositoryState(event.sender.id, state);
  rememberLastRepositoryPath(state.root);
  void resetRepositoryWatcher(event.sender.id, state.root);
  return state;
});

ipcMain.handle('codophon:resolvePullRequestUrl', (event, value) => {
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
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return resolveReviewUrl(repositoryPath, Number(number[1]));
});

ipcMain.handle('codophon:getMarkdownDocument', async (event, request) => {
  const document = await readMarkdownDocument(request, getMarkdownDocumentContext(event.sender.id));
  ensureMarkdownDocumentWatcher(event.sender, request);
  return document;
});

ipcMain.handle('codophon:getRepositoryFile', (event, path) =>
  readRepositoryFile(getWindowRepositoryRoot(event.sender.id), path),
);

ipcMain.handle('codophon:saveRepositoryFile', async (event, request) => {
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

ipcMain.handle('codophon:saveMarkdownDocument', async (event, request) => {
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

ipcMain.handle(
  'codophon:getLaunchOptions',
  (event) =>
    windowLaunchOptions.get(event.sender.id) || {
      repositoryPathProvided: false,
      walkthrough: false,
    },
);

ipcMain.handle('codophon:getAgentSkillStatus', (event) => {
  const installer = skillInstallerFor(resolveWindowAgent(event.sender.id).id);
  return installer ? installer.getStatus() : { installed: false, path: '' };
});

ipcMain.handle('codophon:installAgentSkill', async (event) => {
  const installer = skillInstallerFor(resolveWindowAgent(event.sender.id).id);
  if (!installer) {
    return { installed: false, path: '' };
  }

  await installer.install(BrowserWindow.fromWebContents(event.sender));
  return installer.getStatus();
});

ipcMain.handle('codophon:getTerminalHelperStatus', () => getTerminalHelperStatus());

ipcMain.handle('codophon:installTerminalHelper', async (event) => {
  await installTerminalHelper(BrowserWindow.fromWebContents(event.sender));
  return getTerminalHelperStatus();
});

ipcMain.handle('codophon:getNarrativeWalkthrough', async (event, source, options) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const progressGeneration = (walkthroughProgressGenerations.get(event.sender.id) || 0) + 1;
  walkthroughProgressGenerations.set(event.sender.id, progressGeneration);
  const reportProgress = createWalkthroughProgressReporter(
    event.sender,
    () => walkthroughProgressGenerations.get(event.sender.id) === progressGeneration,
  );

  try {
    const agent = resolveWindowAgent(event.sender.id);
    const initialWalkthrough = walkthroughLaunchController.takeInitialWalkthrough(
      event.sender.id,
      source,
    );
    if (initialWalkthrough) {
      const sessionContext = await Promise.resolve(
        agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
      ).catch(() => null);
      return {
        status: 'ready',
        walkthrough: {
          ...initialWalkthrough,
          agent: agent.id,
          ...(sessionContext ? { context: sessionContext } : {}),
        },
      };
    }
    const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
    const state = await readRepositoryStateWithConfig(
      repositoryPath,
      source || launchOptions?.source,
    );
    const walkthroughFile = launchOptions?.walkthroughFile;
    if (walkthroughFile) {
      let contents;
      let input;
      try {
        contents = readFileSync(walkthroughFile, 'utf8');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      const sessionContext = await Promise.resolve(
        agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
      ).catch(() => null);
      try {
        input = JSON.parse(contents);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      try {
        assertWalkthroughHunkIdsResolve(input, state.files);
        return {
          status: 'ready',
          walkthrough: normalizeNarrativeWalkthrough(input, state.files, {
            agent: agent.id,
            branch: state.branch,
            context: sessionContext ?? undefined,
            generatedAt: state.generatedAt,
            root: state.root,
            source: state.source,
          }),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // The usual cause of an unanchored working-tree walkthrough is that the
        // changes were committed (or reverted) after it was authored. Surface a
        // specific explanation when we can determine one.
        const diagnosis = await diagnoseWalkthroughMismatch({
          hasFiles: state.files.length > 0,
          input,
          repositoryRoot: state.root,
        }).catch(() => null);
        return {
          reason: diagnosis || `Walkthrough file could not be applied to this diff: ${detail}`,
          status: 'unavailable',
        };
      }
    }

    const walkthroughContext = mergeWalkthroughContexts(
      launchOptions?.walkthroughContext,
      await agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
    );
    const agentOptions = getAgentOptions(agent);
    const walkthroughModel = resolveNarrativeWalkthroughModel(
      state,
      agent,
      agentOptions.model,
      agentOptions.reasoningEffort,
    );
    const { walkthroughPrompt, agentPrompts: prompts } = config.settings;
    const cacheKey = getNarrativeWalkthroughCacheKey(
      state,
      agent,
      walkthroughModel,
      walkthroughContext,
      walkthroughPrompt,
      agentOptions.reasoningEffort,
      prompts,
    );
    if (!options?.force) {
      const cachedWalkthrough = readStoredWalkthrough(cacheKey);
      if (cachedWalkthrough) {
        return {
          status: 'ready',
          walkthrough: {
            ...cachedWalkthrough,
            ...(walkthroughContext ? { context: walkthroughContext } : {}),
            agent: agent.id,
            repo: {
              branch: state.branch,
              root: state.root,
            },
            source: state.source,
          },
        };
      }
    }

    let generatedModel = walkthroughModel;
    const onModelFallback = agentOptions.onModelFallback;
    const result = await readNarrativeWalkthrough(
      state,
      agent,
      {
        ...agentOptions,
        model: walkthroughModel,
        onModelFallback: async (fallbackModel: string, originalModel: string) => {
          generatedModel = fallbackModel;
          await onModelFallback(fallbackModel, originalModel);
        },
        onProgress: reportProgress,
      },
      walkthroughContext,
      walkthroughPrompt,
      options?.previousWalkthrough,
      prompts,
    );
    if (result.status === 'ready') {
      const generatedCacheKey = getNarrativeWalkthroughCacheKey(
        state,
        agent,
        generatedModel,
        walkthroughContext,
        walkthroughPrompt,
        agentOptions.reasoningEffort,
        prompts,
      );
      try {
        const { context: _context, ...cacheableWalkthrough } = result.walkthrough!;
        writeStoredWalkthrough(generatedCacheKey, cacheableWalkthrough);
      } catch {
        // Caching is optional; a filesystem failure must not hide a generated result.
      }
    }
    return result;
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
});

ipcMain.handle('codophon:askReviewAssistant', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
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

ipcMain.handle('codophon:createWalkthroughCommit', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
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

ipcMain.handle('codophon:updateWalkthroughCommitMessage', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
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

ipcMain.handle('codophon:submitPullRequestComment', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return submitPullRequestComment(repositoryPath, request);
});

ipcMain.handle('codophon:getReviewBriefComments', async (event, source) => {
  if (source?.type !== 'pull-request' || source.provider !== 'azure-devops') {
    throw new Error('Posted-comment export requires an Azure DevOps pull request.');
  }
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readAzureDevOpsReviewBriefComments(repositoryPath, source);
});

ipcMain.handle('codophon:submitPullRequestReview', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return submitPullRequestReview(repositoryPath, request);
});

ipcMain.handle('codophon:setPullRequestFileViewed', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return setPullRequestFileViewed(repositoryPath, request);
});

ipcMain.handle('codophon:getDiffSectionContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readDiffSectionContent(repositoryPath, {
    ...request,
    showWhitespace: request?.showWhitespace ?? config.settings.showWhitespace,
  });
});

ipcMain.handle('codophon:getDiffImageContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readDiffImageContent(repositoryPath, request);
});

ipcMain.handle('codophon:getRepositoryHistory', async (event, limit, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return listRepositoryHistory(repositoryPath, limit, source);
});

ipcMain.handle('codophon:getGitIdentity', async (event) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readGitIdentity(repositoryPath);
});

ipcMain.handle('codophon:getConfig', () => config);
ipcMain.handle('codophon:getAgentModelCatalog', (event, refresh) =>
  getAgentModelCatalog(event.sender.id, refresh === true),
);
ipcMain.handle('codophon:selectAgentModel', (event, agentId, model) => {
  const agent = resolveWindowAgent(event.sender.id);
  if (agent.id !== agentId) throw new Error('The active agent changed. Refresh the model list.');
  if (typeof model !== 'string' || !model || agent.normalizeModel(model) !== model) {
    throw new Error('Invalid model for the active agent.');
  }
  selectAgentModel(agent, model);
});
ipcMain.handle('codophon:getAgentPrompts', () => agentPrompts);
ipcMain.handle('codophon:setAgentPrompt', (_event, id, text) => {
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

ipcMain.handle('codophon:getKeyboardLayout', () => readKeyboardLayout());

ipcMain.handle('codophon:isWindowFullScreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window?.isFullScreen() ?? false;
});

ipcMain.on('codophon:windowReady', (event) => {
  windowRevealControllers.get(event.sender.id)?.markContentReady();
});

ipcMain.handle('codophon:setDiffStyle', (_event, value) => {
  updateConfig({
    settings: {
      ...config.settings,
      diffStyle: value === 'unified' ? 'unified' : 'split',
    },
  });
});

ipcMain.handle('codophon:setReviewTheme', (_event, value) => {
  if (value !== 'neutral' && value !== 'blue-amber') {
    throw new TypeError('Unknown review theme.');
  }
  updateConfig({ settings: { ...config.settings, reviewTheme: value } });
});

ipcMain.handle('codophon:setShowOutdated', (_event, value) => {
  updateConfig({ settings: { ...config.settings, showOutdated: Boolean(value) } });
});

ipcMain.handle('codophon:setWordWrap', (_event, value) => {
  updateConfig({ settings: { ...config.settings, wordWrap: Boolean(value) } });
});

ipcMain.handle('codophon:increaseCodeFontSize', () => {
  increaseCodeFontSize();
});

ipcMain.handle('codophon:decreaseCodeFontSize', () => {
  decreaseCodeFontSize();
});

ipcMain.handle('codophon:resetCodeFontSize', () => {
  resetCodeFontSize();
});

ipcMain.handle('codophon:openConfigFile', () => openConfigFile());

ipcMain.handle('codophon:openRepositoryFolder', (event) =>
  openRepositoryFolder(BrowserWindow.fromWebContents(event.sender) ?? undefined),
);

ipcMain.handle('codophon:findDefinitions', (event, request) =>
  definitionSearchCoordinator.find(
    event.sender.id,
    getWindowRepositoryRoot(event.sender.id),
    request,
  ),
);

ipcMain.handle('codophon:openFile', async (event, filePath, lineNumber) => {
  const repositoryRoot = getWindowRepositoryRoot(event.sender.id);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(repositoryRoot, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath, {
      lineNumber: Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber : undefined,
      repoPath: repositoryRoot,
    });
  } else {
    await shell.openPath(repositoryRoot);
  }
});
