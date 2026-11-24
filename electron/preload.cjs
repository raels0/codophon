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
 * @template T
 * @param {string} channel
 * @param {(payload: T) => void} callback
 */
const subscribe = (channel, callback) => {
  /** @param {Electron.IpcRendererEvent} _event @param {T} payload */
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

/** @type {Window['codophon']} */
const codophon = {
  askReviewAssistant: (request) => ipcRenderer.invoke('codophon:askReviewAssistant', request),
  getReviewBriefComments: (source) => ipcRenderer.invoke('codophon:getReviewBriefComments', source),
  dismissUpdate: () => ipcRenderer.invoke('codophon:dismissUpdate'),
  createWalkthroughCommit: (request) =>
    ipcRenderer.invoke('codophon:createWalkthroughCommit', request),
  updateWalkthroughCommitMessage: (request) =>
    ipcRenderer.invoke('codophon:updateWalkthroughCommitMessage', request),
  getAgentSkillStatus: () => ipcRenderer.invoke('codophon:getAgentSkillStatus'),
  getAgentModelCatalog: (refresh) => ipcRenderer.invoke('codophon:getAgentModelCatalog', refresh),
  getAgentPrompts: () => ipcRenderer.invoke('codophon:getAgentPrompts'),
  getConfig: () => {
    const initial = initialConfig;
    initialConfig = undefined;
    return initial ?? ipcRenderer.invoke('codophon:getConfig');
  },
  decreaseCodeFontSize: () => ipcRenderer.invoke('codophon:decreaseCodeFontSize'),
  getDiffSectionContent: (request) => ipcRenderer.invoke('codophon:getDiffSectionContent', request),
  getDiffImageContent: (request) => ipcRenderer.invoke('codophon:getDiffImageContent', request),
  getGitIdentity: () => ipcRenderer.invoke('codophon:getGitIdentity'),
  getKeyboardLayout: () => ipcRenderer.invoke('codophon:getKeyboardLayout'),
  getLaunchOptions: () => launchOptions,
  getMarkdownDocument: (request) => ipcRenderer.invoke('codophon:getMarkdownDocument', request),
  getRepositoryFile: (path) => ipcRenderer.invoke('codophon:getRepositoryFile', path),
  getRepositoryHistory: (limit, source) =>
    ipcRenderer.invoke('codophon:getRepositoryHistory', limit, source),
  getRepositoryState: (source) => {
    const initial = source ? undefined : initialRepositoryState;
    initialRepositoryState = undefined;
    return initial
      ? initial.then((state) => state ?? ipcRenderer.invoke('codophon:getRepositoryState', source))
      : ipcRenderer.invoke('codophon:getRepositoryState', source);
  },
  getTerminalHelperStatus: () => ipcRenderer.invoke('codophon:getTerminalHelperStatus'),
  getUpdateStatus: () => ipcRenderer.invoke('codophon:getUpdateStatus'),
  getNarrativeWalkthrough: (source, options) =>
    ipcRenderer.invoke('codophon:getNarrativeWalkthrough', source, options),
  installAgentSkill: () => ipcRenderer.invoke('codophon:installAgentSkill'),
  installTerminalHelper: () => ipcRenderer.invoke('codophon:installTerminalHelper'),
  increaseCodeFontSize: () => ipcRenderer.invoke('codophon:increaseCodeFontSize'),
  isWindowFullScreen: () => ipcRenderer.invoke('codophon:isWindowFullScreen'),
  markWindowReady: () => ipcRenderer.send('codophon:windowReady'),
  onConfigChanged: (callback) => subscribe('codophon:configChanged', callback),
  onOpenAgentSettings: (callback) => subscribe('codophon:openAgentSettings', callback),
  onCopyPendingCommentsRequest: (callback) =>
    subscribe('codophon:copyPendingCommentsRequest', (requestId) => {
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
    }),
  onFindInDiffs: (callback) => subscribe('codophon:findInDiffs', () => callback()),
  onKeyboardLayoutChanged: (callback) => subscribe('codophon:keyboardLayoutChanged', callback),
  onOpenReviewSource: (callback) => subscribe('codophon:openReviewSource', callback),
  onMarkdownDocumentChanged: (callback) => subscribe('codophon:markdownDocumentChanged', callback),
  onWalkthroughCommitOutput: (callback) =>
    subscribe('codophon:walkthroughCommitOutput', (chunk) => callback(String(chunk))),
  onWindowFullScreenChanged: (callback) =>
    subscribe('codophon:windowFullScreenChanged', (value) => callback(Boolean(value))),
  onRepositoryChanged: (callback) => subscribe('codophon:repositoryChanged', callback),
  onWalkthroughProgress: (callback) => subscribe('codophon:walkthroughProgress', callback),
  onRefreshRequest: (callback) => subscribe('codophon:refreshRequest', () => callback()),
  onUpdateStatusChanged: (callback) => subscribe('codophon:updateStatusChanged', callback),
  findDefinitions: (request) => ipcRenderer.invoke('codophon:findDefinitions', request),
  openConfigFile: () => ipcRenderer.invoke('codophon:openConfigFile'),
  selectAgentModel: (agent, model) => ipcRenderer.invoke('codophon:selectAgentModel', agent, model),
  setAgentPrompt: (id, text) => ipcRenderer.invoke('codophon:setAgentPrompt', id, text),
  openReleasePage: () => ipcRenderer.invoke('codophon:openReleasePage'),
  openFile: (path, lineNumber) => ipcRenderer.invoke('codophon:openFile', path, lineNumber),
  openRepositoryFolder: () => ipcRenderer.invoke('codophon:openRepositoryFolder'),
  resolvePullRequestUrl: (value) => ipcRenderer.invoke('codophon:resolvePullRequestUrl', value),
  setDiffStyle: (value) => ipcRenderer.invoke('codophon:setDiffStyle', value),
  setReviewTheme: (value) => ipcRenderer.invoke('codophon:setReviewTheme', value),
  setShowOutdated: (value) => ipcRenderer.invoke('codophon:setShowOutdated', value),
  setWordWrap: (value) => ipcRenderer.invoke('codophon:setWordWrap', value),
  resetCodeFontSize: () => ipcRenderer.invoke('codophon:resetCodeFontSize'),
  saveMarkdownDocument: (request) => ipcRenderer.invoke('codophon:saveMarkdownDocument', request),
  saveRepositoryFile: (request) => ipcRenderer.invoke('codophon:saveRepositoryFile', request),
  submitPullRequestComment: (request) =>
    ipcRenderer.invoke('codophon:submitPullRequestComment', request),
  submitPullRequestReview: (request) =>
    ipcRenderer.invoke('codophon:submitPullRequestReview', request),
  setPullRequestFileViewed: (request) =>
    ipcRenderer.invoke('codophon:setPullRequestFileViewed', request),
};

contextBridge.exposeInMainWorld('codophon', codophon);
