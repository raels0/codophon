// @ts-check

const {
  readRepositoryRoot,
  git,
  gitOrEmpty,
  parseStatus,
  validateRepositoryPath,
} = require('./git-state/common.cjs');
const {
  listRepositoryHistory,
  readBranchWorkingTreeState,
  readComparisonSourceImageContent,
  readComparisonSourceSectionContent,
  readComparisonSourceState,
  readResolvedCommitState,
} = require('./git-state/commit.cjs');
const { parseRepositoryWatcherStatus } = require('./repository-watcher.cjs');
const {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listPullRequestHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestState,
  resolvePullRequestContentRefs,
  selectUnresolvedReviewComments,
  setPullRequestFileViewed,
  submitPullRequestComment,
  submitPullRequestReview,
} = require('./git-state/pull-request.cjs');
const {
  listAzureDevOpsHistory,
  parseAzureDevOpsPullRequestUrl,
  readAzureDevOpsImageContent,
  readAzureDevOpsPullRequestState,
  readAzureDevOpsSectionContent,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
} = require('./git-state/azure-devops.cjs');
const { parseReviewUrl } = require('./review-source.cjs');
const {
  readDiffSectionContent: readWorkingTreeDiffSectionContent,
  readDiffImageContent: readWorkingTreeDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
} = require('./git-state/working-tree.cjs');
const { annotateGeneratedFiles } = require('./generated-files.cjs');

/**
 * @typedef {import('../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../core/types.ts').RepositoryHistory} RepositoryHistory
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 */

/** @param {string} launchPath @param {ReviewSource} [source] @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (launchPath, source = { type: 'working-tree' }, options = {}) => {
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
 *
 * @param {string} launchPath
 * @param {ReviewSource} [source]
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readWalkthroughRepositoryState = async (launchPath, source, options = {}) => {
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

/** @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const getPullRequestProvider = (source) =>
  pullRequestProviders[parseReviewUrl(source.url)?.provider || source.provider || 'github'];

/** @param {Extract<ReviewSource, {type: 'branch' | 'branch-diff' | 'branch-working-tree'}>} source */
const getBranchHistoryRef = (source) =>
  source.type !== 'branch' && source.baseRef && source.headRef
    ? `${source.baseRef}..${source.headRef}`
    : `${source.ref}..HEAD`;

/** @param {string} launchPath @param {number} [limit] @param {ReviewSource} [source] @returns {Promise<RepositoryHistory>} */
const readRepositoryHistory = (launchPath, limit, source) =>
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
 * @param {DiffSectionContentRequest | DiffImageContentRequest} request
 */
const getContentComparisonSource = ({ kind, source }) =>
  source?.type === 'range' || source?.type === 'branch' || source?.type === 'branch-diff'
    ? source
    : source?.type === 'branch-working-tree'
      ? kind === 'staged' || kind === 'unstaged'
        ? null
        : source
      : kind === 'commit' || source?.type === 'commit'
        ? /** @type {const} */ ({
            ref: source?.type === 'commit' ? source.ref : 'HEAD',
            type: 'commit',
          })
        : null;

/** @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (launchPath, request) => {
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

/** @param {string} launchPath @param {DiffImageContentRequest} request @returns {Promise<DiffImageContentResult>} */
const readDiffImageContent = (launchPath, request) => {
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

module.exports = {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listRepositoryHistory: readRepositoryHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseStatus,
  parseAzureDevOpsPullRequestUrl,
  parseGitHubPullRequestUrl,
  selectUnresolvedReviewComments,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readPullRequestState,
  readRepositoryState,
  readWalkthroughRepositoryState,
  readWorkingTreeState,
  resolvePullRequestContentRefs,
  setPullRequestFileViewed,
  submitPullRequestComment: (launchPath, request) =>
    getPullRequestProvider(request.source).submitComment(launchPath, request),
  submitPullRequestReview: (launchPath, request) =>
    getPullRequestProvider(request.source).submitReview(launchPath, request),
  validateRepositoryPath,
};
