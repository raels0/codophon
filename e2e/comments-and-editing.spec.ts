import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Codophon, expect, test } from './harness.ts';

const before = 'export const add = (a: number, b: number) => a + b;\n';
const after = `${before}export const sub = (a: number, b: number) => a - b;\n`;

test('a reviewer comments on a line and copies the comments as Markdown', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await app.startCommentOnLine('math.ts', 2);
    await app.page.keyboard.type('Should sub guard against NaN?');
    await expect(
      app.page.getByRole('button', { name: 'Copy review comments as markdown, no comments yet' }),
    ).toBeDisabled();
    await app.page.keyboard.press('ControlOrMeta+Enter');
    await app.page.getByRole('button', { name: 'Copy 1 review comment' }).click();
    await expect
      .poll(() => app.clipboard())
      .toMatch(/math\.ts[\s\S]*Should sub guard against NaN\?/);
  } finally {
    await app.close();
  }
});

test('an author edits a changed file in place and the edit lands on disk', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    const edit = app.page.getByRole('button', { name: 'Edit math.ts' });
    await expect(edit).toHaveAttribute('title', /Edit this file in place \(.+E\)/);
    await app.editFile('math.ts');
    await expect(app.file('math.ts').getByRole('status')).toHaveText('Editing');

    await app.page.keyboard.press('End');
    await app.page.keyboard.type(' // subtraction');
    await app.page.getByRole('button', { name: 'Done editing math.ts' }).click();

    await expect
      .poll(() => readFileSync(join(repo.path, 'math.ts'), 'utf8'))
      .toContain('a - b; // subtraction');
    await expect(app.file('math.ts').getByRole('status')).toHaveCount(0);
    await expect.poll(() => app.diffText()).toContain('// subtraction');
  } finally {
    await app.close();
  }
});
