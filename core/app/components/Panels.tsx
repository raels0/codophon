import './Panels.css';
import type { MarkdownEditorHandle } from '@nkzw/mdx-editor';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CaretUpIcon as CaretUp } from '@phosphor-icons/react/CaretUp';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { SealQuestionIcon as SealQuestion } from '@phosphor-icons/react/SealQuestion';
import { XIcon as X } from '@phosphor-icons/react/X';
import { Copy as LucideCopy } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodophonKeymap } from '../../config/types.ts';
import type { RepositoryLoadError, ReviewComment } from '../../lib/app-types.ts';
import {
  getPullRequestReviewActionStatus,
  isPullRequestReviewActionDisabled,
} from '../../lib/pull-request-actions.ts';
import { buildReviewCommentsMarkdown } from '../../lib/review-comments.ts';
import type {
  ChangedFile,
  CodophonUpdateStatus,
  PullRequestReviewEvent,
  PullRequestReviewStatus,
} from '../../types.ts';
import { Button, buttonVariants } from './Button.tsx';
import { MarkdownEditor } from './LazyMarkdownEditor.tsx';
import { useCopiedState } from './useCopiedState.ts';

export function ReviewSourceLoading() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="review-source-loading loading pulse" role="status">
      {visible ? 'Thinking…' : null}
    </div>
  );
}

