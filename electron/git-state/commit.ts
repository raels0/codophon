import type { RepositoryState, ReviewSource } from '../../core/types.ts';
import { applyGeneratedAttributeStates, readGeneratedAttributeStates } from '../generated-files.ts';
import { readCommitMetadataForCommit } from './commit-metadata.ts';
import {
  readRepositoryRoot,
  fileSort,
  createWorkingTreeChangedFile,
  getGravatarHash,
  git,
} from './common.ts';
import {
  parseCommitNameStatus,
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonSnapshot,
  readComparisonState,
} from './comparison.ts';
import { readWorkingTreeState } from './working-tree.ts';

export type BranchSource = Extract<ReviewSource, { type: 'branch' }>;

export type BranchDiffSource = Extract<ReviewSource, { type: 'branch-diff' }>;

export type BranchWorkingTreeSource = Extract<ReviewSource, { type: 'branch-working-tree' }>;

export type CommitSource = Extract<ReviewSource, { type: 'commit' }>;

export type RangeSource = Extract<ReviewSource, { type: 'range' }>;

export type ComparisonSource = BranchSource | BranchDiffSource | CommitSource | RangeSource;

const readCommitParents = async (repoRoot: string, commit: string): Promise<Array<string>> => {
  const raw = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit])).trim();
  return raw ? raw.split(' ').slice(1) : [];
};

