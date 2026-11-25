import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAgentBackend } from '../../core/config/agents.ts';
/**
 * What the `codophon` CLI asks the app to open. The CLI does all argument parsing and passes this
 * to Electron as one `--launch=` argument, so the app never re-parses a command line and the
 * request survives `open --args` and single-instance handoff unchanged.
 */
import type { CodophonLaunchOptions, ReviewSource } from '../../core/types.ts';
import { parseReviewUrl } from '../review-source.ts';
import { readWalkthroughContext } from '../walkthrough-context.ts';

export type LaunchRequest = {
  agentBackend?: CodophonLaunchOptions['agentBackend'];
  claudeSessionId?: string;
  codexSessionId?: string;
  opencodeSessionId?: string;
  repositoryPath?: string;
  source?: ReviewSource;
  walkthrough?: boolean;
  walkthroughContextPath?: string;
  walkthroughFile?: string;
  walkthroughResultFile?: string;
};

const LAUNCH_ARGUMENT_PREFIX = '--launch=';

const encodeLaunchRequest = (request: LaunchRequest) =>
  `${LAUNCH_ARGUMENT_PREFIX}${Buffer.from(JSON.stringify(request)).toString('base64url')}`;

const decodeLaunchRequest = (argv: ReadonlyArray<string>): LaunchRequest => {
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

const toLaunchOptions = (request: LaunchRequest): CodophonLaunchOptions => {
  const provider =
    request.source?.type === 'pull-request' ? parseReviewUrl(request.source.url)?.provider : null;
  const source: ReviewSource | undefined =
    request.source?.type === 'pull-request' && provider
      ? { ...request.source, provider }
      : request.source;
  const agentBackend = isAgentBackend(request.agentBackend) ? request.agentBackend : undefined;
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
          walkthroughContext:
            readWalkthroughContext(request.walkthroughContextPath, request.codexSessionId) ??
            undefined,
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
 */
const readLaunch = (argv: ReadonlyArray<string>, cwd: string = process.cwd()) => {
  const request = decodeLaunchRequest(argv);
  return {
    launchOptions: toLaunchOptions(request),
    repositoryPath: resolve(request.repositoryPath || cwd),
  };
};

/**
 * A bare launch from the Dock or Start menu reopens the last repository instead of the app's
 * working directory. The CLI always names a repository, so it never takes this path.
 */
const getInitialRepositoryPath = (
  launchPath: string,
  launchOptions: CodophonLaunchOptions,
  lastRepositoryPath: string,
) =>
  lastRepositoryPath &&
  existsSync(lastRepositoryPath) &&
  !launchOptions.repositoryPathProvided &&
  !launchOptions.source &&
  !launchOptions.walkthrough
    ? resolve(lastRepositoryPath)
    : launchPath;

export { decodeLaunchRequest, encodeLaunchRequest, getInitialRepositoryPath, readLaunch };
