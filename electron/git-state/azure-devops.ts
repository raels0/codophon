import type {
  PullRequestExistingReviewComment,
  PullRequestReviewComment,
  ReviewSource,
  SubmitPullRequestCommentRequest,
  SubmitPullRequestReviewRequest,
} from '../../core/types.ts';
import { parseRemoteUrl, parseReviewUrl, readReviewRemotes } from '../review-source.ts';
import type {
  AzureComment,
  AzureIdentity,
  AzurePullRequest,
  AzureThread,
} from './azure-devops-api.ts';
import { createAzureDevOpsClient } from './azure-devops-api.ts';
import { listRepositoryHistory } from './commit.ts';
import { readRepositoryRoot, git, gitOrEmpty } from './common.ts';
import {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonSnapshot,
  readComparisonState,
} from './comparison.ts';

export type PullRequestSource = Extract<ReviewSource, { type: 'pull-request' }>;

const parseAzureDevOpsPullRequestUrl = (value: string) => {
  const parsed = parseReviewUrl(value);
  if (!parsed || parsed.provider !== 'azure-devops') {
    throw new Error('Codophon expected an Azure DevOps Services pull request URL.');
  }
  return parsed;
};

const selectRemote = (repoRoot: string, pr: ReturnType<typeof parseAzureDevOpsPullRequestUrl>) => {
  const remote = readReviewRemotes(repoRoot).find(
    (candidate) =>
      candidate.direction === 'fetch' &&
      candidate.provider === 'azure-devops' &&
      candidate.projectPath.toLowerCase() === pr.projectPath.toLowerCase(),
  );
  if (!remote) {
    throw new Error(
      `PR ${pr.projectPath}#${pr.number} does not match an Azure DevOps remote in this repository. Open its repository first.`,
    );
  }
  return remote;
};

const commitRefs = (metadata: AzurePullRequest) => {
  const head = metadata.lastMergeSourceCommit?.commitId;
  const target = metadata.lastMergeTargetCommit?.commitId;
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
  if (
    typeof head !== 'string' ||
    !sha.test(head) ||
    typeof target !== 'string' ||
    !sha.test(target)
  ) {
    throw new Error(
      'Azure DevOps has not supplied valid PR source and target commits. Refresh after its merge evaluation completes.',
    );
  }
  return { head, target };
};

/**
 * Fetch objects only: do not switch branches, update tracking refs, or overwrite FETCH_HEAD.
 * Azure exposes a synthetic merge ref, not GitHub's refs/pull/<id>/head.
 */
