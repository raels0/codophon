/**
 * @vitest-environment jsdom
 */

import { act, useLayoutEffect, useRef } from 'react';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { AskNotifications } from '../app/components/AskNotifications.tsx';
import { useAppReviewComments } from '../app/hooks/useAppReviewComments.ts';
import type { ReviewComment } from '../lib/app-types.ts';
import { readAskThreads } from '../lib/ask-cache.ts';
import { buildReviewBrief, getReviewBriefQuestions } from '../lib/review-brief.ts';
import type { RepositoryState, ReviewAssistantRequest, ReviewAssistantResult } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

type AppReviewComments = ReturnType<typeof useAppReviewComments>;

const originalCodiff = window.codiff;
const workingTreeState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;
const pullRequestState = {
  ...workingTreeState,
  source: {
    number: 42,
    owner: 'nkzw-tech',
    provider: 'github',
    repo: 'codiff',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/42',
  },
} satisfies RepositoryState;
const comment: ReviewComment = {
  body: 'Review this',
  filePath: 'src/app.ts',
  id: 'comment-1',
  lineNumber: 4,
  sectionId: 'src/app.ts:pull-request',
  side: 'additions',
};

function AppReviewCommentsHarness({
  onCommentFileChange,
  onNavigate,
  onState,
  state,
}: {
  onCommentFileChange: (filePath: string) => void;
  onNavigate: Parameters<typeof AskNotifications>[0]['onNavigate'];
  onState: (comments: AppReviewComments) => void;
  state: RepositoryState;
}) {
  const stateRef = useRef<RepositoryState | null>(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const comments = useAppReviewComments({
    isReviewActionDisabled: () => false,
    onCommentFileChange,
    stateRef,
  });
  onState(comments);
  return (
    <AskNotifications
      notifications={comments.askNotifications}
      onDismiss={comments.dismissAskNotification}
      onNavigate={onNavigate}
    />
  );
}

const renderAppReviewComments = async (state: RepositoryState) => {
  const onCommentFileChange = vi.fn();
  const onNavigate = vi.fn();
  const stateRef: { current: AppReviewComments | null } = { current: null };
  const getState = () => {
    if (!stateRef.current) {
      throw new Error('App review comments did not render.');
    }
    return stateRef.current;
  };
  const render = (nextState: RepositoryState) => (
    <AppReviewCommentsHarness
      onCommentFileChange={onCommentFileChange}
      onNavigate={onNavigate}
      onState={(comments) => (stateRef.current = comments)}
      state={nextState}
    />
  );
  const view = await renderReact(render(state));
  return {
    ...view,
    getState,
    onCommentFileChange,
    onNavigate,
    rerenderState: (nextState: RepositoryState) => view.rerender(render(nextState)),
  };
};

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  window.codiff = originalCodiff;
});

const savedReview = {
  ...pullRequestState,
  files: [createChangedFile(comment.filePath, { kind: 'pull-request' })],
  source: { ...pullRequestState.source, baseSha: 'base', headSha: 'first-head' },
};

