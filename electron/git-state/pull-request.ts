import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  GitFileStatus,
  PullRequestExistingReviewComment,
  ChangedFile,
  DiffImageContentResult,
  PullRequestReviewComment,
  RepositoryState,
  ReviewSource,
  SetPullRequestFileViewedRequest,
  SubmitPullRequestCommentRequest,
  SubmitPullRequestReviewRequest,
} from '../../core/types.ts';
import { findExecutableOnPath, isExecutableFile } from '../agent-shared.ts';
import { getCommandEnvironment } from '../login-shell-environment.ts';
import { parseReviewUrl } from '../review-source.ts';
import {
  IMAGE_FILE_LIMIT,
  bufferToImageRevision,
  createSummary,
  formatBytes,
  getFingerprint,
  getImageMimeType,
  git,
  readRepositoryRoot,
  gitOrEmpty,
  summarizeContent,
  validateRepositoryPath,
} from './common.ts';
import { readGitFiles } from './git-files.ts';

export type GitHubRepositoryReference = { owner: string; repo: string };

export type LocalGitRemote = { name: string; url: string };

export type GitHubRepositoryMetadata = {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
};

export type PullRequestReference = { number: number; owner: string; repo: string; url: string };

export type GitHubRemote = {
  direction: 'fetch' | 'push';
  name: string;
  owner: string;
  repo: string;
};

export type GitHubPullRequestFile = {
  filename: string;
  patch?: string;
  previous_filename?: string;
  status: string;
};

export type GitHubPullRequestMetadata = {
  base?: { ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string };
  body?: string | null;
  head?: { ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string };
  node_id?: string;
  title?: string;
  user?: { avatar_url?: string; html_url?: string; login?: string };
};

export type GitHubCommit = {
  author: { avatar_url?: string };
  commit?: { author?: { date?: string; email?: string; name?: string }; message?: string };
  parents?: ReadonlyArray<{ sha?: string }>;
  sha?: string;
};

export type GitHubReviewComment = { [key: string]: any };

export type GitHubReviewThread = {
  comments?: { nodes?: ReadonlyArray<{ databaseId?: number | null }> } | null;
  isResolved?: boolean;
};

const GH_NOT_FOUND_CODE = 'GH_NOT_FOUND';
const GH_NOT_FOUND_MESSAGE =
  'GitHub support requires gh. Install gh, authenticate it, and verify `gh --version` works in Terminal. Codophon searches PATH, ~/.local/bin/gh, /opt/homebrew/bin/gh, and /usr/local/bin/gh. If gh is installed somewhere else, quit Codophon, then launch it with `CODOPHON_GH_PATH=/absolute/path/to/gh codophon`.';

const createGhNotFoundError = (detail?: string) =>
  Object.assign(new Error(detail ? `${GH_NOT_FOUND_MESSAGE} ${detail}` : GH_NOT_FOUND_MESSAGE), {
    code: GH_NOT_FOUND_CODE,
  });

/**
 * A Dock or Spotlight launch gives the app a minimal PATH that omits the
 * directories Homebrew and manual installs use, and later `codophon` invocations
 * hand their arguments to that first process rather than replacing it, so `gh`
 * has to be located the same way the other CLIs Codophon shells out to are.
 */
