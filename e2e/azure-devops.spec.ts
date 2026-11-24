import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Codophon, expect, Repo, test } from './harness.ts';

const before = 'export const add = (a: number, b: number) => a + b;\n';
const after = `${before}export const sub = (a: number, b: number) => a - b;\n`;
const pullRequestUrl = 'https://dev.azure.com/acme/web/_git/widget/pullrequest/7';

/**
 * A pull request on a fake Azure DevOps server: `server` holds the PR commits and answers git
 * fetches over a fake ssh, and fake `az` serves the PR metadata and threads.
 */
const createPullRequest = (workspace: string, repo: Repo) => {
  const server = new Repo(join(workspace, 'server'));
  mkdirSync(server.path);
  server.git('init', '-q', '-b', 'main');
  const base = server.commit('init', { 'math.ts': before });
  server.git('checkout', '-q', '-b', 'feature');
  const head = server.commit('Add sub', { 'math.ts': after });

  repo.git('remote', 'add', 'origin', 'git@ssh.dev.azure.com:v3/acme/web/widget');
  repo.git('fetch', '-q', server.path, 'main');
  repo.git('checkout', '-q', 'FETCH_HEAD');

  const state = join(workspace, 'az-state.json');
  const log = join(workspace, 'az-calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(
    state,
    JSON.stringify({
      pullRequest: {
        createdBy: { displayName: 'Grace' },
        description: 'Adds a subtraction helper.',
        isDraft: false,
        lastMergeSourceCommit: { commitId: head },
        lastMergeTargetCommit: { commitId: base },
        pullRequestId: 7,
        sourceRefName: 'refs/heads/feature',
        status: 'active',
        targetRefName: 'refs/heads/main',
        title: 'Add a sub helper',
      },
      threads: [
        {
          comments: [
            {
              author: { displayName: 'Grace' },
              commentType: 1,
              content: 'Is sub exported on purpose?',
              id: 1,
              publishedDate: '2026-01-01T00:00:00Z',
            },
          ],
          id: 5,
          status: 'active',
          threadContext: {
            filePath: '/math.ts',
            rightFileEnd: { line: 2, offset: 1 },
            rightFileStart: { line: 2, offset: 1 },
          },
        },
      ],
    }),
  );
  return {
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { body: string; method: string; uri: string }),
    env: {
      CODIFF_AZ_PATH: resolve('e2e/fake-az.mjs'),
      FAKE_AZ_LOG: log,
      FAKE_AZ_STATE: state,
      FAKE_GIT_REMOTE: server.path,
      GIT_SSH_COMMAND: resolve('e2e/fake-ssh.sh'),
    },
  };
};

test('reviewing an Azure DevOps PR: read it, reply to a thread, and approve', async ({
  home,
  repo,
  workspace,
}) => {
  const pullRequest = createPullRequest(workspace, repo);
  const app = await Codophon.launch(
    home,
    { repositoryPath: repo.path, source: { type: 'pull-request', url: pullRequestUrl } },
    pullRequest.env,
  );
  try {
    await expect(app.page.getByText('Add a sub helper').first()).toBeVisible({ timeout: 20_000 });
    await expect(app.page.getByText('Adds a subtraction helper.').first()).toBeVisible();
    await expect.poll(() => app.diffText()).toContain('export const sub');
    await expect(app.page.getByText('Is sub exported on purpose?')).toBeVisible();

    await app.page.getByRole('button', { name: 'Reply' }).click();
    await app.page.keyboard.type('Yes, callers need it.');
    await app.page.getByRole('button', { name: 'Post comment' }).click();
    await expect
      .poll(() => pullRequest.calls().find((call) => call.uri.includes('/threads/5/comments')))
      .toMatchObject({ method: 'POST' });
    expect(
      JSON.parse(
        pullRequest.calls().find((call) => call.uri.includes('/threads/5/comments'))!.body,
      ),
    ).toMatchObject({ content: 'Yes, callers need it.' });

    await app.page.getByRole('button', { name: 'Approve review' }).click();
    await expect
      .poll(() => pullRequest.calls().find((call) => call.method === 'PUT'))
      .toMatchObject({ uri: expect.stringContaining('/reviewers/user-1') });
    expect(
      JSON.parse(pullRequest.calls().find((call) => call.method === 'PUT')!.body),
    ).toMatchObject({
      vote: 10,
    });
  } finally {
    await app.close();
  }
});
