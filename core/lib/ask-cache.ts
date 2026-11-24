import type { RepositoryState, ReviewAssistantContext } from '../types.ts';
import type { PullRequestSource, ReviewComment } from './app-types.ts';
import { getCommentKey, mergeReviewComments } from './review-comments.ts';
import { getSourceKey } from './source.ts';

type AskReply = NonNullable<ReviewComment['codexReply']>;
type PRState = Pick<RepositoryState, 'root'> & { source: PullRequestSource };
type AskThread = Omit<ReviewComment, 'codexReply' | 'remoteSubmit'> & {
  archived?: boolean;
  codexReply: AskReply;
  posting?: boolean;
};

const cacheKey = ({ root, source }: PRState) =>
  `codiff:ask-cache:v1:${JSON.stringify([root, getSourceKey(source)])}`;

export const getAskReviewKey = (state: RepositoryState) =>
  `${state.root}:${getSourceKey(state.source)}`;

export const getAskReviewVersion = (state: RepositoryState) =>
  state.source.type === 'pull-request'
    ? `${state.source.baseSha || ''}:${state.source.headSha || ''}`
    : state.files.map((file) => `${file.path}:${file.fingerprint}`).join('\n');

export const getAskConversationKey = (state: RepositoryState, comment: ReviewComment) =>
  `${getAskReviewKey(state)}:${getAskReviewVersion(state)}:${getCommentKey(comment)}`;

export const getAskPR = (state: RepositoryState | null): PRState | null =>
  state?.source.type === 'pull-request' ? { root: state.root, source: state.source } : null;

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
const isOptionalContext = (context: ReviewAssistantContext | undefined) =>
  context === undefined ||
  (context != null &&
    typeof context.label === 'string' &&
    Number.isFinite(context.fileCount) &&
    Number.isFinite(context.filesRead) &&
    isOptionalString(context.version) &&
    Array.isArray(context.warnings) &&
    context.warnings.every((warning) => typeof warning === 'string'));

const isAskThread = (value: unknown): value is AskThread => {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  const entry = value as Partial<AskThread>;
  const reply = entry.codexReply;
  return (
    typeof entry.id === 'string' &&
    typeof entry.filePath === 'string' &&
    typeof entry.sectionId === 'string' &&
    typeof entry.body === 'string' &&
    (entry.lineNumber === undefined || Number.isInteger(entry.lineNumber)) &&
    (entry.startLineNumber === undefined || Number.isInteger(entry.startLineNumber)) &&
    (entry.side === undefined || entry.side === 'additions' || entry.side === 'deletions') &&
    (entry.startSide === undefined ||
      entry.startSide === 'additions' ||
      entry.startSide === 'deletions') &&
    (entry.anchor === undefined || entry.anchor === 'file' || entry.anchor === 'line') &&
    (entry.archived === undefined || typeof entry.archived === 'boolean') &&
    (entry.posting === undefined || typeof entry.posting === 'boolean') &&
    (reply?.status === 'ready' || reply?.status === 'loading' || reply?.status === 'error') &&
    [reply.body, reply.error, reply.followUpDraft, reply.question, reply.reviewKey].every(
      isOptionalString,
    ) &&
    (reply.isFollowUp === undefined || typeof reply.isFollowUp === 'boolean') &&
    isOptionalContext(reply.context) &&
    (reply.turns === undefined ||
      (Array.isArray(reply.turns) &&
        reply.turns.every(
          (turn) =>
            typeof turn?.question === 'string' &&
            typeof turn.reply === 'string' &&
            isOptionalContext(turn.context),
        )))
  );
};

export const readAskThreads = (pr: PRState): ReadonlyArray<AskThread> => {
  const raw = localStorage.getItem(cacheKey(pr));
  if (raw == null) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isAskThread)) {
    throw new Error('Saved Ask conversations could not be read.');
  }
  return parsed;
};

export const isSameAskPR = (previous: PRState, next: PRState) =>
  cacheKey(previous) === cacheKey(next);

export const clearAskCache = (pr: PRState) => localStorage.removeItem(cacheKey(pr));

export function updateAskThread(
  pr: PRState,
  id: string,
  update: (existing: AskThread | undefined) => AskThread | undefined,
) {
  const threads = readAskThreads(pr);
  const previous = threads.find((thread) => thread.id === id);
  const next = update(previous);
  if (next === previous) {
    return;
  }
  const updated = previous
    ? threads.flatMap((thread) => (thread.id === id ? (next ? [next] : []) : [thread]))
    : [...threads, ...(next ? [next] : [])];
  localStorage.setItem(cacheKey(pr), JSON.stringify(updated));
}

export const isCurrentAskComment = (state: RepositoryState, comment: ReviewComment) =>
  comment.codexReply?.reviewKey === getAskConversationKey(state, comment) &&
  state.files.some(
    (file) =>
      file.path === comment.filePath &&
      file.sections.some((section) => section.id === comment.sectionId),
  );

export const restoreAskComments = (
  state: RepositoryState,
  comments: ReadonlyArray<ReviewComment>,
  threads: ReadonlyArray<AskThread>,
) =>
  mergeReviewComments(
    comments,
    threads.flatMap(({ archived, posting, ...thread }) => {
      if (archived || posting || !isCurrentAskComment(state, thread)) {
        return [];
      }
      return [
        thread.codexReply.status === 'loading'
          ? {
              ...thread,
              codexReply: {
                ...thread.codexReply,
                error:
                  'The previous Ask request was interrupted. Send the question again to retry.',
                status: 'error' as const,
              },
            }
          : thread,
      ];
    }),
  );
