import { useCallback, useRef, useState } from 'react';
import type { DraftComment, ReviewComment } from '../../lib/app-types.ts';
import {
  clearAskCache,
  getAskConversationKey,
  getAskPR,
  getAskReviewKey,
  getAskReviewVersion,
  isCurrentAskComment,
  isSameAskPR,
  readAskThreads,
  restoreAskComments,
  updateAskThread,
} from '../../lib/ask-cache.ts';
import { isPullRequestReviewActionDisabled } from '../../lib/pull-request-actions.ts';
import { clearReviewBriefQuestions, recordReviewBriefQuestion } from '../../lib/review-brief.ts';
import {
  getPendingPullRequestReviewComments,
  getReviewCommentRangeProps,
  getReviewCommentsFromState,
  isLineReviewComment,
  toPullRequestReviewComment,
} from '../../lib/review-comments.ts';
import type {
  PullRequestReviewEvent,
  RepositoryState,
  ReviewAssistantRequest,
} from '../../types.ts';
import { useReviewCommentDrafts } from './useReviewCommentDrafts.ts';

type UseAppReviewCommentsOptions = {
  getRepository: () => RepositoryState | null;
  onCommentFileChange: (filePath: string) => void;
};

export type AskNotification = Pick<
  ReviewComment,
  'filePath' | 'lineNumber' | 'sectionId' | 'side'
> & {
  id: string;
  question: string;
  reviewKey: string;
  reviewVersion: string;
  status: 'ready' | 'error';
};

