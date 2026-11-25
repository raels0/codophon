import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CodophonLaunchOptions, ReviewSource } from '../core/types.ts';
import { parseReviewUrl } from './review-source.ts';

export type WindowIdentity = { key: string; repositoryRoot: string; sourceKey: string };

export type ParsedPullRequest = { number: number; owner: string; repo: string };

const getRealPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const resolveRepositoryRoot = (repositoryPath: string) => {
  const resolvedPath = resolve(repositoryPath);

  try {
    return getRealPath(
      execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return getRealPath(resolvedPath);
  }
};

const resolveCommitRef = (repositoryRoot: string, ref: string) => {
  try {
    return execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--verify', `${ref}^{commit}`], {
      encoding: 'utf8',
    })
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
};

const hasWorkingTreeChanges = (repositoryRoot: string) => {
  try {
    return Boolean(
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        { encoding: 'utf8' },
      ),
    );
  } catch {
    return false;
  }
};

const resolveMergeBase = (repositoryRoot: string, baseRef: string, headRef: string) => {
  try {
    return execFileSync('git', ['-C', repositoryRoot, 'merge-base', baseRef, headRef], {
      encoding: 'utf8',
    })
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
};

const getPullRequestSourceKey = (source: Extract<ReviewSource, { type: 'pull-request' }>) => {
  const review = parseReviewUrl(source.url);
  if (review?.provider === 'azure-devops') {
    return `pull-request:${review.provider}:${review.host}/${review.projectPath.toLowerCase()}#${
      review.number
    }`;
  }
  const pullRequest =
    source.owner && source.repo && source.number
      ? {
          number: source.number,
          owner: source.owner,
          repo: source.repo,
        }
      : review?.provider === 'github'
        ? ({
            number: review.number,
            owner: review.owner,
            repo: review.repo,
          } as ParsedPullRequest)
        : null;

  return pullRequest
    ? `pull-request:${pullRequest.owner.toLowerCase()}/${pullRequest.repo.toLowerCase()}#${
        pullRequest.number
      }`
    : null;
};

const getSourceKey = (repositoryRoot: string, source: ReviewSource = { type: 'working-tree' }) => {
  if (source.type === 'working-tree') {
    return 'working-tree';
  }

  if (source.type === 'commit') {
    const commit = resolveCommitRef(repositoryRoot, source.ref);
    return commit ? `commit:${commit}` : null;
  }

  if (source.type === 'branch') {
    const head = resolveCommitRef(repositoryRoot, 'HEAD');
    const target = resolveCommitRef(repositoryRoot, source.ref);
    const nextBase = target && head ? resolveMergeBase(repositoryRoot, target, head) : null;
    return nextBase && head ? `branch-diff:${source.ref}:${nextBase}:${head}` : null;
  }

  if (source.type === 'branch-diff') {
    const base = resolveCommitRef(repositoryRoot, source.baseRef);
    const head = resolveCommitRef(repositoryRoot, source.headRef);
    return base && head ? `branch-diff:${source.ref}:${base}:${head}` : null;
  }

  if (source.type === 'branch-working-tree') {
    if (
      typeof source.baseRef === 'string' &&
      typeof source.headRef === 'string' &&
      source.baseRef &&
      source.headRef
    ) {
      const base = resolveCommitRef(repositoryRoot, source.baseRef);
      const head = resolveCommitRef(repositoryRoot, source.headRef);
      return base && head ? `branch-working-tree:${source.ref}:${base}:${head}` : null;
    }

    const head = resolveCommitRef(repositoryRoot, 'HEAD');
    const target = resolveCommitRef(repositoryRoot, source.ref);
    const nextBase = target && head ? resolveMergeBase(repositoryRoot, target, head) : null;
    return nextBase && head ? `branch-working-tree:${source.ref}:${nextBase}:${head}` : null;
  }

  if (source.type === 'pull-request') {
    return getPullRequestSourceKey(source);
  }

  return null;
};

const getResolvedSourceKey = (source: ReviewSource) => {
  if (source.type === 'working-tree') {
    return 'working-tree';
  }
  if (source.type === 'commit') {
    return `commit:${source.ref.toLowerCase()}`;
  }
  if (source.type === 'branch-diff') {
    return `branch-diff:${source.ref}:${source.baseRef.toLowerCase()}:${source.headRef.toLowerCase()}`;
  }
  if (source.type === 'branch-working-tree' && source.baseRef && source.headRef) {
    return `branch-working-tree:${source.ref}:${source.baseRef.toLowerCase()}:${source.headRef.toLowerCase()}`;
  }
  if (source.type === 'pull-request') {
    return getPullRequestSourceKey(source);
  }
  return null;
};

const getWindowIdentity = (
  repositoryPath: string,
  launchOptions: Partial<CodophonLaunchOptions> = {},
) => {
  const repositoryRoot = resolveRepositoryRoot(repositoryPath);
  const implicitWalkthroughHead =
    launchOptions.walkthrough &&
    !launchOptions.walkthroughFile &&
    !launchOptions.source &&
    !hasWorkingTreeChanges(repositoryRoot)
      ? resolveCommitRef(repositoryRoot, 'HEAD')
      : null;
  const sourceKey = implicitWalkthroughHead
    ? `commit:${implicitWalkthroughHead}`
    : getSourceKey(repositoryRoot, launchOptions.source);
  return sourceKey
    ? {
        key: `${repositoryRoot}\0${sourceKey}`,
        repositoryRoot,
        sourceKey,
      }
    : null;
};

const getWindowIdentityForSource = (repositoryPath: string, source: ReviewSource) =>
  getWindowIdentity(repositoryPath, { source });

const getWindowIdentityForRepositoryState = (state: { root: string; source: ReviewSource }) => {
  const repositoryRoot = getRealPath(state.root);
  const sourceKey = getResolvedSourceKey(state.source);
  return sourceKey
    ? {
        key: `${repositoryRoot}\0${sourceKey}`,
        repositoryRoot,
        sourceKey,
      }
    : null;
};

const findMatchingWindowIdentity = (
  identity: WindowIdentity | null,
  existingIdentities: ReadonlyMap<number, WindowIdentity | null>,
) => {
  if (!identity) {
    return null;
  }

  for (const [id, existingIdentity] of existingIdentities) {
    if (existingIdentity?.key === identity.key) {
      return id;
    }
  }

  return null;
};

export {
  findMatchingWindowIdentity,
  getWindowIdentity,
  getWindowIdentityForRepositoryState,
  getWindowIdentityForSource,
};
