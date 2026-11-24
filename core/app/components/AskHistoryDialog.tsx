import { useEffect, useRef, useState } from 'react';
import { readAskThreads } from '../../lib/ask-cache.ts';
import { Button } from './Button.tsx';

function readHistory(pr: Parameters<typeof readAskThreads>[0]) {
  try {
    return { threads: readAskThreads(pr) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), threads: [] };
  }
}

export function AskHistoryDialog({
  onClose,
  pr,
}: {
  onClose: () => void;
  pr: Parameters<typeof readAskThreads>[0];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [{ error, threads }] = useState(() => readHistory(pr));
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const dismiss = () => {
    ref.current?.close();
    onClose();
  };
  const transcript = threads
    .map(({ body, codexReply, filePath, lineNumber, posting }) => {
      const turns = codexReply.turns ?? [];
      const unanswered = codexReply.status !== 'ready' ? codexReply.question : '';
      const draft = codexReply.followUpDraft;
      return [
        `${filePath}${lineNumber == null ? '' : `:${lineNumber}`}`,
        ...(posting
          ? [
              'Posting was interrupted. Check the PR before posting this comment again.',
              ...(turns.length ? [`Comment: ${body}`] : []),
            ]
          : []),
        ...(turns.length
          ? turns.flatMap((turn) => [`Asked: ${turn.question}`, `Reply: ${turn.reply}`])
          : [`Note: ${body}`, ...(codexReply.body ? [`Reply: ${codexReply.body}`] : [])]),
        ...(unanswered ? [`Unanswered: ${unanswered}`] : []),
        ...(draft && draft !== unanswered ? [`Unsent: ${draft}`] : []),
      ].join('\n\n');
    })
    .join('\n\n---\n\n');

  return (
    <dialog
      aria-labelledby="ask-history-title"
      className="open-review-source-dialog review-brief-dialog"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      ref={ref}
    >
      <div className="open-review-source-heading">
        <h2 id="ask-history-title">Ask History</h2>
        <p>
          Saved conversations for this PR, including ones no longer attached to the current diff.
        </p>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : transcript ? (
        <textarea
          aria-label="Saved Ask transcripts"
          className="open-review-source-input"
          readOnly
          spellCheck={false}
          value={transcript}
        />
      ) : (
        <p>No saved Ask conversations for this pull request.</p>
      )}
      <div className="open-review-source-actions">
        <Button onClick={dismiss} type="button" variant="outline">
          Close
        </Button>
      </div>
    </dialog>
  );
}