const getGhCommand = () => {
  const ghPath = process.env.CODOPHON_GH_PATH?.trim();
  if (ghPath) {
    if (isExecutableFile(ghPath)) {
      return ghPath;
    }

    throw createGhNotFoundError(
      `CODOPHON_GH_PATH is set to ${JSON.stringify(ghPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('gh');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createGhNotFoundError();
};

const parseGitHubPullRequestUrl = (value: string): PullRequestReference => {
  const parsed = parseReviewUrl(value);
  if (!parsed) {
    throw new Error('Codophon expected a GitHub pull request URL.');
  }

  if (parsed.provider !== 'github') {
    throw new Error('Codophon only supports GitHub pull request URLs.');
  }

  return {
    number: parsed.number,
    owner: parsed.owner,
    repo: parsed.repo,
    url: parsed.url,
  };
};

const parseGitHubRemoteUrl = (value: string): GitHubRepositoryReference | null => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^(?:git|org-\d+)@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, ''),
        }
      : null;
  } catch {
    return null;
  }
};

const parseRemoteRepositoryPath = (value: string): GitHubRepositoryReference | null => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^(?:[^@\s/:]+@)?[^/\s:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (!['git:', 'http:', 'https:', 'ssh:'].includes(url.protocol)) {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, '').replace(/\/$/, ''),
        }
      : null;
  } catch {
    return null;
  }
};

const readLocalGitRemotes = async (repoRoot: string): Promise<Array<LocalGitRemote>> => {
  const names = (await gitOrEmpty(repoRoot, ['remote']))
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  const remotes = await Promise.all(
    names.map(async (name) => {
      // Read the configured URL instead of `git remote -v`, which applies
      // `insteadOf` rewrites and can hide the original github.com host.
      const url = (await gitOrEmpty(repoRoot, ['config', '--get', `remote.${name}.url`]))
        .split('\n')[0]
        .trim();
      return url ? { name, url } : null;
    }),
  );
  return remotes.filter((remote) => remote != null);
};

const getRemotePriority = (remote: LocalGitRemote) => (remote.name === 'origin' ? 0 : 1);

/**
 * Let Git resolve SSH aliases, credential helpers, and URL rewrites, then make
 * sure the candidate remote exposes this exact GitHub pull request head.
 */
const remoteHasPullRequestHead = async (
  repoRoot: string,
  remote: LocalGitRemote,
  pullRequest: PullRequestReference,
  expectedHeadSha: string,
) => {
  const headRef = `refs/pull/${pullRequest.number}/head`;
  const output = await gitOrEmpty(repoRoot, ['ls-remote', '--refs', remote.name, headRef]);
  return output.split('\n').some((line) => {
    const [sha, ref] = line.trim().split(/\s+/);
    return ref === headRef && sha?.toLowerCase() === expectedHeadSha.toLowerCase();
  });
};

const selectPullRequestRemote = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
  expectedHeadSha: string | undefined,
): Promise<GitHubRemote> => {
  const remotes = (await readLocalGitRemotes(repoRoot)).sort(
    (left, right) => getRemotePriority(left) - getRemotePriority(right),
  );
  const remote = remotes
    .map((remote) => ({ remote, repository: parseGitHubRemoteUrl(remote.url) }))
    .filter(
      ({ repository }) =>
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase(),
    )[0]?.remote;

  if (remote) {
    return {
      direction: 'fetch',
      name: remote.name,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
    };
  }

  if (expectedHeadSha) {
    const candidates = remotes.filter(({ url }) => {
      const repository = parseRemoteRepositoryPath(url);
      return (
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase()
      );
    });

    for (const candidate of candidates) {
      if (await remoteHasPullRequestHead(repoRoot, candidate, pullRequest, expectedHeadSha)) {
        return {
          direction: 'fetch',
          name: candidate.name,
          owner: pullRequest.owner,
          repo: pullRequest.repo,
        };
      }
    }
  }

  throw new Error(
    `Pull request ${pullRequest.owner}/${pullRequest.repo} does not match a GitHub remote in this repository.`,
  );
};

const createPullRequestHistoryFetchRefspecs = (
  pullRequest: PullRequestReference,
  metadata: GitHubPullRequestMetadata,
) => [
  `+refs/pull/${pullRequest.number}/head:refs/codophon/pull-requests/${pullRequest.number}/head`,
  ...(metadata.base?.ref
    ? [`+refs/heads/${metadata.base.ref}:refs/codophon/pull-requests/${pullRequest.number}/base`]
    : []),
];

const fetchPullRequestHistoryRefs = (
  repoRoot: string,
  remote: GitHubRemote,
  pullRequest: PullRequestReference,
  metadata: GitHubPullRequestMetadata,
) =>
  git(repoRoot, [
    'fetch',
    '--no-tags',
    remote.name,
    ...createPullRequestHistoryFetchRefspecs(pullRequest, metadata),
  ]);

/**
 * Runs `gh api` and reports how it exited. Callers decide which exit codes are
 * failures because a missing file is a valid answer for content lookups.
 */
const runGhApi = async (
  repoRoot: string,
  args: ReadonlyArray<string>,
  input?: unknown,
): Promise<{ code: number | null; stderr: string; stdout: Buffer }> => {
  const environment = await getCommandEnvironment();
  return new Promise((resolve, reject) => {
    const child = spawn(getGhCommand(), ['api', ...args], {
      cwd: repoRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Array<Buffer> = [];

    const stderr: Array<Buffer> = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? createGhNotFoundError() : error),
    );
    child.on('close', (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout),
      }),
    );

    child.stdin.end(input == null ? undefined : JSON.stringify(input));
  });
};

const ghApi = async (
  repoRoot: string,
  args: ReadonlyArray<string>,
  input?: unknown,
): Promise<string> => {
  const { code, stderr, stdout } = await runGhApi(repoRoot, args, input);
  if (code === 0) {
    return stdout.toString('utf8');
  }

  throw new Error(stderr.trim() || `gh api exited with code ${code}.`);
};

const ghApiBuffer = async (
  repoRoot: string,
  args: ReadonlyArray<string>,
): Promise<Buffer | undefined> => {
  const { code, stderr, stdout } = await runGhApi(repoRoot, args);
  if (code === 0) {
    return stdout;
  }

  if (code === 1 && /not found|404/i.test(stderr)) {
    return undefined;
  }

  throw new Error(stderr.trim() || `gh api exited with code ${code}.`);
};

const readPullRequestMetadata = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
): Promise<GitHubPullRequestMetadata> =>
  JSON.parse(
    await ghApi(repoRoot, [
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
    ]),
  );

const readPullRequestFiles = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
): Promise<Array<GitHubPullRequestFile>> => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files?per_page=100`,
    ]),
  );
  return pages.flat();
};