export function useAppReviewComments({
  getRepository,
  onCommentFileChange,
}: UseAppReviewCommentsOptions) {
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const [askCacheError, setAskCacheError] = useState<string | null>(null);
  const [askNotifications, setAskNotifications] = useState<ReadonlyArray<AskNotification>>([]);
  const lastAskPR = useRef<ReturnType<typeof getAskPR>>(null);
  const askTargetGeneration = useRef(0);
  const pendingAnswers = useRef(new Set<string>());
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const commentDrafts = useReviewCommentDrafts({
    comments: reviewComments,
    onCommentFileChange,
    setComments: setReviewComments,
  });
  const {
    activeReviewCommentDraftRef,
    activeReviewCommentDraftState,
    clearCommentFocus,
    deleteComment: deleteInlineComment,
    reviewCommentsRef,
    updateActiveReviewCommentDraft: updateInlineDraft,
  } = commentDrafts;

  const withAskStorage = useCallback((operation: () => void) => {
    try {
      operation();
    } catch (error) {
      setAskCacheError(
        `Codophon couldn't access the local Ask cache. This session may not be recoverable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, []);

  const loadReviewComments = useCallback(
    (state: RepositoryState, comments = getReviewCommentsFromState(state)) => {
      setAskNotifications((current) => (current.length ? [] : current));
      updateInlineDraft(null);
      const pr = getAskPR(state);
      if (!pr) {
        setReviewComments(comments);
        return;
      }
      const previous = lastAskPR.current;
      const changedTarget = previous != null && !isSameAskPR(previous, pr);
      if (changedTarget) {
        askTargetGeneration.current += 1;
        withAskStorage(() => clearAskCache(previous));
        if (previous.source.url !== pr.source.url) {
          withAskStorage(() => clearReviewBriefQuestions(previous.source));
        }
      }
      lastAskPR.current = pr;
      const ordinaryComments = comments.filter(
        (comment) => !comment.codexReply || comment.kind === 'posted',
      );
      let restored: ReadonlyArray<ReviewComment> = changedTarget
        ? ordinaryComments
        : comments.filter(
            (comment) =>
              !comment.codexReply ||
              comment.kind === 'posted' ||
              isCurrentAskComment(state, comment),
          );
      withAskStorage(() => {
        restored = restoreAskComments(state, ordinaryComments, readAskThreads(pr));
      });
      setReviewComments(restored);
    },
    [updateInlineDraft, withAskStorage],
  );

  const dismissAskNotification = useCallback((id: string) => {
    setAskNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);

  const updateAskPublication = useCallback(
    (state: RepositoryState | null, id: string, publication: 'draft' | 'posting' | 'archived') => {
      const pr = getAskPR(state);
      if (pr) {
        withAskStorage(() =>
          updateAskThread(pr, id, (thread) =>
            thread
              ? {
                  ...thread,
                  archived: publication === 'archived',
                  posting: publication === 'posting',
                }
              : thread,
          ),
        );
      }
    },
    [withAskStorage],
  );

  const updateActiveReviewCommentDraft = useCallback(
    (draft: Pick<ReviewComment, 'body' | 'id'> | null) => {
      updateInlineDraft(draft);
      const pr = getAskPR(getRepository());
      if (!draft || !pr) {
        return;
      }
      withAskStorage(() =>
        updateAskThread(pr, draft.id, (thread) =>
          !thread || thread.archived || thread.body === draft.body
            ? thread
            : { ...thread, body: draft.body },
        ),
      );
    },
    [getRepository, updateInlineDraft, withAskStorage],
  );

  const updateAskFollowUpDraft = useCallback(
    (id: string, body: string) => {
      const pr = getAskPR(getRepository());
      if (pr) {
        withAskStorage(() =>
          updateAskThread(pr, id, (thread) =>
            !thread || thread.archived
              ? thread
              : { ...thread, codexReply: { ...thread.codexReply, followUpDraft: body } },
          ),
        );
      }
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === id && comment.codexReply
            ? { ...comment, codexReply: { ...comment.codexReply, followUpDraft: body } }
            : comment,
        ),
      );
    },
    [getRepository, withAskStorage],
  );

  const updateCodexReply = useCallback(
    (commentId: string, filePath: string, codexReply: NonNullable<ReviewComment['codexReply']>) => {
      const pr = getAskPR(getRepository());
      const comment = reviewCommentsRef.current.find(({ id }) => id === commentId);
      if (pr && comment && comment.kind === 'draft') {
        const { remoteSubmit: _submit, ...draft } = comment;
        const activeDraft = activeReviewCommentDraftRef.current;
        withAskStorage(() =>
          updateAskThread(pr, commentId, (thread) => ({
            ...draft,
            archived: thread?.archived,
            body: activeDraft?.id === commentId ? activeDraft.body : draft.body,
            codexReply,
            posting: thread?.posting,
          })),
        );
      }
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                codexReply,
              }
            : comment,
        ),
      );
      onCommentFileChange(filePath);
    },
    [
      activeReviewCommentDraftRef,
      onCommentFileChange,
      reviewCommentsRef,
      getRepository,
      withAskStorage,
    ],
  );

  const updateRemoteSubmit = useCallback(
    (commentId: string, remoteSubmit: DraftComment['remoteSubmit']) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                remoteSubmit,
              }
            : comment,
        ),
      );
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment) {
        onCommentFileChange(comment.filePath);
      }
    },
    [onCommentFileChange, reviewCommentsRef],
  );

  const askCodex = useCallback(
    (commentId: string, followUp?: string) => {
      const currentState = getRepository();
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !currentState ||
        !comment ||
        (comment.kind === 'draft' && comment.remoteSubmit?.status === 'submitting') ||
        pendingAnswers.current.has(commentId) ||
        comment.body.trim().length === 0 ||
        comment.codexReply?.status === 'loading'
      ) {
        return;
      }

      const reviewKey = getAskReviewKey(currentState);
      const reviewVersion = getAskReviewVersion(currentState);
      const targetGeneration = askTargetGeneration.current;
      const conversationKey = getAskConversationKey(currentState, comment);
      const previousTurns = followUp === undefined ? [] : comment.codexReply?.turns || [];
      const question = followUp === undefined ? comment.body : followUp.trim();
      if (!question.trim()) {
        return;
      }
      if (
        followUp !== undefined &&
        (previousTurns.length === 0 ||
          comment.codexReply?.reviewKey !== conversationKey ||
          previousTurns[0].question !== comment.body)
      ) {
        updateCodexReply(commentId, comment.filePath, {
          ...comment.codexReply,
          error:
            'The review or original question changed. Use Ask on the original note to start a new conversation.',
          question,
          status: 'error',
        });
        return;
      }
      const pendingReply: NonNullable<ReviewComment['codexReply']> = {
        ...comment.codexReply,
        error: undefined,
        followUpDraft: followUp === undefined ? comment.codexReply?.followUpDraft : question,
        isFollowUp: followUp !== undefined,
        question,
        reviewKey: conversationKey,
        status: 'loading',
      };
      const request: ReviewAssistantRequest = {
        comment: {
          ...(comment.anchor ? { anchor: comment.anchor } : {}),
          body: question,
          filePath: comment.filePath,
          ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
          sectionId: comment.sectionId,
          ...(comment.side ? { side: comment.side } : {}),
          ...getReviewCommentRangeProps(comment),
        },
        ...(previousTurns.length ? { previousTurns } : {}),
        source: currentState.source,
      };

      const acceptReply = () => {
        const latestState = getRepository();
        const latestComment = reviewCommentsRef.current.find(
          (candidate) => candidate.id === commentId,
        );
        const latestDraft = activeReviewCommentDraftRef.current;
        if (
          !latestState ||
          !latestComment ||
          askTargetGeneration.current !== targetGeneration ||
          getAskReviewKey(latestState) !== reviewKey
        ) {
          return false;
        }
        if (
          getAskReviewVersion(latestState) !== reviewVersion ||
          (latestDraft?.id === commentId ? latestDraft.body : latestComment.body) !==
            comment.body ||
          latestComment.filePath !== comment.filePath ||
          latestComment.sectionId !== comment.sectionId ||
          latestComment.lineNumber !== comment.lineNumber ||
          latestComment.side !== comment.side ||
          latestComment.startLineNumber !== comment.startLineNumber ||
          latestComment.startSide !== comment.startSide
        ) {
          updateCodexReply(commentId, comment.filePath, {
            ...pendingReply,
            error:
              'The review or question changed while the answer was being prepared. Ask again for the current version.',
            status: 'error',
          });
          return false;
        }
        return true;
      };
      const finishReply = (
        reply: NonNullable<ReviewComment['codexReply']> & { status: AskNotification['status'] },
      ) => {
        if (!acceptReply()) {
          return;
        }
        updateCodexReply(comment.id, comment.filePath, reply);
        const isLine = isLineReviewComment(comment);
        const notification: AskNotification = {
          filePath: comment.filePath,
          id: crypto.randomUUID(),
          lineNumber: isLine ? comment.lineNumber : undefined,
          question,
          reviewKey,
          reviewVersion,
          sectionId: comment.sectionId,
          side: isLine ? comment.side : undefined,
          status: reply.status,
        };
        setAskNotifications((current) => [notification, ...current]);
      };
      pendingAnswers.current.add(commentId);
      if (currentState.source.type === 'pull-request') {
        recordReviewBriefQuestion(currentState.source, comment, question);
      }
      updateCodexReply(comment.id, comment.filePath, pendingReply);
      void window.codophon
        .askReviewAssistant(request)
        .then((result) => {
          finishReply(
            result.status === 'ready'
              ? {
                  ...pendingReply,
                  body: result.reply,
                  context: result.context,
                  error: undefined,
                  followUpDraft: undefined,
                  status: 'ready',
                  turns: [
                    ...previousTurns,
                    {
                      ...(result.context ? { context: result.context } : {}),
                      question,
                      reply: result.reply,
                    },
                  ],
                }
              : {
                  ...pendingReply,
                  error: result.reason,
                  ...(result.context ? { context: result.context } : {}),
                  status: 'error',
                },
          );
        })
        .catch((error: unknown) => {
          finishReply({
            ...pendingReply,
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        })
        .finally(() => pendingAnswers.current.delete(commentId));
    },
    [activeReviewCommentDraftRef, reviewCommentsRef, getRepository, updateCodexReply],
  );

  const submitPullRequestComment = useCallback(
    (commentId: string) => {
      const currentState = getRepository();
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        currentState?.source.type !== 'pull-request' ||
        !comment ||
        comment.body.trim().length === 0 ||
        (comment.kind === 'draft' && comment.remoteSubmit?.status === 'submitting')
      ) {
        return;
      }

      const targetGeneration = askTargetGeneration.current;
      updateAskPublication(currentState, comment.id, 'posting');
      updateRemoteSubmit(comment.id, { status: 'submitting' });
      updateActiveReviewCommentDraft(null);
      void window.codophon
        .submitPullRequestComment({
          comment: toPullRequestReviewComment(comment),
          source: currentState.source,
        })
        .then((submittedComment) => {
          if (askTargetGeneration.current === targetGeneration) {
            updateAskPublication(currentState, comment.id, 'archived');
          }
          const latest = getRepository();
          if (!latest || getAskReviewKey(currentState) !== getAskReviewKey(latest)) {
            return;
          }
          clearCommentFocus(comment.id);
          setReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === comment.id
                ? {
                    author: submittedComment.author,
                    body: submittedComment.body,
                    filePath: submittedComment.filePath,
                    id: submittedComment.id,
                    kind: 'posted' as const,
                    ...(submittedComment.anchor === 'file' ? { anchor: 'file' as const } : {}),
                    ...(submittedComment.lineNumber != null
                      ? { lineNumber: submittedComment.lineNumber }
                      : {}),
                    sectionId: comment.sectionId,
                    ...(submittedComment.side ? { side: submittedComment.side } : {}),
                    ...getReviewCommentRangeProps(submittedComment),
                    submittedAt: submittedComment.submittedAt,
                    url: submittedComment.url,
                  }
                : candidate,
            ),
          );
          onCommentFileChange(comment.filePath);
        })
        .catch((error: unknown) => {
          if (askTargetGeneration.current === targetGeneration) {
            updateAskPublication(currentState, comment.id, 'draft');
          }
          const latest = getRepository();
          if (!latest || getAskReviewKey(currentState) !== getAskReviewKey(latest)) {
            return;
          }
          updateRemoteSubmit(comment.id, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [
      clearCommentFocus,
      onCommentFileChange,
      reviewCommentsRef,
      getRepository,
      updateActiveReviewCommentDraft,
      updateAskPublication,
      updateRemoteSubmit,
    ],
  );

  const submitPullRequestReview = useCallback(
    (event: PullRequestReviewEvent, body?: string) => {
      const currentState = getRepository();
      if (
        currentState?.source.type !== 'pull-request' ||
        pullRequestReviewSubmitting ||
        isPullRequestReviewActionDisabled(currentState.source.reviewStatus, event)
      ) {
        return;
      }

      const pendingComments = getPendingPullRequestReviewComments(
        reviewCommentsRef.current,
        activeReviewCommentDraftRef.current,
      );
      if (event === 'COMMENT' && pendingComments.length === 0 && !body?.trim()) {
        return;
      }
      const pendingCommentIds = new Set(pendingComments.map((comment) => comment.id));
      const targetGeneration = askTargetGeneration.current;
      for (const id of pendingCommentIds) {
        updateAskPublication(currentState, id, 'posting');
        updateRemoteSubmit(id, { status: 'submitting' });
      }
      setPullRequestReviewSubmitting(event);
      return window.codophon
        .submitPullRequestReview({
          ...(body ? { body } : {}),
          comments: pendingComments.map((comment) => toPullRequestReviewComment(comment)),
          event,
          source: currentState.source,
        })
        .then(() => {
          if (askTargetGeneration.current === targetGeneration) {
            for (const id of pendingCommentIds) {
              updateAskPublication(currentState, id, 'archived');
            }
          }
          const latest = getRepository();
          if (!latest || getAskReviewKey(currentState) !== getAskReviewKey(latest)) {
            return;
          }
          updateActiveReviewCommentDraft(null);
          setReviewComments((current) =>
            current.filter((comment) => !pendingCommentIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          if (askTargetGeneration.current === targetGeneration) {
            for (const id of pendingCommentIds) {
              updateAskPublication(currentState, id, 'draft');
              updateRemoteSubmit(id, {
                error: error instanceof Error ? error.message : String(error),
                status: 'error',
              });
            }
          }
          window.alert(error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          setPullRequestReviewSubmitting(null);
        });
    },
    [
      activeReviewCommentDraftRef,
      pullRequestReviewSubmitting,
      reviewCommentsRef,
      getRepository,
      updateActiveReviewCommentDraft,
      updateAskPublication,
      updateRemoteSubmit,
    ],
  );

  const hasPendingReviewComments =
    getPendingPullRequestReviewComments(reviewComments, activeReviewCommentDraftState).length > 0;
  const deleteComment = useCallback(
    (id: string) => {
      updateAskPublication(getRepository(), id, 'archived');
      deleteInlineComment(id);
    },
    [deleteInlineComment, getRepository, updateAskPublication],
  );

  return {
    ...commentDrafts,
    askCacheError,
    askCodex,
    askNotifications,
    deleteComment,
    dismissAskNotification,
    hasPendingReviewComments,
    loadReviewComments,
    pullRequestReviewSubmitting,
    reviewComments,
    setReviewComments,
    submitPullRequestComment,
    submitPullRequestReview,
    updateActiveReviewCommentDraft,
    updateAskFollowUpDraft,
  };
}
