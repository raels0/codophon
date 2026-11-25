import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefinitionNavigationRepository } from '../core/__tests__/helpers/definition-navigation/create-repository.mjs';
import { Codophon, expect, test, useFakeAgent } from './harness.ts';

const before = 'export const add = (a: number, b: number) => a + b;\n';
const after = `${before}export const sub = (a: number, b: number) => a - b;\n`;

test('Mod-clicking an identifier jumps to its definition inside the diff', async ({
  home,
  workspace,
}) => {
  const path = createDefinitionNavigationRepository(join(workspace, 'definitions'));
  const app = await Codophon.launch(home, { repositoryPath: path });
  try {
    const main = app.page.locator('diffs-container').nth(await app.fileIndex('src/main.ts'));
    const identifier = main.getByText('formatGreeting', { exact: true }).last();
    await identifier.click({ modifiers: ['ControlOrMeta'] });
    const results = app.page.getByRole('dialog', { name: 'Definitions for formatGreeting' });
    await expect(results.getByRole('button', { name: /src\/greeting\.ts:1/ })).toBeVisible();
    await results.getByRole('button', { name: /src\/greeting\.ts:1/ }).click();
    await expect(app.file('greeting.ts')).toBeInViewport();
  } finally {
    await app.close();
  }
});

test('choosing a commit in History reviews that commit', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before });
  repo.commit('Add sub', { 'math.ts': after });
  repo.commit('Add docs', { 'README.md': '# Math\n' });
  repo.write({ 'wip.txt': 'not committed\n' });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await app.page.getByRole('tab', { name: 'History' }).click();
    await app.page.getByRole('button', { name: /Add sub Ada/ }).click();
    await expect(app.file('math.ts')).toBeVisible();
    await expect.poll(() => app.diffText()).toContain('export const sub');
    await expect(app.file('README.md')).toHaveCount(0);
    await expect(app.file('wip.txt')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('reverting an in-place edit restores the file on disk', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await app.editFile('math.ts');
    await app.page.keyboard.press('End');
    await app.page.keyboard.type(' // oops');
    await expect.poll(() => readFile(join(repo.path, 'math.ts'))).toContain('// oops');
    await app.page.getByRole('button', { name: 'Revert edits to math.ts' }).click();
    await expect.poll(() => readFile(join(repo.path, 'math.ts'))).toBe(after);
  } finally {
    await app.close();
  }
});

test('the keyboard shortcuts dialog lists the configured shortcuts', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });
  mkdirSync(join(home, '.codophon'), { recursive: true });
  writeFileSync(
    join(home, '.codophon/codophon.jsonc'),
    JSON.stringify({ keymap: { editFile: 'Alt+e' } }),
  );

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await app.page.keyboard.press('ControlOrMeta+Shift+P');
    await app.page.keyboard.type('Keyboard Shortcuts');
    await app.page.keyboard.press('Enter');
    const dialog = app.page.getByRole('dialog', { name: /Keyboard shortcuts/i });
    await expect(dialog.getByText('Edit highlighted file')).toBeVisible();
    await expect(dialog).toContainText(/Alt|⌥/);
  } finally {
    await app.close();
  }
});

test('a missing agent CLI shows how to recover instead of a walkthrough', async ({
  home,
  repo,
  workspace,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });
  const agent = useFakeAgent(home);

  const app = await Codophon.launch(
    home,
    { repositoryPath: repo.path, walkthrough: true },
    { ...agent.env, CODOPHON_CLAUDE_PATH: join(workspace, 'missing/claude') },
  );
  try {
    await expect(app.page.getByText('Claude Code CLI not found')).toBeVisible({ timeout: 20_000 });
    await app.page.getByRole('tab', { name: 'Tree' }).click();
    await expect.poll(() => app.diffText()).toContain('export const sub');
  } finally {
    await app.close();
  }
});

test('opening a pre-authored walkthrough file shows its chapters', async ({
  home,
  repo,
  workspace,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });
  const walkthroughFile = join(workspace, 'walkthrough.json');
  writeFileSync(
    walkthroughFile,
    JSON.stringify({
      chapters: [
        {
          blurb: 'Adds subtraction.',
          icon: 'wrench',
          id: 'c1',
          stops: [
            {
              hunkIds: ['math.ts:unstaged:h1'],
              id: 's1',
              importance: 'normal',
              prose: 'Sub mirrors add.',
            },
          ],
          title: 'Authored chapter',
        },
      ],
      focus: 'math',
      kind: 'narrative',
      title: 'Authored walkthrough',
      version: 4,
    }),
  );

  const app = await Codophon.launch(home, { repositoryPath: repo.path, walkthroughFile });
  try {
    await expect(app.page.getByText('Authored chapter').first()).toBeVisible({ timeout: 20_000 });
    await expect(app.page.getByText('Sub mirrors add.').first()).toBeVisible();
  } finally {
    await app.close();
  }
});

const readFile = (path: string) =>
  import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'));
