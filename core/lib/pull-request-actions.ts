import type { PullRequestReviewEvent, PullRequestReviewStatus } from '../types.ts';
export const getPullRequestReviewActionStatus = (
  reviewStatus: PullRequestReviewStatus | undefined,
  event: PullRequestReviewEvent,
) =>
  event === 'APPROVE'
    ? reviewStatus?.approve
    : event === 'COMMENT'
      ? reviewStatus?.comment
      : reviewStatus?.requestChanges;

export const isPullRequestReviewActionDisabled = (
  reviewStatus: PullRequestReviewStatus | undefined,
  event: PullRequestReviewEvent,
) => getPullRequestReviewActionStatus(reviewStatus, event)?.disabled === true;
