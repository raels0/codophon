import './ReviewComments.css';
import type { MarkdownEditorHandle } from '@nkzw/mdx-editor';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { XIcon as X } from '@phosphor-icons/react/X';
import { type DiffLineAnnotation } from '@pierre/diffs';
import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createContext, useContext } from 'react';
import claudeIconUrl from '../../assets/claude.svg';
import codexIconUrl from '../../assets/codex.svg';
import opencodeIconUrl from '../../assets/opencode.svg';
import type { AgentBackend } from '../../config/agents.ts';
import { getShortcutLabel, matchesShortcut } from '../../config/keymap.ts';
import type { CodophonKeymap } from '../../config/types.ts';
import type {
  DraftComment,
  ReviewComment,
  ReviewCommentAnnotationMetadata,
} from '../../lib/app-types.ts';
import { isPrimaryModifier } from '../../lib/keyboard.ts';
import {
  getReviewCommentLineLabel,
  shouldDiscardReviewCommentOnEscape,
} from '../../lib/review-comments.ts';
import type { GitIdentity, PullRequestExistingReviewComment } from '../../types.ts';
import { Avatar } from './Avatar.tsx';
import { Button } from './Button.tsx';
import { MarkdownEditor } from './LazyMarkdownEditor.tsx';
import { ReadOnlyMarkdownView } from './ReadOnlyMarkdownView.tsx';
import { ReadOnlyMarkdown } from './ReviewMarkdown.tsx';

export type ReviewCommentActions = {
  agentId: AgentBackend;
  agentLabel: string;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  onAskCodex?: (commentId: string, followUp?: string) => void;
  onAskFollowUpDraftChange?: (commentId: string, body: string) => void;
  onCommentDraftChange?: (comment: Pick<ReviewComment, 'body' | 'id'> | null) => void;
  onCreateComment: (comment: Omit<DraftComment, 'body' | 'id' | 'kind'>) => void;
  onDeleteComment: (commentId: string) => void;
  onSubmitComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  supportsReviewCommentActions: boolean;
};
type ReviewCommentsApi = ReviewCommentActions & {
  comments: ReadonlyMap<string, ReviewComment>;
  keymap: CodophonKeymap;
  onCommentBlur: (comment: ReviewComment, body: string, flushDraft: () => void) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onReplyToThread: (threadId: string, comment: ReviewComment) => void;
};
export const ReviewCommentsContext = createContext<ReviewCommentsApi | null>(null);
function useReviewComments() {
  const context = useContext(ReviewCommentsContext);
  if (!context) {
    throw new Error('Review comments require a ReviewCommentsContext provider');
  }
  return context;
}
const getReviewAuthorDisplayName = (author: PullRequestExistingReviewComment['author']) =>
  author.name || author.login || 'Git user';

const getGitIdentityDisplayName = (identity: GitIdentity | null) =>
  identity?.name || identity?.email || 'Git user';

function ReviewAvatar({ author }: { author: PullRequestExistingReviewComment['author'] }) {
  return <Avatar name={getReviewAuthorDisplayName(author)} size="medium" url={author.avatarUrl} />;
}

function IdentityReviewAvatar({ identity }: { identity: GitIdentity | null }) {
  return (
    <ReviewAvatar
      author={{
        avatarUrl: identity?.gravatarUrl,
        login: getGitIdentityDisplayName(identity),
      }}
    />
  );
}

function AgentAvatar({ agentId }: { agentId: AgentBackend }) {
  return (
    <img
      alt=""
      className="review-comment-avatar-codex"
      draggable={false}
      src={agentIconUrl(agentId)}
    />
  );
}

const agentIconUrl = (agentId: AgentBackend) => {
  return agentId === 'opencode'
    ? opencodeIconUrl
    : agentId === 'claude'
      ? claudeIconUrl
      : codexIconUrl;
};

const canAskCodexForComment = (comment: ReviewComment) =>
  comment.kind === 'draft' &&
  comment.body.trim().length > 0 &&
  comment.codexReply?.status !== 'loading';

const canSubmitComment = (comment: ReviewComment) =>
  comment.kind === 'draft' &&
  comment.body.trim().length > 0 &&
  comment.remoteSubmit?.status !== 'submitting';

