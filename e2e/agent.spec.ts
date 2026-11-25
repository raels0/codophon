import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Codophon, expect, test, useFakeAgent } from './harness.ts';

const before = 'export const add = (a: number, b: number) => a + b;\n';
const after = `${before}export const sub = (a: number, b: number) => a - b;\n`;

test('a walkthrough explains the change with a diagram and jumps to its code', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });
  const agent = useFakeAgent(home);

  const app = await Codophon.launch(
    home,
    { repositoryPath: repo.path, walkthrough: true },
    agent.env,
  );
  try {
    await expect(app.page.getByText('Math helpers').first()).toBeVisible({ timeout: 20_000 });
    await expect(app.page.getByText('The new sub helper mirrors add.').first()).toBeVisible();
    await expect(app.page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({
      timeout: 15_000,
    });
    await app.page.getByText('A sub helper').first().click();
    await expect.poll(() => app.diffText()).toContain('export const sub');
    const [call] = agent.calls();
    expect(call.args).toContain('--json-schema');
    expect(call.prompt).toContain('export const sub');
  } finally {
    await app.close();
  }
});

test('committing from a walkthrough shows a failing hook, then lands the drafted message', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });
  const failMarker = join(repo.path, '.git', 'lint-fail');
  writeFileSync(failMarker, '');
  const hook = join(repo.path, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hook,
    '#!/bin/sh\necho "lint: checking math.ts"\n[ -e .git/lint-fail ] && echo "lint: sub needs tests" >&2 && exit 1\nexit 0\n',
  );
  chmodSync(hook, 0o755);
  const agent = useFakeAgent(home);

  const app = await Codophon.launch(
    home,
    { repositoryPath: repo.path, walkthrough: true },
    agent.env,
  );
  try {
    await expect(app.page.getByText('Math helpers').first()).toBeVisible({ timeout: 20_000 });
    await app.page.getByTitle('Commit the staged change').click();
    await expect(app.page.getByPlaceholder('Summarize the change in one line…')).toHaveValue(
      'Add subtraction helper',
    );
    const commit = app.page.getByRole('button', { exact: true, name: 'Commit' });

    await commit.click();
    await expect(app.page.getByText('lint: sub needs tests')).toBeVisible();
    await expect(app.page.getByText('The commit failed — see the output above.')).toBeVisible();
    expect(repo.git('rev-list', '--count', 'HEAD').trim()).toBe('1');

    rmSync(failMarker);
    await app.page.getByRole('button', { name: 'Dismiss commit error' }).click();
    await commit.click();
    await expect(app.page.getByRole('button', { name: 'Committed' })).toBeVisible();
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe(
      'Add subtraction helper\n\nAdds sub next to add.',
    );
  } finally {
    await app.close();
  }
});

test('asking about a line gets an answer, and a follow-up carries the conversation', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });
  const agent = useFakeAgent(home);

  const app = await Codophon.launch(home, { repositoryPath: repo.path }, agent.env);
  try {
    await app.startCommentOnLine('math.ts', 2);
    await app.page.keyboard.type('Does sub handle NaN?');
    await app.page.getByRole('button', { name: 'Ask' }).click();
    await expect(app.page.getByText('Yes: NaN propagates through subtraction.')).toBeVisible({
      timeout: 20_000,
    });

    await app.page.getByRole('textbox', { name: /follow-up/i }).click();
    await app.page.keyboard.type('What about Infinity?');
    await app.page.keyboard.press('ControlOrMeta+Enter');
    await expect(app.page.getByText('Infinity minus Infinity is NaN too.')).toBeVisible({
      timeout: 20_000,
    });
    const followUp = agent.calls().at(-1)!;
    expect(followUp.prompt).toContain('Does sub handle NaN?');
    expect(followUp.prompt).toContain('Yes: NaN propagates through subtraction.');
  } finally {
    await app.close();
  }
});