const VIEWED_FILES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      files(first: 100, after: $cursor) {
        nodes { path viewerViewedState }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

const readPullRequestViewedFiles = async (repoRoot: string, pullRequest: PullRequestReference) => {
  const paths = new Set();

  let cursor: string | undefined;

  let headSha: string | undefined;
  do {
    const response = JSON.parse(
      await ghApi(repoRoot, [
        'graphql',
        '-f',
        `query=${VIEWED_FILES_QUERY}`,
        '-f',
        `owner=${pullRequest.owner}`,
        '-f',
        `repo=${pullRequest.repo}`,
        '-F',
        `number=${pullRequest.number}`,
        ...(cursor ? ['-f', `cursor=${cursor}`] : []),
      ]),
    );
    const result = response?.data?.repository?.pullRequest;
    if (response.errors?.length || !Array.isArray(result?.files?.nodes) || !result.headRefOid) {
      throw new Error('GitHub did not return file viewed states.');
    }
    if (headSha && headSha !== result.headRefOid) {
      throw new Error('The pull request changed while loading file viewed states.');
    }
    headSha = result.headRefOid;
    for (const file of result.files.nodes) {
      if (file?.viewerViewedState === 'VIEWED' && typeof file.path === 'string') {
        paths.add(file.path);
      }
    }
    const pageInfo = result.files.pageInfo;
    if (pageInfo?.hasNextPage && (!pageInfo.endCursor || pageInfo.endCursor === cursor)) {
      throw new Error('GitHub did not return the next page of file viewed states.');
    }
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : undefined;
  } while (cursor);
  return { headSha, paths };
};

const encodeGitHubContentPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

const normalizeGitHubRepositoryReference = (
  repository: GitHubRepositoryMetadata | null | undefined,
) => {
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (owner && repo) {
    return { owner, repo };
  }

  const [fullNameOwner, fullNameRepo] = repository?.full_name?.split('/') ?? [];
  return fullNameOwner && fullNameRepo
    ? {
        owner: fullNameOwner,
        repo: fullNameRepo,
      }
    : null;
};

const getPullRequestHeadImageSource = (
  pullRequest: PullRequestReference,
  metadata: GitHubPullRequestMetadata,
) => {
  const repository = normalizeGitHubRepositoryReference(metadata.head?.repo);
  return {
    owner: repository?.owner ?? pullRequest.owner,
    ref: repository
      ? (metadata.head?.sha ?? metadata.head?.ref ?? 'HEAD')
      : `refs/pull/${pullRequest.number}/head`,
    repo: repository?.repo ?? pullRequest.repo,
  };
};

const readGitHubImageFile = async (
  repoRoot: string,
  repository: GitHubRepositoryReference,
  ref: string,
  path: string,
) => {
  if (!getImageMimeType(path)) {
    throw new Error('Unsupported image file type.');
  }

  const buffer = await ghApiBuffer(repoRoot, [
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repository.owner}/${repository.repo}/contents/${encodeGitHubContentPath(
      path,
    )}?ref=${encodeURIComponent(ref)}`,
  ]);

  if (!buffer) {
    return undefined;
  }

  if (buffer.length > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(buffer.length)}, so Codophon skipped rendering it.`);
  }

  return bufferToImageRevision(path, buffer);
};

const readPullRequestDiff = async (repoRoot: string, pullRequest: PullRequestReference) =>
  ghApi(repoRoot, [
    '-H',
    'Accept: application/vnd.github.v3.diff',
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
  ]);