const withCommentBody = (comment: ReviewComment, body: string): ReviewComment =>
  comment.body === body ? comment : { ...comment, body };

function ReviewAssistantFollowUp({
  disabled,
  initialQuestion,
  inputId,
  keymap,
  onDraftChange,
  onSend,
}: {
  disabled: boolean;
  initialQuestion: string;
  inputId: string;
  keymap: CodophonKeymap;
  onDraftChange?: (body: string) => void;
  onSend: (question: string) => void;
}) {
  const [question, setQuestion] = useState(initialQuestion);
  const send = () => {
    if (!disabled && question.trim()) {
      onSend(question.trim());
    }
  };
  return (
    <form
      className="review-comment-assistant-follow-up"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor={inputId}>Ask a follow-up</label>
      <textarea
        disabled={disabled}
        id={inputId}
        maxLength={16_000}
        onChange={(event) => {
          const body = event.currentTarget.value;
          setQuestion(body);
          onDraftChange?.(body);
        }}
        onKeyDown={(event) => {
          const sendShortcut =
            event.key === 'Enter' && isPrimaryModifier(event) && !event.altKey && !event.shiftKey;
          if (
            !event.nativeEvent.isComposing &&
            (sendShortcut || matchesShortcut(event, keymap, 'askAgent'))
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) {
              send();
            }
          }
        }}
        placeholder="Ask about the answer…"
        rows={2}
        value={question}
      />
      <div>
        <span>Ctrl/Cmd+Enter or {getShortcutLabel(keymap, 'askAgent')} to send</span>
        <Button
          className="review-comment-action"
          disabled={disabled || !question.trim()}
          size="sm"
          type="submit"
          variant="outline"
        >
          Send
        </Button>
      </div>
    </form>
  );
}