test('reopening a PR restores Ask replies and an unsent draft, and continues the thread', async () => {
  const askReviewAssistant = vi.fn(async (_request: ReviewAssistantRequest) => ({
    reply: 'The service gate is off.',
    status: 'ready' as const,
  }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  const draft = 'Does the default service still run?';
  {
    await using view = await renderAppReviewComments(savedReview);
    await act(async () => view.getState().loadReviewComments(savedReview, [comment]));
    await act(async () => view.getState().askCodex(comment.id));
    await act(async () => view.getState().updateAskFollowUpDraft(comment.id, draft));
    expect(view.getState().activeReviewCommentDraftRef.current).toBeNull();
  }
  await using view = await renderAppReviewComments(savedReview);
  await act(async () => view.getState().loadReviewComments(savedReview));
  expect(view.getState().reviewComments[0]?.codexReply).toMatchObject({
    followUpDraft: draft,
    status: 'ready',
    turns: [{ question: comment.body, reply: 'The service gate is off.' }],
  });
  expect(askReviewAssistant).toHaveBeenCalledTimes(1);
  await act(async () => view.getState().askCodex(comment.id, draft));
  expect(askReviewAssistant).toHaveBeenLastCalledWith(
    expect.objectContaining({
      previousTurns: [{ question: comment.body, reply: 'The service gate is off.' }],
    }),
  );
  expect(readAskThreads(savedReview)[0]?.codexReply.followUpDraft).toBeUndefined();
});

test('an interrupted Ask is retryable after reopen and is never sent automatically', async () => {
  const askReviewAssistant = vi.fn(() => new Promise<ReviewAssistantResult>(() => {}));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  {
    await using view = await renderAppReviewComments(savedReview);
    await act(async () => view.getState().loadReviewComments(savedReview, [comment]));
    await act(async () => view.getState().askCodex(comment.id));
  }
  await using view = await renderAppReviewComments(savedReview);
  await act(async () => view.getState().loadReviewComments(savedReview));
  expect(view.getState().reviewComments[0]?.codexReply).toMatchObject({
    error: expect.stringContaining('interrupted'),
    question: comment.body,
    status: 'error',
  });
  expect(askReviewAssistant).toHaveBeenCalledTimes(1);
  await act(async () => view.getState().askCodex(comment.id));
  expect(askReviewAssistant).toHaveBeenCalledTimes(2);
});

test('an interrupted post is not restored as a pending comment and its Ask reply is retained', async () => {
  const askReviewAssistant = vi.fn(async () => ({
    reply: 'Saved answer.',
    status: 'ready' as const,
  }));
  const submitPullRequestComment = vi.fn(() => new Promise(() => {}));
  window.codiff = { askReviewAssistant, submitPullRequestComment } as unknown as Window['codiff'];
  {
    await using view = await renderAppReviewComments(savedReview);
    await act(async () => view.getState().loadReviewComments(savedReview, [comment]));
    await act(async () => view.getState().askCodex(comment.id));
    await act(async () => view.getState().submitPullRequestComment(comment.id));
  }
  await using view = await renderAppReviewComments(savedReview);
  await act(async () => view.getState().loadReviewComments(savedReview));
  expect(view.getState().hasPendingReviewComments).toBe(false);
  expect(view.getState().reviewComments).toEqual([]);
  expect(readAskThreads(savedReview)[0]).toMatchObject({
    codexReply: { body: 'Saved answer.' },
    posting: true,
  });
  expect(submitPullRequestComment).toHaveBeenCalledTimes(1);
});

test('changing PR commits keeps the old conversation off the diff; switching PRs clears it', async () => {
  const askReviewAssistant = vi.fn(async () => ({
    reply: 'Prior snapshot answer.',
    status: 'ready' as const,
  }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(savedReview);
  await act(async () => view.getState().loadReviewComments(savedReview, [comment]));
  await act(async () => view.getState().askCodex(comment.id));
  const changed = { ...savedReview, source: { ...savedReview.source, headSha: 'second-head' } };
  await view.rerenderState(changed);
  await act(async () => view.getState().loadReviewComments(changed));
  expect(view.getState().reviewComments).toEqual([]);
  expect(readAskThreads(changed)[0]?.codexReply.body).toBe('Prior snapshot answer.');
  await view.rerenderState(workingTreeState);
  await act(async () => view.getState().loadReviewComments(workingTreeState));
  expect(readAskThreads(changed)).toHaveLength(1);

  const another = {
    ...changed,
    source: { ...changed.source, number: 43, url: 'https://github.com/nkzw-tech/codiff/pull/43' },
  };
  await view.rerenderState(another);
  await act(async () => view.getState().loadReviewComments(another));
  expect(view.getState().reviewComments).toEqual([]);
  expect(readAskThreads(another)).toEqual([]);
  expect(readAskThreads(savedReview)).toEqual([]);
  expect(getReviewBriefQuestions(savedReview, []).questions).toEqual([]);
});

test('the re-review brief keeps submitted Ask questions after posting and isolates other PRs', async () => {
  const askReviewAssistant = vi.fn(async () => ({
    reply: 'An unverified conclusion.',
    status: 'ready' as const,
  }));
  const submitPullRequestComment = vi.fn(async () => ({
    ...comment,
    author: { login: 'reviewer' },
    id: 'posted-comment',
  }));
  window.codiff = { askReviewAssistant, submitPullRequestComment } as unknown as Window['codiff'];
  const state = {
    ...pullRequestState,
    source: { ...pullRequestState.source, headSha: 'earlier-head' },
  };
  await using view = await renderAppReviewComments(state);
  const { getState } = view;
  await act(async () => getState().setReviewComments([comment]));
  await act(async () => getState().askCodex(comment.id));
  await act(async () => getState().askCodex(comment.id, 'What happens when the gate is disabled?'));
  await act(async () => getState().submitPullRequestComment(comment.id));
  expect(getState().reviewComments[0]?.isReadOnly).toBe(true);
  expect(getState().reviewComments[0]?.codexReply).toBeUndefined();
  expect(readAskThreads(state)[0]).toMatchObject({
    archived: true,
    codexReply: { status: 'ready' },
  });

  const source = { ...state.source, headSha: 'current-head' };
  const { questions } = getReviewBriefQuestions({ ...state, source }, []);
  const markdown = buildReviewBrief(
    source,
    questions,
    [{ ...comment, resolved: false, url: `${source.url}#discussion-1` }],
    [],
  );
  expect(markdown).toContain('src/app.ts:4');
  expect(markdown.match(/“Review this”/g)).toHaveLength(1);
  expect(markdown).toContain('Ask · [Open PR thread]');
  expect(markdown).toContain('What happens when the gate is disabled?');
  expect(markdown).toContain('Asked at earlier-head');
  expect(markdown).not.toContain('An unverified conclusion.');
  expect(
    getReviewBriefQuestions({ ...state, source: { ...source, url: `${source.url}0` } }, [])
      .questions,
  ).toEqual([]);
});

test('app review comments request and store assistant replies', async () => {
  const context = {
    fileCount: 8,
    filesRead: 8,
    label: 'PR context',
    version: 'before → after',
    warnings: [],
  };
  const askReviewAssistant = vi.fn(async () => ({
    context,
    reply: 'Use the shared parser.',
    status: 'ready' as const,
  }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(workingTreeState);
  const { getState, onCommentFileChange } = view;

  await act(async () => {
    getState().setReviewComments([comment]);
  });
  await act(async () => {
    getState().askCodex(comment.id);
  });
  expect(askReviewAssistant).toHaveBeenCalledWith({
    comment: {
      body: comment.body,
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      sectionId: comment.sectionId,
      side: comment.side,
    },
    source: workingTreeState.source,
  });
  await waitFor(() => {
    expect(getState().reviewComments[0]?.codexReply).toMatchObject({
      body: 'Use the shared parser.',
      context,
      question: comment.body,
      reviewKey: expect.any(String),
      status: 'ready',
      turns: [{ context, question: comment.body, reply: 'Use the shared parser.' }],
    });
  });
  expect(onCommentFileChange).toHaveBeenCalledTimes(2);
});

test('follow-up requests retain the conversation without changing the original note or other threads', async () => {
  const askReviewAssistant = vi.fn(async (request: ReviewAssistantRequest) => ({
    reply: `Answer to: ${request.comment.body}`,
    status: 'ready' as const,
  }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const other = { ...comment, body: 'Another thread', id: 'comment-2' };
  await act(async () => view.getState().setReviewComments([comment, other]));
  await act(async () => view.getState().askCodex(comment.id));
  await act(async () => view.getState().askCodex(other.id));
  await act(async () => view.getState().askCodex(comment.id, '  Why that helper?  '));
  await act(async () => view.getState().askCodex(comment.id, 'And the caller?'));
  expect(askReviewAssistant.mock.calls[2][0]).toMatchObject({
    comment: { body: 'Why that helper?', filePath: comment.filePath, lineNumber: 4 },
    previousTurns: [{ question: comment.body, reply: `Answer to: ${comment.body}` }],
    source: pullRequestState.source,
  });
  expect(askReviewAssistant.mock.calls[3][0].previousTurns).toEqual([
    { question: comment.body, reply: `Answer to: ${comment.body}` },
    { question: 'Why that helper?', reply: 'Answer to: Why that helper?' },
  ]);
  expect(view.getState().reviewComments[0]).toMatchObject({
    body: comment.body,
    codexReply: {
      status: 'ready',
      turns: [
        { question: comment.body, reply: `Answer to: ${comment.body}` },
        { question: 'Why that helper?', reply: 'Answer to: Why that helper?' },
        { question: 'And the caller?', reply: 'Answer to: And the caller?' },
      ],
    },
  });
  expect(view.getState().reviewComments[1]?.codexReply?.turns).toHaveLength(1);
});

test('parallel Ask threads notify in completion order and each notice expires independently', async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<ReviewAssistantResult>();
  const second = Promise.withResolvers<ReviewAssistantResult>();
  const other = { ...comment, body: 'Which path uses the helper?', id: 'comment-2', lineNumber: 8 };
  const askReviewAssistant = vi.fn((request: ReviewAssistantRequest) =>
    request.comment.body === comment.body ? first.promise : second.promise,
  );
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;
  const notices = () =>
    [...view.container.querySelectorAll('.ask-notice')].map((notice) => ({
      file: notice.querySelector('.ask-notice-heading span')?.textContent,
      question: notice.querySelector('.ask-notice-question')?.textContent,
      title: notice.querySelector('strong')?.textContent,
    }));
  await act(async () => getState().setReviewComments([comment, other]));
  await act(async () => {
    getState().askCodex(comment.id);
    getState().askCodex(other.id);
    getState().askCodex(other.id);
  });
  expect(askReviewAssistant.mock.calls.map(([request]) => request.comment.body)).toEqual([
    comment.body,
    other.body,
  ]);
  expect(notices()).toEqual([]);

  await act(async () => second.resolve({ reply: 'Use the helper.', status: 'ready' }));
  const ready = { file: 'src/app.ts:8', question: other.body, title: 'Ask reply ready' };
  expect(notices()).toEqual([ready]);
  expect(getState().reviewComments[0]?.codexReply?.status).toBe('loading');
  expect(getState().reviewComments[1]?.codexReply?.body).toBe('Use the helper.');

  await act(async () => vi.advanceTimersByTime(4000));
  await act(async () => first.reject(new Error('Connection failed')));
  const failed = { file: 'src/app.ts:4', question: comment.body, title: 'Ask failed' };
  expect(notices()).toEqual([failed, ready]);
  expect(getState().reviewComments[0]?.codexReply?.error).toBe('Connection failed');
  await act(async () => vi.advanceTimersByTime(4000));
  expect(notices()).toEqual([failed]);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(notices()).toEqual([]);
  expect(getState().reviewComments[1]?.codexReply?.body).toBe('Use the helper.');
});

test('a focused Ask notice stays available and can open the original anchor', async () => {
  vi.useFakeTimers();
  const askReviewAssistant = vi.fn(async () => ({ reply: 'Use the helper.', status: 'ready' }));
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  await act(async () => view.getState().setReviewComments([comment]));
  await act(async () => view.getState().askCodex(comment.id));
  const notice = view.container.querySelector<HTMLButtonElement>('.ask-notice');
  expect(notice?.title).toBe('Jump to src/app.ts:4');
  await act(async () => notice?.focus());
  await act(async () => vi.advanceTimersByTime(8000));
  expect(notice?.isConnected).toBe(true);
  await act(async () => notice?.click());
  expect(view.onNavigate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      sectionId: comment.sectionId,
      side: comment.side,
    }),
  );
  expect(view.container.querySelector('.ask-notice')).toBeNull();
});

test('failed follow-ups retain earlier answers and the question, and retry adds only one exchange', async () => {
  const pending = Promise.withResolvers<ReviewAssistantResult>();
  const askReviewAssistant = vi
    .fn()
    .mockResolvedValueOnce({ reply: 'First answer', status: 'ready' })
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce({ reply: 'Second answer', status: 'ready' });
  window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  await act(async () => view.getState().setReviewComments([comment]));
  await act(async () => view.getState().askCodex(comment.id));
  await act(async () => {
    view.getState().askCodex(comment.id, 'Why?');
    view.getState().askCodex(comment.id, 'Why?');
  });
  expect(askReviewAssistant).toHaveBeenCalledTimes(2);
  expect(view.getState().reviewComments[0]?.codexReply).toMatchObject({
    body: 'First answer',
    status: 'loading',
    turns: [{ question: comment.body, reply: 'First answer' }],
  });
  await act(async () => pending.resolve({ reason: 'Connection failed', status: 'unavailable' }));
  expect(view.getState().askNotifications[0]).toMatchObject({ question: 'Why?', status: 'error' });
  expect(view.getState().reviewComments[0]?.codexReply).toMatchObject({
    error: 'Connection failed',
    question: 'Why?',
    status: 'error',
    turns: [{ question: comment.body, reply: 'First answer' }],
  });
  await act(async () => view.getState().askCodex(comment.id, 'Why?'));
  expect(view.getState().askNotifications[0]).toMatchObject({ question: 'Why?', status: 'ready' });
  expect(view.getState().reviewComments[0]?.codexReply?.turns).toEqual([
    { question: comment.body, reply: 'First answer' },
    { question: 'Why?', reply: 'Second answer' },
  ]);
});

test.each(['commits', 'question'])(
  'follow-ups reject changed %s and Ask starts a fresh conversation',
  async (change) => {
    const askReviewAssistant = vi.fn(async () => ({
      reply: 'An answer',
      status: 'ready' as const,
    }));
    window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
    await using view = await renderAppReviewComments(pullRequestState);
    await act(async () => view.getState().setReviewComments([comment]));
    await act(async () => view.getState().askCodex(comment.id));
    if (change === 'commits') {
      await view.rerenderState({
        ...pullRequestState,
        source: { ...pullRequestState.source, headSha: 'new-version' },
      });
    } else {
      await act(async () => view.getState().updateComment(comment.id, 'Edited original note'));
    }
    await act(async () => view.getState().askCodex(comment.id, 'More detail?'));
    expect(askReviewAssistant).toHaveBeenCalledTimes(1);
    expect(view.getState().reviewComments[0]?.codexReply).toMatchObject({
      error: expect.stringContaining('start a new conversation'),
      status: 'error',
    });
    expect(view.getState().reviewComments[0]?.codexReply?.turns).toHaveLength(1);
    await act(async () => view.getState().askCodex(comment.id));
    expect(askReviewAssistant).toHaveBeenCalledTimes(2);
    expect(view.getState().reviewComments[0]?.codexReply?.turns).toHaveLength(1);
  },
);

test.each(['commits', 'question', 'draft', 'review', 'hydration'])(
  'assistant replies respect in-flight %s changes and prevent duplicate requests',
  async (change) => {
    const pending = Promise.withResolvers<ReviewAssistantResult>();
    const askReviewAssistant = vi.fn(() => pending.promise);
    window.codiff = { askReviewAssistant } as unknown as Window['codiff'];
    const initial: RepositoryState = {
      ...pullRequestState,
      source: { ...pullRequestState.source, baseSha: 'before', headSha: 'after' },
    };
    await using view = await renderAppReviewComments(initial);
    await act(async () => view.getState().setReviewComments([comment]));
    await act(async () => {
      view.getState().askCodex(comment.id);
      view.getState().askCodex(comment.id);
    });
    expect(askReviewAssistant).toHaveBeenCalledTimes(1);
    if (change === 'question') {
      await act(async () => view.getState().updateComment(comment.id, 'A different question'));
    } else if (change === 'draft') {
      await act(async () =>
        view.getState().updateActiveReviewCommentDraft({
          body: 'Still editing a different question',
          id: comment.id,
        }),
      );
    } else {
      await view.rerenderState({
        ...initial,
        ...(change === 'hydration'
          ? {
              files: [
                {
                  fingerprint: 'loaded',
                  oldPath: undefined,
                  path: 'src/app.ts',
                  sections: [],
                  status: 'modified',
                },
              ],
            }
          : {}),
        source: {
          ...initial.source,
          ...(change === 'commits' ? { headSha: 'new-after' } : {}),
          ...(change === 'review'
            ? { number: 43, url: 'https://github.com/nkzw-tech/codiff/pull/43' }
            : {}),
        },
      });
    }
    await act(async () => pending.resolve({ reply: 'Previous answer', status: 'ready' }));
    const reply = view.getState().reviewComments[0]?.codexReply;
    if (change === 'hydration') {
      expect(reply).toMatchObject({ body: 'Previous answer', status: 'ready' });
    } else if (change === 'review') {
      expect(reply?.body).toBeUndefined();
    } else {
      expect(reply).toMatchObject({ error: expect.stringContaining('Ask again'), status: 'error' });
      expect(reply?.body).toBeUndefined();
    }
    expect(view.getState().askNotifications).toHaveLength(change === 'hydration' ? 1 : 0);
  },
);

test('app review comments submit a draft and replace it with the remote comment', async () => {
  const submitPullRequestComment = vi.fn(async () => ({
    author: {
      login: 'reviewer',
      name: 'Reviewer',
    },
    body: comment.body,
    filePath: comment.filePath,
    id: 'remote-comment',
    lineNumber: comment.lineNumber,
    side: comment.side,
    submittedAt: '2026-07-15T00:00:00.000Z',
    url: 'https://github.com/nkzw-tech/codiff/pull/42#discussion_r1',
  }));
  window.codiff = { submitPullRequestComment } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState, onCommentFileChange } = view;

  await act(async () => {
    getState().setReviewComments([comment]);
  });
  await act(async () => {
    getState().submitPullRequestComment(comment.id);
  });
  expect(submitPullRequestComment).toHaveBeenCalledWith({
    comment: {
      body: comment.body,
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      side: comment.side,
    },
    source: pullRequestState.source,
  });
  await waitFor(() => {
    expect(getState().reviewComments).toEqual([
      {
        author: {
          login: 'reviewer',
          name: 'Reviewer',
        },
        body: comment.body,
        filePath: comment.filePath,
        id: 'remote-comment',
        isReadOnly: true,
        lineNumber: comment.lineNumber,
        sectionId: comment.sectionId,
        side: comment.side,
        submittedAt: '2026-07-15T00:00:00.000Z',
        url: 'https://github.com/nkzw-tech/codiff/pull/42#discussion_r1',
      },
    ]);
  });
  expect(onCommentFileChange).toHaveBeenCalledTimes(2);
});

test('app review comments submit and clear pending review drafts', async () => {
  const submitPullRequestReview = vi.fn(async () => {});
  window.codiff = { submitPullRequestReview } as unknown as Window['codiff'];
  await using view = await renderAppReviewComments(pullRequestState);
  const { getState } = view;

  await act(async () => {
    getState().setReviewComments([comment]);
  });
  await act(async () => {
    await getState().submitPullRequestReview('COMMENT');
  });
  expect(submitPullRequestReview).toHaveBeenCalledWith({
    comments: [
      {
        body: comment.body,
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        side: comment.side,
      },
    ],
    event: 'COMMENT',
    source: pullRequestState.source,
  });
  expect(getState().reviewComments).toEqual([]);
  expect(getState().pullRequestReviewSubmitting).toBeNull();
});
