import type {
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSectionContentRequest,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
  SubmitPullRequestCommentRequest,
  SubmitPullRequestReviewRequest,
} from '../core/types.ts';
import { annotateGeneratedFiles } from './generated-files.ts';
import {
  listAzureDevOpsHistory,
  readAzureDevOpsImageContent,
  readAzureDevOpsPullRequestState,
  readAzureDevOpsSectionContent,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
} from './git-state/azure-devops.ts';
import {
  listRepositoryHistory,
  readBranchWorkingTreeState,
  readComparisonSourceImageContent,
  readComparisonSourceSectionContent,
  readComparisonSourceState,
  readResolvedCommitState,
} from './git-state/commit.ts';
import { readRepositoryRoot, git, gitOrEmpty, validateRepositoryPath } from './git-state/common.ts';
import {
  listPullRequestHistory,
  readPullRequestImageContent,
  readPullRequestState,
  setPullRequestFileViewed,
  submitPullRequestComment,
  submitPullRequestReview,
} from './git-state/pull-request.ts';
import {
  readDiffSectionContent as readWorkingTreeDiffSectionContent,
  readDiffImageContent as readWorkingTreeDiffImageContent,
  readGitIdentity,
  readWorkingTreeState,
} from './git-state/working-tree.ts';
import { parseRepositoryWatcherStatus } from './repository-watcher.ts';
import { parseReviewUrl } from './review-source.ts';

const readRepositoryState = async (
  launchPath: string,
  source: ReviewSource = { type: 'working-tree' },
  options: { showWhitespace?: boolean } = {},
): Promise<RepositoryState> => {
  const comparisonState =
    source.type === 'commit' ||
    source.type === 'range' ||
    source.type === 'branch' ||
    source.type === 'branch-diff';
  const state =
    source.type === 'pull-request'
      ? await getPullRequestProvider(source).readState(launchPath, source)
      : comparisonState
        ? await readComparisonSourceState(launchPath, source)
        : source.type === 'branch-working-tree'
          ? await readBranchWorkingTreeState(launchPath, source, {
              showWhitespace: options.showWhitespace,
            })
          : await readWorkingTreeState(launchPath, {
              eagerContents: false,
              showWhitespace: options.showWhitespace,
            });
  const [branch, annotatedState] = await Promise.all([
    gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD']),
    comparisonState ? state : annotateGeneratedFiles(state),
  ]);
  return { ...annotatedState, branch: branch.trim() || null };
};

/**
 * An implicit walkthrough reviews local changes when present and otherwise
 * reviews the current commit. Explicit sources always retain their semantics.
 */
const readWalkthroughRepositoryState = async (
  launchPath: string,
  source?: ReviewSource,
  options: { showWhitespace?: boolean } = {},
): Promise<RepositoryState> => {
  if (source) {
    return readRepositoryState(launchPath, source, options);
  }

  const repoRoot = await readRepositoryRoot(launchPath);
  const status = parseRepositoryWatcherStatus(
    await git(repoRoot, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      '-z',
      '-uall',
    ]),
  );
  if (status.paths.length > 0) {
    return readRepositoryState(launchPath, undefined, options);
  }

  const [head, branchHead] = status.head.split('\0');
  const branch = branchHead && branchHead !== '(detached)' ? branchHead : null;
  if (/^[0-9a-f]+$/i.test(head)) {
    const state = await readResolvedCommitState(launchPath, repoRoot, head);
    return { ...state, branch };
  }

  return {
    branch,
    files: [],
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

const pullRequestProviders = {
  github: {
    readState: readPullRequestState,
    readHistory: listPullRequestHistory,
    readImage: readPullRequestImageContent,
    submitComment: submitPullRequestComment,
    submitReview: submitPullRequestReview,
  },
  'azure-devops': {
    readState: readAzureDevOpsPullRequestState,
    readHistory: listAzureDevOpsHistory,
    readImage: readAzureDevOpsImageContent,
    submitComment: submitAzureDevOpsComment,
    submitReview: submitAzureDevOpsReview,
  },
};

const getPullRequestProvider = (source: Extract<ReviewSource, { type: 'pull-request' }>) =>
  pullRequestProviders[parseReviewUrl(source.url)?.provider || source.provider || 'github'];

const getBranchHistoryRef = (
  source: Extract<ReviewSource, { type: 'branch' | 'branch-diff' | 'branch-working-tree' }>,
) =>
  source.type !== 'branch' && source.baseRef && source.headRef
    ? `${source.baseRef}..${source.headRef}`
    : `${source.ref}..HEAD`;

const readRepositoryHistory = (
  launchPath: string,
  limit?: number,
  source?: ReviewSource,
): Promise<RepositoryHistory> =>
  source?.type === 'pull-request'
    ? getPullRequestProvider(source).readHistory(launchPath, source, limit)
    : listRepositoryHistory(
        launchPath,
        limit,
        source?.type === 'branch' ||
          source?.type === 'branch-diff' ||
          source?.type === 'branch-working-tree'
          ? getBranchHistoryRef(source)
          : undefined,
      );

/**
 * The comparison whose Git trees hold a lazily loaded section or image, or
 * null when it comes from the working tree. A branch-working-tree source mixes
 * both: its staged and unstaged sections are working-tree reads.
 */
const getContentComparisonSource = ({
  kind,
  source,
}: DiffSectionContentRequest | DiffImageContentRequest) =>
  source?.type === 'range' || source?.type === 'branch' || source?.type === 'branch-diff'
    ? source
    : source?.type === 'branch-working-tree'
      ? kind === 'staged' || kind === 'unstaged'
        ? null
        : source
      : kind === 'commit' || source?.type === 'commit'
        ? ({
            ref: source?.type === 'commit' ? source.ref : 'HEAD',
            type: 'commit',
          } as const)
        : null;

const readDiffSectionContent = async (launchPath: string, request: DiffSectionContentRequest) => {
  if (
    request.source?.type === 'pull-request' &&
    parseReviewUrl(request.source.url)?.provider === 'azure-devops'
  ) {
    return readAzureDevOpsSectionContent(launchPath, request);
  }

  const source = getContentComparisonSource(request);
  return source
    ? readComparisonSourceSectionContent(launchPath, source, request.path, {
        force: request.force,
      })
    : readWorkingTreeDiffSectionContent(launchPath, request);
};

const readDiffImageContent = (
  launchPath: string,
  request: DiffImageContentRequest,
): Promise<DiffImageContentResult> => {
  if (request.source?.type === 'pull-request') {
    return getPullRequestProvider(request.source).readImage(
      launchPath,
      request.source,
      request.path,
    );
  }

  const source = getContentComparisonSource(request);
  return source
    ? readComparisonSourceImageContent(launchPath, source, request.path)
    : readWorkingTreeDiffImageContent(launchPath, request);
};

const submitReviewComment = (launchPath: string, request: SubmitPullRequestCommentRequest) =>
  getPullRequestProvider(request.source).submitComment(launchPath, request);

const submitReview = (launchPath: string, request: SubmitPullRequestReviewRequest) =>
  getPullRequestProvider(request.source).submitReview(launchPath, request);

export {
  readRepositoryHistory as listRepositoryHistory,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryState,
  readWalkthroughRepositoryState,
  setPullRequestFileViewed,
  submitReviewComment as submitPullRequestComment,
  submitReview as submitPullRequestReview,
  validateRepositoryPath,
};