export function RepositoryChangeBanner({
  error,
  onRefresh,
  refreshing = false,
  visible,
}: {
  error?: string | null;
  onRefresh: () => void;
  refreshing?: boolean;
  visible: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const showBanner = visible || error != null;
  // Re-arm the dismiss latch once the current change is refreshed away, so the
  // banner comes back for the next change instead of staying dismissed forever.
  if (!showBanner && dismissed) {
    setDismissed(false);
  }
  const isVisible = showBanner && !dismissed;

  return (
    <div
      aria-live="polite"
      className={`repository-change-banner${error ? ' error' : ''}${isVisible ? ' visible' : ''}`}
      role={error ? 'alert' : undefined}
    >
      <span className="repository-change-banner-content">
        <span>{error ? `Refresh failed: ${error}` : 'Local changes detected,'}</span>
        <button
          className="repository-change-reload"
          disabled={refreshing}
          onClick={onRefresh}
          type="button"
        >
          {error ? 'Retry' : 'refresh to see them.'}
        </button>
      </span>
      <button
        aria-label="Dismiss update banner"
        className="repository-change-dismiss"
        onClick={() => setDismissed(true)}
        title="Dismiss"
        type="button"
      >
        <X aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
    </div>
  );
}

export type { CodophonUpdateStatus as UpdateStatus } from '../../types.ts';

const getUpdatePillContent = ({
  availableVersion,
  currentVersion,
  download,
}: CodophonUpdateStatus) => {
  const update = `Codophon ${availableVersion} (you have ${currentVersion})`;
  switch (download?.state) {
    case 'downloading':
      return {
        label: `Downloading update… ${download.progress}%`,
        title: `Downloading ${update}.`,
      };
    case 'ready':
      return { label: 'Restart to update', title: `Install ${update} and restart.` };
    case 'failed':
      return { label: 'Retry update', title: `${download.error} Retries downloading ${update}.` };
    default:
      return {
        label: 'Update available',
        title: `${update} is available. Opens the release page.`,
      };
  }
};

export function UpdatePill({
  onDismiss,
  onInstall,
  status,
}: {
  onDismiss: () => void;
  onInstall: () => void;
  status: CodophonUpdateStatus;
}) {
  if (!status.availableVersion) {
    return null;
  }
  const { label, title } = getUpdatePillContent(status);

  return (
    <div aria-live="polite" className="update-pill-anchor">
      <Button
        className="update-pill available"
        disabled={status.download?.state === 'downloading'}
        onClick={onInstall}
        title={title}
        type="button"
      >
        <span>{label}</span>
      </Button>
      <button
        aria-label="Dismiss update"
        className="update-pill-dismiss"
        onClick={onDismiss}
        title="Dismiss"
        type="button"
      >
        <X aria-hidden size={13} weight="bold" />
      </button>
    </div>
  );
}

export function WalkthroughOutdatedBanner({
  onDismiss,
  reason,
}: {
  onDismiss: () => void;
  reason: string | null;
}) {
  const isVisible = reason != null;

  return (
    <div
      aria-live="polite"
      className={`walkthrough-outdated-banner${isVisible ? ' visible' : ''}`}
      role="status"
    >
      <span className="walkthrough-outdated-banner-content">
        <strong>Walkthrough out of date.</strong>
        <span>{reason ?? ''} Showing history instead.</span>
      </span>
      <button
        aria-label="Dismiss walkthrough banner"
        className="repository-change-dismiss"
        onClick={onDismiss}
        title="Dismiss"
        type="button"
      >
        <X aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
    </div>
  );
}

export function FirstRunPanel({
  agentSkillInstalled,
  agentSkillInstalling,
  agentSkillLabel,
  installing,
  onInstallAgentSkill,
  onInstallTerminalHelper,
}: {
  agentSkillInstalled: boolean;
  agentSkillInstalling: boolean;
  agentSkillLabel: string;
  installing: boolean;
  onInstallAgentSkill: () => void;
  onInstallTerminalHelper: () => void;
}) {
  return (
    <>
      <strong>Open a Git repository</strong>
      <p>
        Install the terminal helper, then run{' '}
        <code className="walkthrough-inline-code">codophon</code> from a Git repository in Terminal.
      </p>
      <p>
        You can also choose <span className="empty-panel-menu-path">File → Open Folder…</span> to
        open a Git repository.
      </p>
      <div className="empty-panel-actions">
        <button disabled={installing} onClick={onInstallTerminalHelper} type="button">
          {installing ? 'Installing...' : 'Install Terminal Helper'}
        </button>
        {!agentSkillInstalled ? (
          <button disabled={agentSkillInstalling} onClick={onInstallAgentSkill} type="button">
            {agentSkillInstalling ? 'Installing...' : `Install ${agentSkillLabel}`}
          </button>
        ) : null}
      </div>
    </>
  );
}

export function RepositoryLoadErrorPanel({ error }: { error: RepositoryLoadError }) {
  if (error.kind === 'not-a-repository') {
    return (
      <>
        <strong>No Git repository found</strong>
        <p>
          Codophon was opened outside a Git repository. Run{' '}
          <code className="walkthrough-inline-code">codophon</code> from inside a repo, or choose{' '}
          <span className="empty-panel-menu-path">File → Open Folder…</span> to open one.
        </p>
      </>
    );
  }

  return (
    <>
      <strong>Unable to read repository</strong>
      <p>{error.message}</p>
    </>
  );
}

export function AgentUnavailablePanel({
  agentLabel,
  onShowFiles,
  reason,
  title,
}: {
  agentLabel: string;
  onShowFiles: () => void;
  reason?: string;
  title?: string;
}) {
  return (
    <>
      <strong>{title ?? `${agentLabel} CLI not found`}</strong>
      <p>
        {reason ??
          `Install ${agentLabel} and verify its CLI works in Terminal, then try the walkthrough again.`}
      </p>
      <div className="empty-panel-actions">
        <button onClick={onShowFiles} type="button">
          Review Files
        </button>
      </div>
    </>
  );
}

export function DiffSearchPanel({
  activeIndex,
  focusRequest,
  keymap,
  matchCount,
  onChange,
  onClose,
  onNext,
  onPrevious,
  query,
  visible,
}: {
  activeIndex: number;
  focusRequest: number;
  keymap: CodophonKeymap;
  matchCount: number;
  onChange: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  query: string;
  visible: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [focusRequest, visible]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (matchesShortcut(event, keymap, 'closeSearch')) {
        event.preventDefault();
        onClose();
        return;
      }

      if (matchesShortcut(event, keymap, 'prevSearchMatch')) {
        event.preventDefault();
        onPrevious();
        return;
      }

      if (matchesShortcut(event, keymap, 'nextSearchMatch')) {
        event.preventDefault();
        onNext();
      }
    },
    [keymap, onClose, onNext, onPrevious],
  );

  return (
    <div className={`diff-search-panel${visible ? ' visible' : ''}`}>
      <input
        aria-label="Search diffs"
        className="diff-search-input"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in diffs"
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={query}
      />
      <span className="diff-search-count">
        {query.trim() ? (matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : '0/0') : ''}
      </span>
      <button
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={onPrevious}
        title="Previous match"
        type="button"
      >
        <CaretUp aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
      <button
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
        title="Next match"
        type="button"
      >
        <CaretDown aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
      <button aria-label="Close search" onClick={onClose} title="Close" type="button">
        <X aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
    </div>
  );
}