const resolveRangeEndpoint = async (repoRoot: string, ref: string) => {
  if (ref !== 'HEAD') {
    try {
      return (await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${ref}^{commit}`])).trim();
    } catch {
      // Fall back to Git's normal ref parser for tags, hashes, and fully-qualified refs.
    }
  }

  return (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
};

/**
 * Resolve a `base...head` (symmetric -> merge-base) or `base..head` range to the
 * concrete (oldRef, newRef) pair the commit helpers diff against.
 */
const resolveRangeRefs = async (
  repoRoot: string,
  base: string,
  head: string,
  symmetric: boolean,
): Promise<{ newRef: string; oldRef: string }> => {
  const newRef = await resolveRangeEndpoint(repoRoot, head);
  const oldRef = symmetric
    ? (
        await git(repoRoot, ['merge-base', await resolveRangeEndpoint(repoRoot, base), newRef])
      ).trim()
    : await resolveRangeEndpoint(repoRoot, base);
  return { newRef, oldRef };
};

const getEditDistance = (left: string, right: string) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? previous[rightIndex]
          : Math.min(previous[rightIndex], previous[rightIndex + 1], current[rightIndex]) + 1;
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
};

const getBranchSuggestionScore = (requested: string, candidate: string) => {
  const requestedLower = requested.toLowerCase();
  const aliases = [candidate.toLowerCase()];
  const slashIndex = candidate.indexOf('/');
  if (slashIndex !== -1) {
    aliases.push(candidate.slice(slashIndex + 1).toLowerCase());
  }

  return Math.min(
    ...aliases.map((alias) => {
      if (
        (requestedLower === 'main' && alias === 'master') ||
        (requestedLower === 'master' && alias === 'main')
      ) {
        return 1;
      }

      return alias.startsWith(requestedLower) && requestedLower.length >= 3
        ? 1
        : getEditDistance(requestedLower, alias);
    }),
  );
};

const getBranchSuggestionThreshold = (ref: string) =>
  ref.length <= 4 ? 1 : ref.length <= 8 ? 2 : Math.floor(ref.length / 3);

const getBranchSuggestion = async (repoRoot: string, ref: string): Promise<string | null> => {
  const raw = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  const candidates = [
    ...new Set(
      raw
        .split('\n')
        .map((branch) => branch.trim())
        .filter((branch) => branch && !branch.endsWith('/HEAD') && branch !== ref),
    ),
  ];
  const [best] = candidates
    .map((branch) => ({
      branch,
      score: getBranchSuggestionScore(ref, branch),
    }))
    .sort((left, right) => left.score - right.score || left.branch.localeCompare(right.branch));

  return best && best.score <= getBranchSuggestionThreshold(ref) ? best.branch : null;
};

const normalizeBranchSourceInput = (
  input: string | BranchSource | BranchDiffSource,
): BranchSource | BranchDiffSource =>
  typeof input === 'string' ? { ref: input, type: 'branch' } : input;

const resolveBranchComparison = async (
  repoRoot: string,
  source: BranchSource | BranchDiffSource,
) => {
  if (source.type === 'branch-diff') {
    return readComparisonSnapshot(repoRoot, source.headRef, source.baseRef, source);
  }

  const newRef = await resolveRangeEndpoint(repoRoot, 'HEAD');
  let branchRef;
  try {
    branchRef = await resolveRangeEndpoint(repoRoot, source.ref);
  } catch {
    const suggestion = await getBranchSuggestion(repoRoot, source.ref);
    throw new Error(
      `Branch "${source.ref}" does not exist in this repository.${
        suggestion ? ` Did you mean "${suggestion}"?` : ''
      }`,
    );
  }
  const oldRef = (await git(repoRoot, ['merge-base', branchRef, newRef])).trim();
  return readComparisonSnapshot(repoRoot, newRef, oldRef, {
    baseRef: oldRef,
    headRef: newRef,
    ref: source.ref,
    type: 'branch-diff',
  });
};

const readCommitSnapshot = async (repoRoot: string, commit: string) => {
  const [parent] = await readCommitParents(repoRoot, commit);
  return readComparisonSnapshot(repoRoot, commit, parent, { type: 'commit', ref: commit });
};

const readResolvedComparison = async (launchPath: string, source: ComparisonSource) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  if (source.type === 'commit') {
    const commit = (
      await git(repoRoot, ['rev-parse', '--verify', `${source.ref}^{commit}`])
    ).trim();
    return readCommitSnapshot(repoRoot, commit);
  }
  if (source.type === 'range') {
    const { newRef, oldRef } = await resolveRangeRefs(
      repoRoot,
      source.base,
      source.head,
      source.symmetric,
    );
    return readComparisonSnapshot(repoRoot, newRef, oldRef, source);
  }
  return resolveBranchComparison(repoRoot, source);
};

const readLocalComparisonState = async (
  launchPath: string,
  snapshot: import('./comparison.ts').ComparisonSnapshot,
) => {
  const { repoRoot, newRef, oldRef, status, source } = snapshot;
  const [state, attributes, commitMetadata] = await Promise.all([
    readComparisonState(launchPath, snapshot),
    readGeneratedAttributeStates(
      repoRoot,
      status.map((file) => file.path),
      newRef,
    ),
    source.type === 'commit'
      ? readCommitMetadataForCommit(repoRoot, newRef, oldRef, status)
      : undefined,
  ]);
  const annotated = applyGeneratedAttributeStates(state, attributes);
  return source.type === 'commit' ? { ...annotated, commitMetadata } : annotated;
};

const readComparisonSourceState = async (launchPath: string, source: ComparisonSource) =>
  readLocalComparisonState(launchPath, await readResolvedComparison(launchPath, source));

const readResolvedCommitState = async (launchPath: string, repoRoot: string, commit: string) =>
  readLocalComparisonState(launchPath, await readCommitSnapshot(repoRoot, commit));

const readBranchState = (launchPath: string, input: string | BranchSource | BranchDiffSource) =>
  readComparisonSourceState(launchPath, normalizeBranchSourceInput(input));

/**
 * By the time section or image content is requested for a `branch-working-tree`
 * source, that source is the resolved copy round-tripped from
 * `RepositoryState.source` (baseRef/headRef are only absent at CLI-argument
 * construction time, before the initial state has been read).
 */
const toContentComparisonSource = (
  source: ComparisonSource | BranchWorkingTreeSource,
): ComparisonSource => {
  if (source.type !== 'branch-working-tree') {
    return source;
  }

  if (!source.baseRef || !source.headRef) {
    throw new Error('Cannot load branch-working-tree content before the branch diff is resolved.');
  }

  return { baseRef: source.baseRef, headRef: source.headRef, ref: source.ref, type: 'branch-diff' };
};

const readContentComparison = async (
  launchPath: string,
  source: ComparisonSource | BranchWorkingTreeSource,
) => readResolvedComparison(launchPath, toContentComparisonSource(source));

const readComparisonSourceSectionContent = async (
  launchPath: string,
  source: ComparisonSource | BranchWorkingTreeSource,
  path: string,
  options?: { force?: boolean },
) => readComparisonSectionContent(await readContentComparison(launchPath, source), path, options);

const readComparisonSourceImageContent = (
  launchPath: string,
  source: ComparisonSource | BranchWorkingTreeSource,
  path: string,
) => readComparisonImageContent(readContentComparison(launchPath, source), path);

/**
 * Reduce a `branch-working-tree` input (which may or may not already carry a
 * resolved baseRef/headRef) down to the plain branch/branch-diff shape that
 * {@link readBranchState} already understands.
 */
const toBranchComparisonInput = (
  input: string | BranchSource | BranchDiffSource | BranchWorkingTreeSource,
): string | BranchSource | BranchDiffSource => {
  if (typeof input !== 'object' || input.type !== 'branch-working-tree') {
    return input;
  }

  return input.baseRef && input.headRef
    ? { baseRef: input.baseRef, headRef: input.headRef, ref: input.ref, type: 'branch-diff' }
    : { ref: input.ref, type: 'branch' };
};

/**
 * Merge a resolved branch-diff `RepositoryState` and a working-tree
 * `RepositoryState` into a combined `branch-working-tree` state: file lists
 * are unioned by path, and files present in both have their sections
 * concatenated (branch commit section(s) followed by staged/unstaged
 * section(s)).
 */
const mergeBranchAndWorkingTreeState = (
  branchState: Omit<RepositoryState, 'branch'>,
  workingTreeState: Omit<RepositoryState, 'branch'>,
): Omit<RepositoryState, 'branch'> => {
  const branchSource = branchState.source as BranchDiffSource;
  const files = new Map(branchState.files.map((file) => [file.path, file]));
  for (const file of workingTreeState.files) {
    const branchFile = files.get(file.path);
    files.set(
      file.path,
      branchFile
        ? createWorkingTreeChangedFile({ ...file, oldPath: file.oldPath || branchFile.oldPath }, [
            ...branchFile.sections,
            ...file.sections,
          ])
        : file,
    );
  }
  return {
    ...branchState,
    files: [...files.values()].sort(fileSort),
    generatedAt: Date.now(),
    source: {
      baseRef: branchSource.baseRef,
      headRef: branchSource.headRef,
      ref: branchSource.ref,
      type: 'branch-working-tree',
    },
  };
};

const readBranchWorkingTreeState = async (
  launchPath: string,
  input: string | BranchSource | BranchDiffSource | BranchWorkingTreeSource,
  options: { showWhitespace?: boolean } = {},
): Promise<Omit<RepositoryState, 'branch'>> => {
  const [branchState, workingTreeState] = await Promise.all([
    readBranchState(launchPath, toBranchComparisonInput(input)),
    readWorkingTreeState(launchPath, {
      eagerContents: false,
      showWhitespace: options.showWhitespace,
    }),
  ]);
  return mergeBranchAndWorkingTreeState(branchState, workingTreeState);
};

const listRepositoryHistory = async (
  launchPath: string,
  limit: number = 200,
  ref: string = 'HEAD',
) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  try {
    if (ref.includes('..')) {
      await git(repoRoot, ['rev-list', '--max-count=1', ref]);
    } else {
      await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
    }
  } catch {
    return {
      entries: [],
      root: repoRoot,
    };
  }

  const raw = await git(repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x1f%P%x1f%ct%x1f%s%x1f%aN%x1f%aE%x1e',
    ref,
  ]);
  const entries = [];

  for (const record of raw.split('\x1e')) {
    const [ref, parents, committedAt, subject, author, email] = record.trim().split('\x1f');
    if (!ref || !committedAt || subject == null) {
      continue;
    }

    const gravatarUrl = email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined;

    entries.push({
      author: author || '',
      committedAt: Number(committedAt) * 1000,
      gravatarUrl,
      parents: parents ? parents.split(' ') : [],
      ref,
      subject,
    });
  }

  return {
    entries,
    root: repoRoot,
  };
};

export {
  listRepositoryHistory,
  parseCommitNameStatus,
  readBranchWorkingTreeState,
  readComparisonSourceImageContent,
  readComparisonSourceSectionContent,
  readComparisonSourceState,
  readResolvedCommitState,
};
