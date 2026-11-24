import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Codophon, expect, test } from './harness.ts';

test('the command palette runs commands and the setting persists to config', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': 'export const add = 1;\n' });
  repo.write({ 'math.ts': 'export const add = 2;\n' });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await app.page.keyboard.press('ControlOrMeta+k');
    await app.page.keyboard.type('word wrap');
    await app.page.keyboard.press('Enter');
    await expect
      .poll(() => readFileSync(join(home, '.codiff/codiff.jsonc'), 'utf8'))
      .toMatch(/"wordWrap":\s*true/);
  } finally {
    await app.close();
  }
});

test('Markdown changes render as a document with inline word changes', async ({ home, repo }) => {
  repo.commit('init', { 'docs/flow.md': '# Flow\n\nOld text.\n' });
  repo.write({ 'docs/flow.md': '# Flow\n\nNew text.\n\n## Next steps\n' });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await expect(app.page.getByRole('heading', { name: 'Flow' })).toBeVisible();
    await expect(app.page.getByRole('deletion').filter({ hasText: 'Old' })).toBeVisible();
    await expect(app.page.getByRole('insertion').filter({ hasText: 'New' })).toBeVisible();
    await expect(app.page.getByRole('heading', { name: 'Next steps' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('reviewing a branch against main includes its commits and uncommitted work', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': 'export const add = 1;\n' });
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit('feature work', { 'feature.ts': 'export const feature = true;\n' });
  repo.write({ 'wip.ts': 'export const wip = true;\n' });

  const app = await Codophon.launch(home, {
    repositoryPath: repo.path,
    source: { ref: 'main', type: 'branch-working-tree' },
  });
  try {
    await expect(app.treeRow('feature.ts')).toBeVisible();
    await expect(app.treeRow('wip.ts')).toBeVisible();
    await expect(app.treeRow('math.ts')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