function ReviewAssistantConversation({
  agentLabel,
  commentId,
  keymap,
  onDraftChange,
  onFollowUp,
  reply,
}: {
  agentLabel: string;
  commentId: string;
  keymap: CodophonKeymap;
  onDraftChange?: (body: string) => void;
  onFollowUp?: (question: string) => void;
  reply: NonNullable<ReviewComment['codexReply']>;
}) {
  const turns =
    reply.turns ||
    (reply.body
      ? [
          {
            context: reply.context,
            question: '',
            reply: reply.body,
          },
        ]
      : []);
  return (
    <>
      {turns.map((turn, index) => (
        <div className="review-comment-assistant-turn" key={index}>
          {index > 0 ? (
            <div className="review-comment-codex-reply review-comment-assistant-question">
              <strong>You asked</strong>
              <ReadOnlyMarkdown
                ariaLabel={`Follow-up question ${index}`}
                className="review-comment-codex-reply-markdown"
                density="compact"
                value={turn.question}
                variant="embedded"
              />
            </div>
          ) : null}
          {turn.context ? (
            <details className="review-comment-assistant-context">
              <summary>
                {turn.context.label} · {turn.context.fileCount} changed files
                {turn.context.warnings.length ? ' · Limited context' : ''}
              </summary>
              <div>
                Changes from {turn.context.filesRead} files were provided.
                {turn.context.version ? ` Saved version: ${turn.context.version}.` : ''}
              </div>
              {turn.context.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </details>
          ) : null}
          <div className="review-comment-codex-reply">
            <ReadOnlyMarkdown
              ariaLabel={index === 0 ? `${agentLabel} reply` : `${agentLabel} reply ${index + 1}`}
              className="review-comment-codex-reply-markdown"
              density="compact"
              value={turn.reply}
              variant="embedded"
            />
          </div>
        </div>
      ))}
      {reply.status === 'loading' ? (
        <div className="review-comment-codex-reply is-loading" role="status">
          <span className="review-comment-codex-loading">
            Reading review context with {agentLabel}…
          </span>
        </div>
      ) : reply.status === 'error' ? (
        <div className="review-comment-codex-reply error" role="alert">
          <ReadOnlyMarkdown
            ariaLabel={`${agentLabel} error`}
            className="review-comment-codex-reply-markdown"
            density="compact"
            value={reply.error || 'The assistant could not answer. Ask again.'}
            variant="embedded"
          />
        </div>
      ) : null}
      {onFollowUp && turns.length > 0 ? (
        <ReviewAssistantFollowUp
          disabled={reply.status === 'loading'}
          initialQuestion={
            reply.followUpDraft ??
            (reply.status !== 'ready' && reply.isFollowUp !== false ? reply.question || '' : '')
          }
          inputId={`ask-follow-up-${commentId}`}
          key={turns.length}
          keymap={keymap}
          onDraftChange={onDraftChange}
          onSend={onFollowUp}
        />
      ) : null}
    </>
  );
}

function ReviewCommentEditor({
  comment,
  displayName,
  focusEditorRef,
}: {
  comment: ReviewComment;
  displayName: string;
  focusEditorRef: (node: MarkdownEditorHandle | null) => void;
}) {
  const {
    agentId,
    agentLabel,
    focusCommentId,
    identity,
    keymap,
    onAskCodex,
    onAskFollowUpDraftChange,
    onCommentBlur,
    onCommentDraftChange,
    onCommentFocus,
    onDeleteComment,
    onSubmitComment,
    onUpdateComment,
    supportsReviewCommentActions,
  } = useReviewComments();
  const [draftState, setDraftState] = useState(() => ({
    commentBody: comment.body,
    commentId: comment.id,
    dirty: false,
    draft: comment.body,
  }));
  const effectiveDraftState =
    draftState.commentId === comment.id
      ? draftState
      : {
          commentBody: comment.body,
          commentId: comment.id,
          dirty: false,
          draft: comment.body,
        };
  const draft =
    !effectiveDraftState.dirty && effectiveDraftState.commentBody !== comment.body
      ? comment.body
      : effectiveDraftState.draft;
  const displayedBody = comment.body;

  const draftComment = withCommentBody(comment, draft);
  const canAskCodex = onAskCodex != null && canAskCodexForComment(draftComment);
  const commentCanSubmit = canSubmitComment(draftComment);
  const flushDraft = useCallback(() => {
    setDraftState((current) =>
      current.commentId === comment.id
        ? {
            ...current,
            commentBody: comment.body,
            dirty: false,
            draft,
          }
        : {
            commentBody: comment.body,
            commentId: comment.id,
            dirty: false,
            draft,
          },
    );
    if (comment.kind === 'draft' && draft !== comment.body) {
      onUpdateComment(comment.id, draft);
    }
    return withCommentBody(comment, draft);
  }, [comment, draft, onUpdateComment]);
  const handleChange = useCallback(
    (draft: string) => {
      setDraftState((current) => ({
        commentBody: comment.body,
        commentId: comment.id,
        dirty: true,
        draft,
      }));
      onCommentDraftChange?.({ body: draft, id: comment.id });
    },
    [comment.body, comment.id, onCommentDraftChange],
  );

  const handleAskCodex = useCallback(() => {
    const flushed = flushDraft();
    if (onAskCodex && canAskCodexForComment(flushed)) {
      onAskCodex(comment.id);
    }
  }, [comment.id, flushDraft, onAskCodex]);

  const handleSubmitComment = useCallback(() => {
    const flushed = flushDraft();
    if (canSubmitComment(flushed)) {
      onSubmitComment(comment.id);
    }
  }, [comment.id, flushDraft, onSubmitComment]);

  const handleBlur = useCallback(() => {
    onCommentBlur(comment, draft, flushDraft);
  }, [comment, draft, flushDraft, onCommentBlur]);

  // Local reviews have nothing to submit a comment to, so adding one means
  // finishing it the way clicking away does. `MarkdownEditorHandle` exposes no
  // blur, so focus leaves through the focused element and the editor's own blur
  // handler flushes the draft and closes the comment.
  const handleAddComment = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const handleFocus = useCallback(() => {
    onCommentFocus(draftComment);
  }, [draftComment, onCommentFocus]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (matchesShortcut(event, keymap, 'submitComment')) {
        if (supportsReviewCommentActions) {
          if (commentCanSubmit) {
            event.preventDefault();
            event.stopPropagation();
            handleSubmitComment();
          }
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        handleAddComment();
        return;
      }

      if (matchesShortcut(event, keymap, 'askAgent')) {
        if (canAskCodex) {
          event.preventDefault();
          event.stopPropagation();
          handleAskCodex();
        }
        return;
      }

      if (!matchesShortcut(event, keymap, 'discardComment')) {
        return;
      }

      if (comment.kind === 'posted') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (shouldDiscardReviewCommentOnEscape(draft)) {
        onDeleteComment(comment.id);
      }
    },
    [
      canAskCodex,
      commentCanSubmit,
      comment.id,
      comment.kind,
      draft,
      handleAddComment,
      handleAskCodex,
      handleSubmitComment,
      keymap,
      onDeleteComment,
      supportsReviewCommentActions,
    ],
  );
  return (
    <Fragment>
      <div className="review-comment">
        {comment.kind === 'posted' && comment.author ? (
          <ReviewAvatar author={comment.author} />
        ) : (
          <IdentityReviewAvatar identity={identity} />
        )}
        <div className="review-comment-body">
          <div
            className={`review-comment-header${
              supportsReviewCommentActions && comment.kind === 'draft' ? ' with-comment-action' : ''
            }${comment.kind === 'posted' ? ' read-only' : ''}`}
          >
            <strong>{displayName}</strong>
            {comment.kind === 'draft' && onAskCodex ? (
              <Button
                className="review-comment-action"
                disabled={!canAskCodex}
                onClick={handleAskCodex}
                size="sm"
                title={
                  canAskCodex
                    ? `Ask ${agentLabel} (${getShortcutLabel(keymap, 'askAgent')})`
                    : `Write a note before asking ${agentLabel}`
                }
                type="button"
                variant="outline"
              >
                <img
                  alt=""
                  aria-hidden
                  className="review-comment-action-icon"
                  draggable={false}
                  src={agentIconUrl(agentId)}
                />
                Ask
              </Button>
            ) : null}
            {supportsReviewCommentActions && comment.kind === 'draft' ? (
              <Button
                className="review-comment-action review-comment-action-primary"
                disabled={!commentCanSubmit}
                onClick={handleSubmitComment}
                size="sm"
                title={
                  commentCanSubmit
                    ? `Post comment (${getShortcutLabel(keymap, 'submitComment')})`
                    : 'Write a note before commenting'
                }
                type="button"
                variant="outline"
              >
                <ChatCircle
                  aria-hidden
                  className="review-comment-action-icon"
                  size={14}
                  weight="bold"
                />
                {comment.remoteSubmit?.status === 'submitting' ? 'Posting...' : 'Post comment'}
              </Button>
            ) : null}
            {comment.kind === 'draft' ? (
              <button
                aria-label="Delete comment"
                className="review-comment-delete"
                onClick={() => onDeleteComment(comment.id)}
                title="Delete comment"
                type="button"
              >
                <X aria-hidden className="review-comment-delete-icon" size={14} weight="bold" />
              </button>
            ) : null}
          </div>
          {comment.kind === 'posted' ? (
            <ReadOnlyMarkdownView
              ariaLabel={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
              className="review-comment-markdown-editor"
              contentClassName="review-comment-input read-only"
              fallback={<div className="review-comment-input read-only" />}
              value={displayedBody}
              variant="embedded"
            />
          ) : (
            <Suspense fallback={<div className="review-comment-input" />}>
              <MarkdownEditor
                ariaLabel={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
                className="review-comment-markdown-editor"
                colorScheme="inherit"
                contentClassName="review-comment-input"
                density="compact"
                onBlur={handleBlur}
                onChange={handleChange}
                onFocus={handleFocus}
                onKeyDown={handleKeyDown}
                placeholder="Write a review comment…"
                ref={comment.id === focusCommentId ? focusEditorRef : undefined}
                spellCheck
                value={draft}
                variant="embedded"
              />
            </Suspense>
          )}
          {comment.kind === 'draft' && comment.remoteSubmit?.status === 'error' ? (
            <div className="review-comment-error">{comment.remoteSubmit.error}</div>
          ) : null}
        </div>
      </div>
      {comment.codexReply ? (
        <div className="review-comment codex">
          <AgentAvatar agentId={agentId} />
          <div className="review-comment-body codex">
            <div className="review-comment-header codex">
              <strong>{agentLabel}</strong>
            </div>
            <ReviewAssistantConversation
              agentLabel={agentLabel}
              commentId={comment.id}
              keymap={keymap}
              onDraftChange={(body) => onAskFollowUpDraftChange?.(comment.id, body)}
              onFollowUp={onAskCodex ? (question) => onAskCodex(comment.id, question) : undefined}
              reply={comment.codexReply}
            />
          </div>
        </div>
      ) : null}
    </Fragment>
  );
}

const groupReviewCommentsByThread = (comments: ReadonlyArray<ReviewComment>) => {
  const groups: Array<{ comments: Array<ReviewComment>; key: string }> = [];
  const groupByThreadId = new Map<string, { comments: Array<ReviewComment>; key: string }>();

  for (const comment of comments) {
    if (!comment.threadId) {
      groups.push({ comments: [comment], key: comment.id });
      continue;
    }

    let group = groupByThreadId.get(comment.threadId);
    if (!group) {
      group = { comments: [], key: `thread:${comment.threadId}` };
      groupByThreadId.set(comment.threadId, group);
      groups.push(group);
    }
    group.comments.push(comment);
  }

  return groups;
};

function ReviewCommentThreadGroup({
  comments,
  focusEditorRef,
}: {
  comments: ReadonlyArray<ReviewComment>;
  focusEditorRef: (node: MarkdownEditorHandle | null) => void;
}) {
  const { identity, onReplyToThread, supportsReviewCommentActions } = useReviewComments();
  const lastComment = comments.at(-1);
  const threadId = lastComment?.threadId;
  const canReplyToThread =
    supportsReviewCommentActions &&
    threadId != null &&
    comments.some((comment) => comment.kind === 'posted') &&
    !comments.some((comment) => comment.kind === 'draft') &&
    !comments.some((comment) => comment.kind === 'posted' && comment.canReplyThread === false);

  const handleReply = useCallback(() => {
    if (!threadId || !lastComment) {
      return;
    }
    onReplyToThread(threadId, lastComment);
  }, [lastComment, onReplyToThread, threadId]);

  return (
    <div className="review-comment-thread-group">
      {comments.map((comment) => {
        const displayName =
          comment.kind === 'posted' && comment.author
            ? getReviewAuthorDisplayName(comment.author)
            : getGitIdentityDisplayName(identity);

        return (
          <ReviewCommentEditor
            comment={comment}
            displayName={displayName}

            focusEditorRef={focusEditorRef}

            key={comment.id}
          />
        );
      })}
      {canReplyToThread ? (
        <div className="review-comment-thread-footer">
          <div className="review-comment-thread-actions">
            <Button
              className="review-comment-action"
              onClick={handleReply}
              size="sm"
              type="button"
              variant="outline"
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewAnnotation({
  annotation,
  onHeightChange,
}: {
  annotation: DiffLineAnnotation<ReviewCommentAnnotationMetadata>;
  onHeightChange: () => void;
}) {
  const { comments, focusCommentId, focusCommentRequest } = useReviewComments();
  const focusEditorRef = useRef<MarkdownEditorHandle>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const setFocusEditorRef = useCallback((node: MarkdownEditorHandle | null) => {
    focusEditorRef.current = node;
  }, []);
  const annotationComments = annotation.metadata.commentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is ReviewComment => comment != null);
  const hasFocusedComment =
    focusCommentId != null && annotationComments.some((comment) => comment.id === focusCommentId);

  useEffect(() => {
    if (hasFocusedComment) {
      focusEditorRef.current?.focus();
    }
  }, [focusCommentId, focusCommentRequest, hasFocusedComment]);

  // Observe the whole thread so independent markdown blocks cannot invalidate each other.
  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }

    let height = thread.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const nextHeight = thread.getBoundingClientRect().height;
      if (height !== nextHeight) {
        height = nextHeight;
        onHeightChange();
      }
    });
    observer.observe(thread);
    return () => observer.disconnect();
  }, [annotationComments.length, onHeightChange]);

  if (annotationComments.length === 0) {
    return null;
  }
  const commentGroups = groupReviewCommentsByThread(annotationComments);

  return (
    <div className="review-comment-thread" ref={threadRef}>
      {commentGroups.map((group) => (
        <ReviewCommentThreadGroup
          comments={group.comments}

          focusEditorRef={setFocusEditorRef}

          key={group.key}
        />
      ))}
    </div>
  );
}
