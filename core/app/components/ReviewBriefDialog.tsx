import { useEffect, useRef, useState } from 'react';
import { buildReviewBrief, getReviewBriefQuestions } from '../../lib/review-brief.ts';
import type { ReviewBriefPostedComment, ReviewSource } from '../../types.ts';
import { Button } from './Button.tsx';

type Props = ReturnType<typeof getReviewBriefQuestions> & {
  onClose: () => void;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};

type Posted =
  | { status: 'loading' }
  | { comments: ReadonlyArray<ReviewBriefPostedComment>; status: 'ready'; warning?: string };

export function ReviewBriefDialog({ onClose, questions, source, warning }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [posted, setPosted] = useState<Posted>(() =>
    source.provider === 'azure-devops'
      ? { status: 'loading' }
      : {
          comments: [],
          status: 'ready',
          warning: 'Posted comments are currently included only for Azure DevOps pull requests.',
        },
  );
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (source.provider !== 'azure-devops') {
      return;
    }
    let active = true;
    void window.codophon.getReviewBriefComments(source).then(
      (comments) => {
        if (active) {
          setPosted({ comments, status: 'ready' });
        }
      },
      () => {
        if (active) {
          setPosted({
            comments: [],
            status: 'ready',
            warning:
              'Could not load your posted Azure DevOps comments. Only Ask questions are included.',
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [source]);

  const markdown =
    posted.status === 'ready' && (questions.length || posted.comments.length)
      ? buildReviewBrief(source, questions, posted.comments, [warning, posted.warning ?? ''])
      : '';
  const dismiss = () => {
    dialogRef.current?.close();
    onClose();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  return (
    <dialog
      aria-labelledby="review-brief-title"
      className="open-review-source-dialog review-brief-dialog"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      ref={dialogRef}
    >
      <div className="open-review-source-heading">
        <h2 id="review-brief-title">Re-review brief</h2>
        <p>Preview the investigation checklist before copying it. Nothing is posted to the PR.</p>
      </div>
      {warning ? <p role="status">{warning}</p> : null}
      {posted.status === 'loading' ? <p role="status">Loading your posted comments...</p> : null}
      {posted.status === 'ready' && posted.warning ? <p role="status">{posted.warning}</p> : null}
      {posted.status === 'ready' && !markdown ? (
        <p>No Ask questions or posted comments to include.</p>
      ) : null}
      {markdown ? (
        <textarea
          aria-label="Re-review brief Markdown"
          className="open-review-source-input"
          readOnly
          spellCheck={false}
          value={markdown}
        />
      ) : null}
      {copyStatus === 'copied' ? <p role="status">Copied to clipboard.</p> : null}
      {copyStatus === 'error' ? (
        <p role="alert">Could not copy to the clipboard. Select and copy the Markdown manually.</p>
      ) : null}
      <div className="open-review-source-actions">
        <Button onClick={dismiss} type="button" variant="outline">
          Close
        </Button>
        <Button disabled={!markdown} onClick={() => void copy()} type="button">
          Copy Markdown
        </Button>
      </div>
    </dialog>
  );
}