const fromGitHubReviewSide = (side: unknown): 'additions' | 'deletions' =>
  side === 'LEFT' ? 'deletions' : 'additions';

const isGitHubReviewSide = (side: unknown) => side === 'LEFT' || side === 'RIGHT';

const firstNumber = (...values: unknown[]) => values.find((value) => typeof value === 'number');

const normalizeGitHubReviewComment = (
  comment: GitHubReviewComment,
): PullRequestExistingReviewComment | null => {
  const lineNumber = firstNumber(comment.line, comment.original_line);
  if (lineNumber == null || !comment.path || !comment.body) {
    return null;
  }

  const side = fromGitHubReviewSide(comment.side);
  const startLineNumber = firstNumber(comment.start_line, comment.original_start_line);
  const startSide = isGitHubReviewSide(comment.start_side)
    ? fromGitHubReviewSide(comment.start_side)
    : undefined;
  const hasRange =
    startLineNumber != null && (startLineNumber !== lineNumber || (startSide ?? side) !== side);

  return {
    author: {
      avatarUrl: comment.user?.avatar_url,
      login: comment.user?.login || 'GitHub user',
      url: comment.user?.html_url,
    },
    body: comment.body,
    filePath: comment.path,
    id: `github:${comment.id}`,
    ...(typeof comment.line !== 'number' ? { isOutdated: true } : {}),
    lineNumber,
    side,
    ...(hasRange ? { startLineNumber } : {}),
    ...(hasRange && startSide != null && startSide !== side ? { startSide } : {}),
    submittedAt: comment.created_at,
    url: comment.html_url,
  };
};

const collectResolvedReviewCommentIds = (
  threads: ReadonlyArray<GitHubReviewThread>,
): Set<number> => {
  const ids: Set<number> = new Set();
  for (const thread of threads) {
    if (!thread?.isResolved) {
      continue;
    }
    for (const comment of thread.comments?.nodes ?? []) {
      if (typeof comment?.databaseId === 'number') {
        ids.add(comment.databaseId);
      }
    }
  }
  return ids;
};

const selectUnresolvedReviewComments = (
  comments: ReadonlyArray<GitHubReviewComment>,
  resolvedCommentIds: ReadonlySet<number>,
) =>
  comments
    .filter((comment) => !resolvedCommentIds.has(comment.id))
    .map(normalizeGitHubReviewComment)
    .filter((comment) => comment != null);

const RESOLVED_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          comments(first: 100) {
            nodes {
              databaseId
            }
          }
          isResolved
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
}`;

const readResolvedReviewCommentIds = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
): Promise<Set<number>> => {
  try {
    const threads: Array<GitHubReviewThread> = [];

    let cursor: string | undefined;
    let hasNextPage = true;
    while (hasNextPage) {
      const response = JSON.parse(
        await ghApi(repoRoot, [
          'graphql',
          '-f',
          `query=${RESOLVED_REVIEW_THREADS_QUERY}`,
          '-f',
          `owner=${pullRequest.owner}`,
          '-f',
          `repo=${pullRequest.repo}`,
          '-F',
          `number=${pullRequest.number}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : []),
        ]),
      );
      const reviewThreads = response?.data?.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) {
        break;
      }
      if (Array.isArray(reviewThreads.nodes)) {
        threads.push(...reviewThreads.nodes);
      }
      cursor = reviewThreads.pageInfo?.endCursor ?? undefined;
      hasNextPage = Boolean(reviewThreads.pageInfo?.hasNextPage && cursor);
    }
    return collectResolvedReviewCommentIds(threads);
  } catch {
    return new Set();
  }
};

const readPullRequestComments = async (repoRoot: string, pullRequest: PullRequestReference) => {
  const [pages, resolvedCommentIds] = await Promise.all([
    ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments?per_page=100`,
    ]).then((output) => JSON.parse(output)),
    readResolvedReviewCommentIds(repoRoot, pullRequest),
  ]);
  return selectUnresolvedReviewComments(pages.flat(), resolvedCommentIds);
};

const readPullRequestCommits = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
): Promise<Array<GitHubCommit>> => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/commits?per_page=100`,
    ]),
  );
  return pages.flat();
};

const readRepositoryCommits = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
  sha: string,
  limit: number,
): Promise<Array<GitHubCommit>> => {
  const commits: Array<GitHubCommit> = [];
  for (let page = 1; commits.length < limit; page += 1) {
    const pageCommits = JSON.parse(
      await ghApi(repoRoot, [
        `repos/${pullRequest.owner}/${pullRequest.repo}/commits?sha=${encodeURIComponent(
          sha,
        )}&per_page=${Math.min(limit - commits.length, 100)}&page=${page}`,
      ]),
    );
    if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
      break;
    }
    commits.push(...pageCommits);
  }
  return commits;
};

