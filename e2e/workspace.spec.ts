import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Codophon, expect, test } from './harness.ts';

test('the command palette runs commands and the setting persists to config', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': 'export const add = 1;\n' });
  repo.write({ 'math.ts': 'export const add = 2;\n' });

  const previousDir = join(home, '.codiff');
  mkdirSync(previousDir);
  const previousConfig = '{ "settings": { "codeFontSize": 19 } }';
  const previousPath = join(previousDir, 'codiff.jsonc');
  writeFileSync(previousPath, previousConfig);
  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    expect(readFileSync(previousPath, 'utf8')).toBe(previousConfig);
    expect(readFileSync(join(home, '.codophon/codophon.jsonc'), 'utf8')).toMatch(
      /"codeFontSize":\s*19/,
    );
    await app.page.keyboard.press('ControlOrMeta+k');
    await app.page.keyboard.type('word wrap');
    await app.page.keyboard.press('Enter');
    await expect
      .poll(() => readFileSync(join(home, '.codophon/codophon.jsonc'), 'utf8'))
      .toMatch(/"wordWrap":\s*true/);
  } finally {
    await app.close();
  }
});

test('changed words and file cards keep their colors in light and dark appearance', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': 'export const total = add(1, 2);\n' });
  repo.write({ 'math.ts': 'export const total = add(1, 3);\n' });

  const background = (selector: string) =>
    app.page
      .locator(selector)
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    for (const theme of ['light', 'dark'] as const) {
      await app.app.evaluate(
        ({ nativeTheme }, source) => (nativeTheme.themeSource = source),
        theme,
      );
      await expect(app.page.locator('[data-line-type="change-addition"]').first()).toBeVisible();
      // A themed color that fails to resolve renders as transparent.
      for (const selector of [
        '[data-line-type="change-addition"] [data-diff-span]',
        '[data-line-type="change-deletion"] [data-diff-span]',
        '.codophon-file-header',
      ]) {
        await expect.poll(() => background(selector)).not.toBe('rgba(0, 0, 0, 0)');
      }
    }
  } finally {
    await app.close();
  }
});

test('Markdown changes render as a document with inline word changes', async ({ home, repo }) => {
  repo.commit('init', { 'docs/flow.md': '# Flow\n\nOld text.\n' });
  repo.write({
    'docs/flow.md':
      '# Flow\n\nNew text.\n\n## Next steps\n\n```mermaid\nflowchart LR\n  A --> B\n```\n',
  });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await expect(app.page.getByRole('heading', { name: 'Flow' })).toBeVisible();
    await expect(app.page.getByRole('deletion').filter({ hasText: 'Old' })).toBeVisible();
    await expect(app.page.getByRole('insertion').filter({ hasText: 'New' })).toBeVisible();
    await expect(app.page.getByRole('heading', { name: 'Next steps' })).toBeVisible();
    const diagram = app.page.getByRole('img', { name: 'Mermaid diagram' });
    await expect(diagram).toBeVisible();
    await expect
      .poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
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

test('a reviewer can find a definition from its use in a changed line', async ({ home, repo }) => {
  repo.commit('init', {
    'helpers.ts': 'export function computeTotal() { return 2; }\n',
    'view.ts': 'export const total = 1;\n',
  });
  repo.write({
    'view.ts': "import { computeTotal } from './helpers';\nexport const total = computeTotal();\n",
  });
  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    const usage = app.page
      .locator('diffs-container [data-line="2"][data-line-type="change-addition"]')
      .getByText('computeTotal', { exact: true });
    await usage.click({ modifiers: ['ControlOrMeta'] });
    const results = app.page.getByRole('dialog', { name: 'Definitions for computeTotal' });
    await expect(results.getByRole('button', { name: /helpers\.ts:1/ })).toBeVisible();
  } finally {
    await app.close();
  }
});
