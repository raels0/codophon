import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Codophon, expect, Repo, test } from './harness.ts';

const before = 'export const add = (a: number, b: number) => a + b;\n';
const after = `${before}export const sub = (a: number, b: number) => a - b;\n`;

/** A GitHub pull request: `server` answers git fetches over a fake ssh; fake `gh` serves the API. */
const createPullRequest = (workspace: string, repo: Repo) => {
  const server = new Repo(join(workspace, 'server'));
  mkdirSync(server.path);
  server.git('init', '-q', '-b', 'main');
  const base = server.commit('init', { 'math.ts': before });
  server.git('checkout', '-q', '-b', 'feature');
  const head = server.commit('Add sub', { 'math.ts': after });
  server.git('update-ref', 'refs/pull/12/head', head);
  server.git('checkout', '-q', 'main');

  repo.git('remote', 'add', 'origin', 'git@github.com:acme/widget.git');
  repo.git('fetch', '-q', server.path, 'main');
  repo.git('checkout', '-q', 'FETCH_HEAD');

  const state = join(workspace, 'gh-state.json');
  const log = join(workspace, 'gh-calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(
    state,
    JSON.stringify({
      comments: [
        {
          body: 'Should this handle NaN?',
          commit_id: head,
          created_at: '2026-01-01T00:00:00Z',
          diff_hunk: '@@ -1 +1,2 @@',
          html_url: 'https://github.com/acme/widget/pull/12#discussion_r1',
          id: 1,
          line: 2,
          original_line: 2,
          path: 'math.ts',
          side: 'RIGHT',
          user: { login: 'grace' },
        },
      ],
      files: [
        {
          additions: 1,
          deletions: 0,
          filename: 'math.ts',
          patch:
            '@@ -1 +1,2 @@\n export const add = (a: number, b: number) => a + b;\n+export const sub = (a: number, b: number) => a - b;',
          status: 'modified',
        },
      ],
      pullRequest: {
        base: { ref: 'main', repo: { full_name: 'acme/widget' }, sha: base },
        body: 'Adds a subtraction helper.',
        draft: false,
        head: { ref: 'feature', repo: { full_name: 'acme/widget' }, sha: head },
        html_url: 'https://github.com/acme/widget/pull/12',
        number: 12,
        state: 'open',
        title: 'Add a sub helper',
        user: { login: 'grace' },
      },
    }),
  );
  return {
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { endpoint: string; input: string; method: string }),
    env: {
      CODOPHON_GH_PATH: resolve('e2e/fake-gh.mjs'),
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
      FAKE_GIT_REMOTE: server.path,
      GIT_SSH_COMMAND: resolve('e2e/fake-ssh.sh'),
    },
  };
};

test('reviewing a GitHub PR: read it, comment on a line, and request changes', async ({
  home,
  repo,
  workspace,
}) => {
  const pullRequest = createPullRequest(workspace, repo);
  const app = await Codophon.launch(
    home,
    {
      repositoryPath: repo.path,
      source: { type: 'pull-request', url: 'https://github.com/acme/widget/pull/12' },
    },
    pullRequest.env,
  );
  try {
    await expect(app.page.getByText('Add a sub helper').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => app.diffText()).toContain('export const sub');
    await expect(app.page.getByText('Should this handle NaN?')).toBeVisible();

    await app.startCommentOnLine('math.ts', 2);
    await app.page.keyboard.type('It returns NaN like add does.');
    await app.page.getByRole('button', { name: 'Post comment' }).click();
    await expect
      .poll(() =>
        pullRequest
          .calls()
          .find((call) => call.method === 'POST' && call.endpoint.endsWith('/comments')),
      )
      .toBeTruthy();
    expect(
      pullRequest
        .calls()
        .find((call) => call.method === 'POST' && call.endpoint.endsWith('/comments'))!.input,
    ).toContain('It returns NaN like add does.');

    await app.page.getByRole('button', { exact: true, name: 'Request changes' }).first().click();
    await expect
      .poll(() =>
        pullRequest
          .calls()
          .find((call) => call.method === 'POST' && call.endpoint.endsWith('/reviews')),
      )
      .toBeTruthy();
    expect(
      JSON.parse(
        pullRequest
          .calls()
          .find((call) => call.method === 'POST' && call.endpoint.endsWith('/reviews'))!.input,
      ),
    ).toMatchObject({ event: 'REQUEST_CHANGES' });
  } finally {
    await app.close();
  }
});