const normalizeGitHubCommit = (commit: GitHubCommit, scope?: 'base' | 'pull-request') => {
  const ref = commit.sha;
  const committedAt = Date.parse(commit.commit?.author?.date || '');
  const message = commit.commit?.message || '';
  if (!ref || !message || !Number.isFinite(committedAt)) {
    return null;
  }

  return {
    author: commit.commit?.author?.name || '',
    committedAt,
    gravatarUrl: commit.author?.avatar_url,
    parents: commit.parents?.map((parent) => parent.sha).filter((sha) => sha != null) ?? [],
    ref,
    ...(scope ? { scope } : {}),
    subject: message.split('\n')[0],
  };
};

const normalizeGitHubPullRequestCommit = (commit: GitHubCommit) =>
  normalizeGitHubCommit(commit, 'pull-request');

const listPullRequestHistory = async (
  launchPath: string,
  source: Extract<ReviewSource, { type: 'pull-request' }>,
  limit: number = 200,
) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const [metadata, commits] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestCommits(repoRoot, pullRequest),
  ]);
  const remote = await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
  await fetchPullRequestHistoryRefs(repoRoot, remote, pullRequest, metadata);
  const baseCommits = metadata.base?.sha
    ? await readRepositoryCommits(repoRoot, pullRequest, metadata.base.sha, limit)
    : [];
  return {
    entries: [
      ...commits
        .map(normalizeGitHubPullRequestCommit)
        .filter((entry) => entry !== null)
        .reverse(),
      ...baseCommits
        .map((commit) => normalizeGitHubCommit(commit, 'base'))
        .filter((entry) => entry !== null),
    ],
    root: repoRoot,
  };
};

const splitPullRequestDiff = (diff: string): Map<string, string> => {
  const chunks = diff
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trimEnd())
    .filter((chunk) => chunk.startsWith('diff --git '));
  const map = new Map();

  for (const chunk of chunks) {
    const newPath = chunk.match(/^\+\+\+\s+b\/(.+)$/m)?.[1];
    const oldPath = chunk.match(/^---\s+a\/(.+)$/m)?.[1];
    const renamePath = chunk.match(/^rename to (.+)$/m)?.[1];
    const path = newPath && newPath !== '/dev/null' ? newPath : renamePath || oldPath;
    if (path) {
      map.set(path, `${chunk}\n`);
    }
  }

  return map;
};

const quotePatchPath = (path: string) => path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

const createPatchFromPullRequestFile = (file: GitHubPullRequestFile) => {
  if (!file.patch) {
    return '';
  }

  const oldPath = file.previous_filename || file.filename;
  const header = [
    `diff --git a/${quotePatchPath(oldPath)} b/${quotePatchPath(file.filename)}`,
    file.status === 'added' ? '--- /dev/null' : `--- a/${quotePatchPath(oldPath)}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${quotePatchPath(file.filename)}`,
  ];

  return `${header.join('\n')}\n${file.patch}\n`;
};

const normalizePullRequestFileStatus = (status: string): GitFileStatus =>
  status === 'added'
    ? 'added'
    : status === 'removed'
      ? 'deleted'
      : status === 'renamed'
        ? 'renamed'
        : 'modified';

const createPullRequestSource = (
  pullRequest: PullRequestReference,
  metadata: GitHubPullRequestMetadata,
): Extract<ReviewSource, { type: 'pull-request' }> => ({
  ...(metadata.user?.login
    ? {
        author: {
          avatarUrl: metadata.user.avatar_url,
          login: metadata.user.login,
          url: metadata.user.html_url,
        },
      }
    : {}),
  ...(metadata.body?.trim() ? { description: metadata.body.trim() } : {}),
  headSha: metadata.head?.sha,
  host: 'github.com',
  number: pullRequest.number,
  owner: pullRequest.owner,
  projectPath: `${pullRequest.owner}/${pullRequest.repo}`,
  provider: 'github',
  repo: pullRequest.repo,
  title: metadata.title,
  type: 'pull-request',
  url: pullRequest.url,
});