export function CopyCommentsButton({
  comments,
  files,
  reviewCommentsPrefix,
  showWhitespace,
}: {
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  reviewCommentsPrefix: string;
  showWhitespace: boolean;
}) {
  const [copied, markCopied] = useCopiedState(2000);
  const pendingCommentCount = comments.filter(
    (comment) => comment.kind === 'draft' && comment.body.trim(),
  ).length;

  const copyComments = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(
      files,
      comments,
      showWhitespace,
      reviewCommentsPrefix,
    );
    if (!markdown) {
      return;
    }

    await navigator.clipboard.writeText(markdown);
    markCopied();
  }, [comments, files, markCopied, reviewCommentsPrefix, showWhitespace]);

  return (
    <button
      aria-label={
        pendingCommentCount === 0
          ? 'Copy review comments as markdown, no comments yet'
          : `Copy ${pendingCommentCount} review ${
              pendingCommentCount === 1 ? 'comment' : 'comments'
            }`
      }
      className={`copy-comments-button${copied ? ' copied' : ''}`}
      disabled={pendingCommentCount === 0}
      onClick={() => void copyComments()}
      title="Copy review comments as markdown"
      type="button"
    >
      {copied ? (
        <Check aria-hidden className="copy-comments-icon check" size={15} weight="bold" />
      ) : (
        <LucideCopy aria-hidden className="copy-comments-icon" size={14} strokeWidth={2.25} />
      )}
      <span className="copy-comments-count">{pendingCommentCount}</span>
    </button>
  );
}

const getPullRequestReviewActionTitle = (
  reviewStatus: PullRequestReviewStatus | undefined,
  event: PullRequestReviewEvent,
  fallback: string,
) => getPullRequestReviewActionStatus(reviewStatus, event)?.reason ?? fallback;

