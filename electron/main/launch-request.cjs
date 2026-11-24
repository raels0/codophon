// @ts-check

const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseReviewUrl } = require('../review-source.cjs');
const { readWalkthroughContext } = require('../walkthrough-context.cjs');

/**
 * What the `codophon` CLI asks the app to open. The CLI does all argument parsing and passes this
 * to Electron as one `--launch=` argument, so the app never re-parses a command line and the
 * request survives `open --args` and single-instance handoff unchanged.
 *
 * @typedef {import('../../core/types.ts').CodophonLaunchOptions} CodophonLaunchOptions
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {{
 *   agentBackend?: CodophonLaunchOptions['agentBackend'];
 *   claudeSessionId?: string;
 *   codexSessionId?: string;
 *   opencodeSessionId?: string;
 *   repositoryPath?: string;
 *   source?: ReviewSource;
 *   walkthrough?: boolean;
 *   walkthroughContextPath?: string;
 *   walkthroughFile?: string;
 *   walkthroughResultFile?: string;
 * }} LaunchRequest
 */

const LAUNCH_ARGUMENT_PREFIX = '--launch=';

/** @param {LaunchRequest} request */
const encodeLaunchRequest = (request) =>
  `${LAUNCH_ARGUMENT_PREFIX}${Buffer.from(JSON.stringify(request)).toString('base64url')}`;

/**
 * @param {ReadonlyArray<string>} argv
 * @returns {LaunchRequest}
 */
const decodeLaunchRequest = (argv) => {
  const argument = argv.findLast((value) => value.startsWith(LAUNCH_ARGUMENT_PREFIX));
  if (!argument) {
    return {};
  }
  try {
    const request = JSON.parse(
      Buffer.from(argument.slice(LAUNCH_ARGUMENT_PREFIX.length), 'base64url').toString('utf8'),
    );
    return request && typeof request === 'object' ? request : {};
  } catch {
    return {};
  }
};

/**
 * @param {LaunchRequest} request
 * @returns {CodophonLaunchOptions}
 */
const toLaunchOptions = (request) => {
  const provider =
    request.source?.type === 'pull-request' ? parseReviewUrl(request.source.url)?.provider : null;
  const source = provider ? { ...request.source, provider } : request.source;
  const agentBackend = ['claude', 'codex', 'opencode'].includes(request.agentBackend ?? '')
    ? request.agentBackend
    : undefined;
  return {
    ...(agentBackend ? { agentBackend } : {}),
    ...(request.claudeSessionId ? { claudeSessionId: request.claudeSessionId } : {}),
    ...(request.codexSessionId ? { codexSessionId: request.codexSessionId } : {}),
    ...(request.opencodeSessionId ? { opencodeSessionId: request.opencodeSessionId } : {}),
    repositoryPathProvided: Boolean(request.repositoryPath),
    ...(source ? { source } : {}),
    walkthrough: request.walkthrough === true,
    ...(request.walkthroughContextPath
      ? {
          walkthroughContext: readWalkthroughContext(
            request.walkthroughContextPath,
            request.codexSessionId,
          ),
        }
      : {}),
    ...(request.walkthroughFile ? { walkthroughFile: resolve(request.walkthroughFile) } : {}),
    ...(request.walkthroughResultFile
      ? { walkthroughResultFile: resolve(request.walkthroughResultFile) }
      : {}),
  };
};

/**
 * Where the app should open for `argv`: the repository the CLI named, or `cwd`.
 *
 * @param {ReadonlyArray<string>} argv
 * @param {string} [cwd]
 */
const readLaunch = (argv, cwd = process.cwd()) => {
  const request = decodeLaunchRequest(argv);
  return {
    launchOptions: toLaunchOptions(request),
    repositoryPath: resolve(request.repositoryPath || cwd),
  };
};

/**
 * A bare launch from the Dock or Start menu reopens the last repository instead of the app's
 * working directory. The CLI always names a repository, so it never takes this path.
 *
 * @param {string} launchPath
 * @param {CodophonLaunchOptions} launchOptions
 * @param {string} lastRepositoryPath
 */
const getInitialRepositoryPath = (launchPath, launchOptions, lastRepositoryPath) =>
  lastRepositoryPath &&
  existsSync(lastRepositoryPath) &&
  !launchOptions.repositoryPathProvided &&
  !launchOptions.source &&
  !launchOptions.walkthrough
    ? resolve(lastRepositoryPath)
    : launchPath;

module.exports = {
  decodeLaunchRequest,
  encodeLaunchRequest,
  getInitialRepositoryPath,
  readLaunch,
};