/**
 * Make sure the pull request head and base branch are available as local refs
 * and resolve the two commits to diff against. GitHub computes the pull request
 * diff against the merge base of the base branch and the head, so mirror that to
 * keep line numbers and changes aligned with the GitHub review.
 *
 * Returns `null` when the full file contents cannot be resolved, in which case
 * callers fall back to the GitHub-provided patch (which cannot expand
 * unmodified context).
 */
const resolvePullRequestContentRefs = async (
  repoRoot: string,
  pullRequest: PullRequestReference,
  metadata: GitHubPullRequestMetadata,
  selectedRemote?: GitHubRemote,
): Promise<{ base: string; head: string } | null> => {
  if (!metadata.base?.ref) {
    return null;
  }

  const headRef = `refs/codophon/pull-requests/${pullRequest.number}/head`;
  const baseRef = `refs/codophon/pull-requests/${pullRequest.number}/base`;
  const headSha = metadata.head?.sha;
  const baseSha = metadata.base?.sha;
  const localHead = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', headRef])
  ).trim();
  const localBase = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', baseRef])
  ).trim();

  // Refetch when a ref is missing or has moved -- including when the base branch
  // advanced or the pull request was retargeted (localBase !== base sha) -- so
  // the merge base is always resolved against the current base and head rather
  // than stale contents.
  if (
    localBase === '' ||
    localHead === '' ||
    (headSha != null && localHead !== headSha) ||
    (baseSha != null && localBase !== baseSha)
  ) {
    try {
      const remote =
        selectedRemote ??
        (await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha));
      await fetchPullRequestHistoryRefs(repoRoot, remote, pullRequest, metadata);
    } catch {
      return null;
    }
  }

  const mergeBase = (await gitOrEmpty(repoRoot, ['merge-base', baseRef, headRef])).trim();
  return mergeBase ? { base: mergeBase, head: headRef } : null;
};

/**
 * git/GitHub emit `Binary files a/x and b/x differ` as a diff metadata line.
 * Anchor to the start of a line so the same text appearing inside a patch's
 * added/removed/context lines (which are prefixed with `+`/`-`/space) does not
 * misclassify a text file as binary.
 */
const BINARY_DIFF_MARKER = /^Binary files .* differ/m;

/**
 * Build a diff section for a pull request file. When the full base and head
 * contents are available the section carries `oldFile`/`newFile` so Codophon
 * renders a recomputed diff with expandable unmodified context (matching commits
 * and the working tree). Otherwise it falls back to the GitHub patch.
 */
const createPullRequestSection = (
  pullRequest: PullRequestReference,
  file: GitHubPullRequestFile,
  patch: string,
  oldFile?: import('./common.ts').FileContentResult,
  newFile?: import('./common.ts').FileContentResult,
): import('../../core/types.ts').DiffSection => {
  const id = `${file.filename}:pull-request:${pullRequest.number}`;
  const patchBinary = !patch || BINARY_DIFF_MARKER.test(patch);
  // Expandable context can only be rendered when both sides' contents are present.
  const attemptedContent = oldFile != null && newFile != null;

  if (attemptedContent && !patchBinary) {
    const summary = summarizeContent(oldFile, newFile);
    const status = normalizePullRequestFileStatus(file.status);
    const oldContents = oldFile.file?.contents ?? '';
    const newContents = newFile.file?.contents ?? '';
    // A modification that reads empty on both sides means the content failed to
    // load; keep the patch instead of rendering it as an empty (no-op) diff.
    const contentMissing =
      (status === 'modified' || status === 'renamed') && oldContents === '' && newContents === '';

    if (!summary.binary && summary.loadState === 'ready' && !contentMissing) {
      return {
        binary: false,
        id,
        kind: 'pull-request',
        loadState: 'ready',
        newFile: newFile.file,
        oldFile: oldFile.file,
        patch,
      };
    }
  }

  // Pull request contents are loaded up front, so a file that falls back to its
  // patch (binary, oversized, or refs unavailable) cannot be loaded on demand.
  return {
    binary: patchBinary,
    id,
    kind: 'pull-request',
    loadState: patchBinary ? 'binary' : 'ready',
    patch,
    summary: createSummary(
      patchBinary ? 'Binary file changed.' : 'Showing the pull request patch for this file.',
      { canLoad: false },
    ),
  };
};