const resolveAzureDevOpsContentRefs = async (
  repoRoot: string,
  pr: ReturnType<typeof parseAzureDevOpsPullRequestUrl>,
  metadata: AzurePullRequest,
) => {
  const remote = selectRemote(repoRoot, pr);
  const { head, target } = commitRefs(metadata);
  const fork = metadata.forkSource?.repository?.remoteUrl;
  if (fork && parseRemoteUrl(fork)?.provider !== 'azure-devops') {
    throw new Error('Azure DevOps returned an unsupported source repository URL.');
  }
  for (const [sha, source] of [
    [head, fork || remote.name],
    [target, remote.name],
  ]) {
    if (
      !(await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim()
    ) {
      await git(repoRoot, ['fetch', '--no-tags', '--no-write-fetch-head', '--', source, sha]);
    }
  }
  return { base: (await git(repoRoot, ['merge-base', target, head])).trim(), head };
};

const normalizeAuthor = (author: AzureIdentity | undefined) => ({
  avatarUrl: author?.imageUrl,
  login: author?.uniqueName || author?.displayName || 'Azure DevOps user',
  url: author?._links?.web?.href || author?.url,
});

const createSource = (
  pr: ReturnType<typeof parseAzureDevOpsPullRequestUrl>,
  metadata: AzurePullRequest,
  baseSha: string,
): PullRequestSource => ({
  author: normalizeAuthor(metadata.createdBy),
  baseSha,
  description: metadata.description?.trim(),
  draft: metadata.isDraft,
  headSha: metadata.lastMergeSourceCommit?.commitId,
  host: pr.host,
  number: pr.number,
  owner: pr.organization,
  projectPath: pr.projectPath,
  provider: 'azure-devops',
  repo: pr.repo,
  reviewers: metadata.reviewers?.map((reviewer) => {
    if (!reviewer.id) {
      throw new Error('Azure DevOps returned a reviewer without an identity.');
    }
    return { ...normalizeAuthor(reviewer), approved: (reviewer.vote || 0) > 0, id: reviewer.id };
  }),
  reviewStatus: {},
  title: metadata.title,
  type: 'pull-request',
  url: pr.url,
});

const openReview = async (launchPath: string, source: PullRequestSource) => {
  const root = await readRepositoryRoot(launchPath);
  const pr = parseAzureDevOpsPullRequestUrl(source.url);
  selectRemote(root, pr);
  return { root, pr, client: createAzureDevOpsClient(root, pr) };
};

const assertCurrentHead = (source: PullRequestSource | undefined, metadata: AzurePullRequest) => {
  if (source?.headSha && metadata.lastMergeSourceCommit?.commitId !== source.headSha) {
    throw new Error('This pull request changed. Refresh it before continuing the review.');
  }
};

const readSnapshotRefs = async (
  review: Awaited<ReturnType<typeof openReview>>,
  source?: PullRequestSource,
) => {
  const metadata = await review.client.metadata();
  assertCurrentHead(source, metadata);
  const { base, head } = await resolveAzureDevOpsContentRefs(review.root, review.pr, metadata);
  if (source?.baseSha && source.baseSha !== base) {
    throw new Error(
      'The pull request comparison base changed. Refresh it before continuing the review.',
    );
  }
  return { base, head, metadata };
};

const readSnapshot = async (
  review: Awaited<ReturnType<typeof openReview>>,
  source?: PullRequestSource,
) => {
  const { base, head, metadata } = await readSnapshotRefs(review, source);
  return readComparisonSnapshot(review.root, head, base, createSource(review.pr, metadata, base));
};

const getAzureDevOpsCommentBody = (comment: AzureComment) =>
  comment.isDeleted || /^(system|3)$/i.test(String(comment.commentType))
    ? undefined
    : comment.content;

const isClosedReviewThread = (thread: AzureThread) =>
  /^(fixed|wontfix|closed|bydesign|[2345])$/i.test(String(thread.status));

const normalizeAzureDevOpsReviewComment = (
  comment: AzureComment,
  thread: AzureThread,
  url: string,
): PullRequestExistingReviewComment | null => {
  const body = getAzureDevOpsCommentBody(comment);
  if (!body) {
    return null;
  }
  const context = thread.threadContext;
  if (!context?.filePath) {
    return null;
  }
  const path = context.filePath.replace(/^\/+/, '');
  if (!path) {
    return null;
  }
  const right = context.rightFileEnd || context.rightFileStart;
  const end = right || context.leftFileEnd || context.leftFileStart;
  const start = right ? context.rightFileStart : context.leftFileStart;
  const side = right ? ('additions' as const) : ('deletions' as const);
  return {
    author: normalizeAuthor(comment.author),
    body,
    filePath: path,
    id: `azure-devops:${thread.id}:${comment.id}`,
    ...(end ? { lineNumber: end.line, side } : { anchor: 'file' as const }),
    ...(start && end && start.line !== end.line ? { startLineNumber: start.line } : {}),
    submittedAt: comment.publishedDate || comment.lastContentUpdatedDate,
    threadId: String(thread.id),
    url: `${url}?discussionId=${thread.id}`,
  };
};

const readAzureDevOpsPullRequestState = async (launchPath: string, source: PullRequestSource) => {
  const review = await openReview(launchPath, source);
  const [snapshot, threads] = await Promise.all([readSnapshot(review), review.client.threads()]);
  return {
    ...(await readComparisonState(launchPath, snapshot)),
    reviewComments: threads
      .filter((thread) => !thread.isDeleted && !isClosedReviewThread(thread))
      .flatMap((thread) =>
        (thread.comments || []).map((comment) =>
          normalizeAzureDevOpsReviewComment(comment, thread, review.pr.url),
        ),
      )
      .filter((comment) => comment !== null),
  };
};

const readAzureDevOpsReviewBriefComments = async (
  launchPath: string,
  source: PullRequestSource,
) => {
  const { client, pr } = await openReview(launchPath, source);
  const [userId, threads] = await Promise.all([client.authenticatedUserId(), client.threads()]);

  const comments: Array<import('../../core/types.ts').ReviewBriefPostedComment> = [];
  for (const thread of threads) {
    if (thread.isDeleted) {
      continue;
    }
    const resolved = isClosedReviewThread(thread);
    for (const comment of thread.comments ?? []) {
      const body = getAzureDevOpsCommentBody(comment);
      if (comment.author?.id !== userId || !body?.trim()) {
        continue;
      }
      const inline = normalizeAzureDevOpsReviewComment(comment, thread, pr.url);
      comments.push({
        body,
        ...(inline
          ? {
              filePath: inline.filePath,
              lineNumber: inline.lineNumber,
              side: inline.side,
              startLineNumber: inline.startLineNumber,
            }
          : {}),
        resolved,
        url: `${pr.url}?discussionId=${thread.id}`,
      });
    }
  }
  return comments;
};

const readAzureDevOpsSectionContent = async (
  launchPath: string,
  request: import('../../core/types.ts').DiffSectionContentRequest,
) => {
  if (request.source?.type !== 'pull-request') {
    throw new Error('An Azure DevOps pull request source is required.');
  }
  const review = await openReview(launchPath, request.source);
  return readComparisonSectionContent(await readSnapshot(review, request.source), request.path, {
    force: request.force,
  });
};

const readAzureDevOpsImageContent = async (
  launchPath: string,
  source: PullRequestSource,
  path: string,
) => {
  const review = await openReview(launchPath, source);
  return readComparisonImageContent(await readSnapshot(review, source), path);
};

const listAzureDevOpsHistory = async (
  launchPath: string,
  source: PullRequestSource,
  limit: number = 200,
) => {
  const review = await openReview(launchPath, source);
  const { base, head } = await readSnapshotRefs(review, source);
  const [history, changes] = await Promise.all([
    listRepositoryHistory(review.root, limit, base),
    listRepositoryHistory(review.root, limit, `${base}..${head}`),
  ]);
  return {
    root: review.root,
    entries: [
      ...changes.entries.map((entry) => ({
        ...entry,
        scope: 'pull-request' as const,
      })),
      ...history.entries.map((entry) => ({ ...entry, scope: 'base' as const })),
    ],
  };
};

const createAzureDevOpsThreadContext = (comment: PullRequestReviewComment) => {
  const filePath = `/${comment.filePath.replace(/^\/+/, '')}`;
  if (comment.anchor === 'file' || comment.lineNumber == null || comment.side == null) {
    return { filePath };
  }
  const end = { line: comment.lineNumber, offset: 1 };
  const start = { line: comment.startLineNumber ?? comment.lineNumber, offset: 1 };
  return comment.side === 'deletions'
    ? { filePath, leftFileStart: start, leftFileEnd: end }
    : { filePath, rightFileStart: start, rightFileEnd: end };
};

const assertReviewSnapshot = async (
  review: Awaited<ReturnType<typeof openReview>>,
  source: PullRequestSource,
) => {
  if (source.headSha) {
    await readSnapshotRefs(review, source);
  }
};

const submitAzureDevOpsComment = async (
  launchPath: string,
  request: SubmitPullRequestCommentRequest,
) => {
  const review = await openReview(launchPath, request.source);
  const { comment } = request;
  let submitted;
  let threadId;
  if (comment.threadId) {
    submitted = await review.client.reply(comment.threadId, comment.body);
    threadId = comment.threadId;
  } else {
    await assertReviewSnapshot(review, request.source);
    const thread = await review.client.createThread({
      comments: [{ commentType: 1, content: comment.body, parentCommentId: 0 }],
      status: 1,
      threadContext: createAzureDevOpsThreadContext(comment),
    });
    submitted = thread.comments?.[0];
    if (!Number.isInteger(thread.id)) {
      throw new Error(
        'Azure DevOps accepted the comment but did not return its thread. Refresh before retrying.',
      );
    }
    threadId = String(thread.id);
  }
  if (!submitted?.content || submitted.id == null || !threadId) {
    throw new Error(
      'Azure DevOps accepted the comment but did not return its metadata. Refresh before retrying.',
    );
  }
  return {
    ...comment,
    body: submitted.content,
    author: normalizeAuthor(submitted.author),
    id: `azure-devops:${threadId}:${submitted.id}`,
    submittedAt: submitted.publishedDate || submitted.lastContentUpdatedDate,
    threadId,
    url: `${review.pr.url}?discussionId=${threadId}`,
  };
};

const submitAzureDevOpsReview = async (
  launchPath: string,
  request: SubmitPullRequestReviewRequest,
) => {
  const votes = { APPROVE: 10, COMMENT: 0, REQUEST_CHANGES: -10 };
  if (!(request.event in votes)) {
    throw new Error(`Azure DevOps reviews do not support ${request.event}.`);
  }
  const review = await openReview(launchPath, request.source);
  await assertReviewSnapshot(review, request.source);
  for (const comment of request.comments) {
    await review.client.createThread({
      comments: [{ commentType: 1, content: comment.body, parentCommentId: 0 }],
      status: 1,
      threadContext: createAzureDevOpsThreadContext(comment),
    });
  }
  if (request.body?.trim()) {
    await review.client.createThread({
      comments: [{ commentType: 1, content: request.body.trim(), parentCommentId: 0 }],
      status: 1,
    });
  }
  if (votes[request.event] !== 0) {
    await review.client.vote(votes[request.event]);
  }
};

export {
  createAzureDevOpsThreadContext,
  listAzureDevOpsHistory,
  normalizeAzureDevOpsReviewComment,
  parseAzureDevOpsPullRequestUrl,
  readAzureDevOpsImageContent,
  readAzureDevOpsPullRequestState,
  readAzureDevOpsReviewBriefComments,
  readAzureDevOpsSectionContent,
  resolveAzureDevOpsContentRefs,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
};
