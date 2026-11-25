// @ts-check

const { contextBridge, ipcRenderer } = require('electron');

// Initialize Chromium's storage connection before showing the native window
// can block the renderer's first synchronous settings read.
try {
  void localStorage.length;
  void sessionStorage.length;
} catch {
  // The bridge must still load when Chromium storage is unavailable.
}

const launchOptions = ipcRenderer.invoke('codophon:getLaunchOptions');
/** @type {Promise<import('../core/config/types.ts').CodophonConfig> | undefined} */
let initialConfig = ipcRenderer.invoke('codophon:getConfig');
initialConfig.catch(() => {});
/** @type {Promise<import('../core/types.ts').RepositoryState | undefined> | undefined} */
let initialRepositoryState = launchOptions.then(() =>
  ipcRenderer.invoke('codophon:getRepositoryState'),
);
initialRepositoryState.catch(() => {});

const applyPlatformAttribute = () => {
  document.documentElement?.setAttribute('data-codophon-platform', process.platform);
};

if (document.documentElement) {
  applyPlatformAttribute();
} else {
  window.addEventListener('DOMContentLoaded', applyPlatformAttribute, { once: true });
}

/**
 * @template {keyof import('../core/ipc.ts').Events} K
 * @param {K} channel
 * @param {import('../core/ipc.ts').Events[K]} callback
 */
const subscribe = (channel, callback) => {
  /** @param {Electron.IpcRendererEvent} _event @param {Parameters<import('../core/ipc.ts').Events[K]>} args */
  const listener = (_event, ...args) => Reflect.apply(callback, undefined, args);
  ipcRenderer.on('codophon:' + channel, listener);
  return () => ipcRenderer.removeListener('codophon:' + channel, listener);
};

/**
 * @template {keyof import('../core/ipc.ts').Invoke} K
 * @param {K} method
 * @returns {(...args: Parameters<import('../core/ipc.ts').Invoke[K]>) => ReturnType<import('../core/ipc.ts').Invoke[K]>}
 */
const invoke =
  (method) =>
  (...args) =>
    /** @type {ReturnType<import('../core/ipc.ts').Invoke[K]>} */ (
      ipcRenderer.invoke('codophon:' + method, ...args)
    );

/** @type {Window['codophon']} */
const codophon = {
  askReviewAssistant: invoke('askReviewAssistant'),
  updateSettings: invoke('updateSettings'),
  getReviewBriefComments: invoke('getReviewBriefComments'),
  dismissUpdate: invoke('dismissUpdate'),
  installUpdate: invoke('installUpdate'),
  checkForUpdates: invoke('checkForUpdates'),
  createWalkthroughCommit: invoke('createWalkthroughCommit'),
  updateWalkthroughCommitMessage: invoke('updateWalkthroughCommitMessage'),
  getAgentSkillStatus: invoke('getAgentSkillStatus'),
  getAgentModelCatalog: invoke('getAgentModelCatalog'),
  getAgentPrompts: invoke('getAgentPrompts'),
  getConfig: () => {
    const initial = initialConfig;
    initialConfig = undefined;
    return initial ?? ipcRenderer.invoke('codophon:getConfig');
  },
  getDiffSectionContent: invoke('getDiffSectionContent'),
  getDiffImageContent: invoke('getDiffImageContent'),
  getGitIdentity: invoke('getGitIdentity'),
  getKeyboardLayout: invoke('getKeyboardLayout'),
  getLaunchOptions: () => launchOptions,
  getMarkdownDocument: invoke('getMarkdownDocument'),
  getRepositoryFile: invoke('getRepositoryFile'),
  getRepositoryHistory: invoke('getRepositoryHistory'),
  getRepositoryState: (source) => {
    const initial = source ? undefined : initialRepositoryState;
    initialRepositoryState = undefined;
    return initial
      ? initial.then((state) => state ?? ipcRenderer.invoke('codophon:getRepositoryState', source))
      : ipcRenderer.invoke('codophon:getRepositoryState', source);
  },
  getTerminalHelperStatus: invoke('getTerminalHelperStatus'),
  getUpdateStatus: invoke('getUpdateStatus'),
  getNarrativeWalkthrough: invoke('getNarrativeWalkthrough'),
  installAgentSkill: invoke('installAgentSkill'),
  installTerminalHelper: invoke('installTerminalHelper'),
  isWindowFullScreen: invoke('isWindowFullScreen'),
  markWindowReady: () => ipcRenderer.send('codophon:windowReady'),
  onConfigChanged: (callback) => subscribe('configChanged', callback),
  onOpenAgentSettings: (callback) => subscribe('openAgentSettings', callback),
  onCopyPendingCommentsRequest: (callback) => {
    const listener = (
      /** @type {Electron.IpcRendererEvent} */ _event,
      /** @type {string} */ requestId,
    ) => {
      Promise.resolve(callback()).then(
        (markdown) => {
          ipcRenderer.send(
            'codophon:copyPendingCommentsResult',
            requestId,
            typeof markdown === 'string' ? markdown : '',
          );
        },
        () => {
          ipcRenderer.send('codophon:copyPendingCommentsResult', requestId, '');
        },
      );
    };
    const channel = 'codophon:copyPendingCommentsRequest';
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onFindInDiffs: (callback) => subscribe('findInDiffs', () => callback()),
  onKeyboardLayoutChanged: (callback) => subscribe('keyboardLayoutChanged', callback),
  onOpenReviewSource: (callback) => subscribe('openReviewSource', callback),
  onMarkdownDocumentChanged: (callback) => subscribe('markdownDocumentChanged', callback),
  onWalkthroughCommitOutput: (callback) =>
    subscribe('walkthroughCommitOutput', (chunk) => callback(String(chunk))),
  onWindowFullScreenChanged: (callback) =>
    subscribe('windowFullScreenChanged', (value) => callback(Boolean(value))),
  onRepositoryChanged: (callback) => subscribe('repositoryChanged', callback),
  onWalkthroughProgress: (callback) => subscribe('walkthroughProgress', callback),
  onRefreshRequest: (callback) => subscribe('refreshRequest', () => callback()),
  onUpdateStatusChanged: (callback) => subscribe('updateStatusChanged', callback),
  findDefinitions: invoke('findDefinitions'),
  openConfigFile: invoke('openConfigFile'),
  selectAgentModel: invoke('selectAgentModel'),
  setAgentPrompt: invoke('setAgentPrompt'),
  openFile: invoke('openFile'),
  openRepositoryFolder: invoke('openRepositoryFolder'),
  resolvePullRequestUrl: invoke('resolvePullRequestUrl'),
  saveMarkdownDocument: invoke('saveMarkdownDocument'),
  saveRepositoryFile: invoke('saveRepositoryFile'),
  submitPullRequestComment: invoke('submitPullRequestComment'),
  submitPullRequestReview: invoke('submitPullRequestReview'),
  setPullRequestFileViewed: invoke('setPullRequestFileViewed'),
};

contextBridge.exposeInMainWorld('codophon', codophon);