const readPullRequestState = async (
  launchPath: string,
  source: Extract<ReviewSource, { type: 'pull-request' }>,
): Promise<Omit<RepositoryState, 'branch'>> => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const pullRequest = parseGitHubPullRequestUrl(source.url);

  const [metadata, apiFiles, diff, reviewComments, viewedFiles] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestFiles(repoRoot, pullRequest),
    readPullRequestDiff(repoRoot, pullRequest),
    readPullRequestComments(repoRoot, pullRequest),
    // Viewing a PR must still work when GitHub's optional progress lookup fails.
    readPullRequestViewedFiles(repoRoot, pullRequest).catch(() => undefined),
  ]);
  const remote = await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
  const diffByPath = splitPullRequestDiff(diff);
  // Load every file's base and head contents up front from the local refs, so
  // each diff renders in its final collapsed layout immediately and never shifts
  // as expandable context becomes available. Files larger than the eager limit
  // stay patch-only.
  const contentRefs = await resolvePullRequestContentRefs(
    repoRoot,
    pullRequest,
    metadata,
    remote,
  ).catch(() => null);
  const reviewFiles = [...apiFiles].map((file) => {
    const patch = diffByPath.get(file.filename) || createPatchFromPullRequestFile(file);
    return {
      file,
      oldPath: file.previous_filename || file.filename,
      patch,
    };
  });
  const contentFiles = reviewFiles.filter(({ patch }) => !BINARY_DIFF_MARKER.test(patch));
  const [oldFiles, newFiles] = contentRefs
    ? await Promise.all([
        readGitFiles(
          repoRoot,
          contentRefs.base,
          contentFiles.map(({ oldPath }) => oldPath),
          { refScopedEmptyCacheKey: true },
        ),
        readGitFiles(
          repoRoot,
          contentRefs.head,
          contentFiles.map(({ file }) => file.filename),
          { refScopedEmptyCacheKey: true },
        ),
      ])
    : [new Map(), new Map()];

  const files: Array<ChangedFile> = reviewFiles
    .map(({ file, oldPath, patch }) => {
      const oldFile = contentRefs && !BINARY_DIFF_MARKER.test(patch) ? oldFiles.get(oldPath) : null;
      const newFile =
        contentRefs && !BINARY_DIFF_MARKER.test(patch) ? newFiles.get(file.filename) : null;
      const section = createPullRequestSection(pullRequest, file, patch, oldFile, newFile);

      return {
        fingerprint: getFingerprint(
          [
            metadata.head?.sha || '',
            file.status,
            file.previous_filename || '',
            file.filename,
            section.loadState || 'ready',
            section.oldFile?.cacheKey || '',
            section.newFile?.cacheKey || '',
            patch,
          ].join('\n'),
        ),
        oldPath: file.previous_filename,
        path: file.filename,
        sections: [section],
        status: normalizePullRequestFileStatus(file.status),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewComments,
    root: repoRoot,
    source: {
      ...createPullRequestSource(pullRequest, metadata),
      ...(contentRefs ? { baseSha: contentRefs.base } : {}),
    },
    ...(viewedFiles && viewedFiles.headSha === metadata.head?.sha
      ? {
          viewedFiles: Object.fromEntries(
            files
              .filter((file) => viewedFiles.paths.has(file.path))
              .map((file) => [file.path, file.fingerprint]),
          ),
        }
      : {}),
  };
};

const readPullRequestImageContent = async (
  launchPath: string,
  source: Extract<ReviewSource, { type: 'pull-request' }>,
  requestedPath: string,
): Promise<DiffImageContentResult> => {
  try {
    const repoRoot = await readRepositoryRoot(launchPath);
    const path = validateRepositoryPath(requestedPath);
    const pullRequest = parseGitHubPullRequestUrl(source.url);

    const [metadata, files] = await Promise.all([
      readPullRequestMetadata(repoRoot, pullRequest),
      readPullRequestFiles(repoRoot, pullRequest),
    ]);
    await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
    const file = files.find((candidate) => candidate.filename === path);
    if (!file) {
      throw new Error('File is not part of this pull request.');
    }

    const headImageSource = getPullRequestHeadImageSource(pullRequest, metadata);
    const [oldImage, newImage] = await Promise.all([
      metadata.base?.sha
        ? readGitHubImageFile(
            repoRoot,
            pullRequest,
            metadata.base.sha,
            file.previous_filename || file.filename,
          )
        : undefined,
      readGitHubImageFile(repoRoot, headImageSource, headImageSource.ref, file.filename),
    ]);

    if (!oldImage && !newImage) {
      return {
        reason: 'Codophon could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codophon could not load this image.',
      status: 'unavailable',
    };
  }
};

const toGitHubReviewSide = (side: PullRequestReviewComment['side']) =>
  side === 'deletions' ? 'LEFT' : 'RIGHT';

const normalizePullRequestComment = (comment: PullRequestReviewComment) => {
  const payload: {
    body: string;
    line?: number;
    path: string;
    side: string;
    start_line?: number;
    start_side?: string;
  } = {
    body: comment.body,
    line: comment.lineNumber,
    path: comment.filePath,
    side: toGitHubReviewSide(comment.side),
  };
  const startSide = comment.startSide ?? comment.side;
  if (
    typeof comment.startLineNumber === 'number' &&
    comment.startLineNumber !== comment.lineNumber
  ) {
    payload.start_line = comment.startLineNumber;
    payload.start_side = toGitHubReviewSide(startSide);
  }
  return payload;
};

const PENDING_REVIEW_COMMENT_ERROR =
  'You already have a pending GitHub review on this pull request. Submit or discard it on GitHub, then retry. Your comment draft is still here.';

const isGitHubValidationError = (error: unknown) =>
  error instanceof Error && /(?:validation failed|http 422)/i.test(error.message);

const hasPendingPullRequestReview = async (repoRoot: string, pullRequest: PullRequestReference) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews?per_page=100`,
    ]),
  );
  return Array.isArray(pages) && pages.flat().some((review) => review?.state === 'PENDING');
};

const submitPullRequestComment = async (
  launchPath: string,
  request: SubmitPullRequestCommentRequest,
) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
  const payload = {
    ...normalizePullRequestComment(request.comment),
    commit_id: metadata.head?.sha,
  };

  const rawComment = await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
      '--input',
      '-',
    ],
    payload,
  ).catch(async (error) => {
    if (isGitHubValidationError(error)) {
      const hasPendingReview = await hasPendingPullRequestReview(repoRoot, pullRequest).catch(
        () => false,
      );
      if (hasPendingReview) {
        throw new Error(PENDING_REVIEW_COMMENT_ERROR);
      }
    }
    throw error;
  });
  const comment = normalizeGitHubReviewComment(JSON.parse(rawComment));
  if (!comment) {
    throw new Error('GitHub accepted the comment but did not return line metadata.');
  }
  return comment;
};

const submitPullRequestReview = async (
  launchPath: string,
  request: SubmitPullRequestReviewRequest,
) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);

  await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      '--input',
      '-',
    ],
    createPullRequestReviewPayload(request),
  );
};

const setPullRequestFileViewed = async (
  launchPath: string,
  request: SetPullRequestFileViewedRequest,
) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  validateRepositoryPath(request.path);
  if (typeof request.viewed !== 'boolean') {
    throw new Error('Expected a boolean file viewed state.');
  }
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
  if (!metadata.node_id) {
    throw new Error('GitHub did not return the pull request ID.');
  }
  if (request.viewed && request.source.headSha && request.source.headSha !== metadata.head?.sha) {
    throw new Error('The pull request has new changes. Refresh before marking files as Viewed.');
  }
  const mutation = request.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  const inputType = request.viewed ? 'MarkFileAsViewedInput' : 'UnmarkFileAsViewedInput';
  const response = JSON.parse(
    await ghApi(repoRoot, ['graphql', '--input', '-'], {
      query: `mutation($input: ${inputType}!) { ${mutation}(input: $input) { clientMutationId } }`,
      variables: { input: { path: request.path, pullRequestId: metadata.node_id } },
    }),
  );
  if (response.errors?.length || !response.data?.[mutation]) {
    throw new Error(response.errors?.[0]?.message || 'GitHub did not save the file viewed state.');
  }
};

const createPullRequestReviewPayload = (request: SubmitPullRequestReviewRequest) => {
  const body = request.body?.trim() || '';
  if (request.event === 'COMMENT' && request.comments.length === 0 && !body) {
    throw new Error('A comment review requires an inline comment or a review comment.');
  }

  return {
    body:
      body ||
      (request.event === 'REQUEST_CHANGES' && request.comments.length === 0
        ? 'Requesting changes.'
        : ''),
    comments: request.comments.map(normalizePullRequestComment),
    event: request.event,
  };
};

export {
  GH_NOT_FOUND_CODE,
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPatchFromPullRequestFile,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getGhCommand,
  getPullRequestHeadImageSource,
  listPullRequestHistory,
  normalizeGitHubCommit,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestState,
  readPullRequestViewedFiles,
  resolvePullRequestContentRefs,
  selectPullRequestRemote,
  selectUnresolvedReviewComments,
  setPullRequestFileViewed,
  submitPullRequestComment,
  submitPullRequestReview,
};