function PullRequestReviewAction({
  disabled,
  event,
  hasPendingComments = false,
  icon,
  label,
  onSubmitReview,
  title,
}: {
  disabled: boolean;
  event: PullRequestReviewEvent;
  hasPendingComments?: boolean;
  icon: ReactNode;
  label: string;
  onSubmitReview: (event: PullRequestReviewEvent, body?: string) => Promise<void> | void;
  title: string;
}) {
  const [body, setBody] = useState('');
  const [open, setOpen] = useState(false);
  const [previousDisabled, setPreviousDisabled] = useState(disabled);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const trimmedBody = body.trim();
  const isApprove = event === 'APPROVE';
  const isComment = event === 'COMMENT';
  const variant = isApprove ? 'approve' : isComment ? 'comment' : 'request-changes';
  const actionLabel = isApprove
    ? 'Approve review'
    : isComment
      ? 'Submit review comments'
      : 'Request changes';
  const commentLabel = isApprove
    ? 'Add approval comment'
    : isComment
      ? 'Add review comment'
      : 'Add request changes comment';
  const placeholder = isApprove
    ? 'Add an approval comment…'
    : isComment
      ? 'Add a review comment…'
      : 'Add a change request comment…';
  const primaryDisabled = disabled || (isComment && !hasPendingComments);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focus({ defaultSelection: 'rootEnd', preventScroll: true });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      // oxlint-disable-next-line @nkzw/no-instanceof
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  if (disabled !== previousDisabled) {
    setPreviousDisabled(disabled);
    if (disabled) {
      setOpen(false);
    }
  }

  const submitWithComment = useCallback(() => {
    if (disabled || !trimmedBody) {
      return;
    }
    void Promise.resolve(onSubmitReview(event, trimmedBody))
      .then(() => {
        setBody('');
        setOpen(false);
      })
      .catch(() => {});
  }, [disabled, event, onSubmitReview, trimmedBody]);

  const submitWithoutComment = useCallback(() => {
    if (primaryDisabled) {
      return;
    }
    setOpen(false);
    void Promise.resolve(onSubmitReview(event)).catch(() => {});
  }, [event, onSubmitReview, primaryDisabled]);

  const handleEditorKeyDown = useCallback(
    (keyboardEvent: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        keyboardEvent.key !== 'Enter' ||
        (!keyboardEvent.metaKey && !keyboardEvent.ctrlKey) ||
        !trimmedBody
      ) {
        return;
      }
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      submitWithComment();
    },
    [submitWithComment, trimmedBody],
  );

  return (
    <div className="review-submit-action" ref={rootRef}>
      <div
        className={buttonVariants({ className: `review-submit-button ${variant}` })}
        data-disabled={disabled || undefined}
      >
        <button
          aria-label={actionLabel}
          className="review-submit-primary"
          disabled={primaryDisabled}
          onClick={submitWithoutComment}
          title={
            isComment && !hasPendingComments
              ? 'Add an inline comment or write a review comment from the menu'
              : title
          }
          type="button"
        >
          {icon}
          <span>{label}</span>
        </button>
        <span aria-hidden className="review-submit-divider">
          |
        </span>
        <button
          aria-controls={popoverId}
          aria-expanded={open}
          aria-label={commentLabel}
          className="review-submit-toggle"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          title={commentLabel}
          type="button"
        >
          <CaretDown
            aria-hidden
            className={`review-submit-chevron${open ? ' expanded' : ''}`}
            size={13}
            weight="bold"
          />
        </button>
      </div>
      {open ? (
        <div
          aria-label={`${label} with comment`}
          className="review-submit-popover"
          id={popoverId}
          role="group"
        >
          <MarkdownEditor
            ariaLabel={commentLabel}
            autoFocus
            className="review-comment-markdown-editor review-submit-popover-editor"
            colorScheme="inherit"
            contentClassName="review-comment-input general-comment-input"
            density="compact"
            onChange={setBody}
            onKeyDown={handleEditorKeyDown}
            placeholder={placeholder}
            readOnly={disabled}
            ref={editorRef}
            spellCheck
            value={body}
            variant="embedded"
          />
          <div className="review-submit-popover-footer">
            <Button
              className={`review-submit-popover-submit ${variant}`}
              disabled={disabled || !trimmedBody}
              onClick={submitWithComment}
              type="button"
            >
              {icon}
              <span>{label}</span>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PullRequestReviewButtons({
  children,
  disabled,
  hasPendingComments,
  onSubmitReview,
  reviewStatus,
  showCommentReview = false,
}: {
  children?: ReactNode;
  disabled: boolean;
  hasPendingComments: boolean;
  onSubmitReview: (event: PullRequestReviewEvent, body?: string) => Promise<void> | void;
  reviewStatus?: PullRequestReviewStatus;
  showCommentReview?: boolean;
}) {
  const approveBlocked = isPullRequestReviewActionDisabled(reviewStatus, 'APPROVE');
  const commentBlocked = isPullRequestReviewActionDisabled(reviewStatus, 'COMMENT');
  const requestChangesBlocked = isPullRequestReviewActionDisabled(reviewStatus, 'REQUEST_CHANGES');
  const commentVisible = showCommentReview && !commentBlocked;
  const hasReviewActions = commentVisible || !approveBlocked || !requestChangesBlocked;
  if (!hasReviewActions && !children) {
    return null;
  }

  return (
    <div
      aria-label={hasReviewActions ? 'Pull request review actions' : 'Pull request status'}
      className="source-description-review-actions"
    >
      {children}
      {commentVisible ? (
        <PullRequestReviewAction
          disabled={disabled}
          event="COMMENT"
          hasPendingComments={hasPendingComments}
          icon={
            <ChatCircle
              aria-hidden
              className="review-submit-icon comment"
              size={15}
              weight="bold"
            />
          }
          label="Comment"
          onSubmitReview={onSubmitReview}
          title={getPullRequestReviewActionTitle(reviewStatus, 'COMMENT', 'Submit review comments')}
        />
      ) : null}
      {!approveBlocked ? (
        <PullRequestReviewAction
          disabled={disabled}
          event="APPROVE"
          icon={
            <Check aria-hidden className="review-submit-icon approve" size={15} weight="bold" />
          }
          label="Approve"
          onSubmitReview={onSubmitReview}
          title={getPullRequestReviewActionTitle(reviewStatus, 'APPROVE', 'Approve review')}
        />
      ) : null}
      {!requestChangesBlocked ? (
        <PullRequestReviewAction
          disabled={disabled}
          event="REQUEST_CHANGES"
          icon={
            <SealQuestion
              aria-hidden
              className="review-submit-icon request-changes"
              size={15}
              weight="bold"
            />
          }
          label="Request Changes"
          onSubmitReview={onSubmitReview}
          title={getPullRequestReviewActionTitle(
            reviewStatus,
            'REQUEST_CHANGES',
            'Request changes',
          )}
        />
      ) : null}
    </div>
  );
}
