import { Codophon, expect, test } from './harness.ts';

const before = 'export const add = (a: number, b: number) => a + b;\n';
const after = `${before}export const sub = (a: number, b: number) => a - b;\n`;

test('reviewing local changes shows every changed file and its diff', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before, 'old-name.ts': 'export {};\n', 'remove-me.txt': 'x\n' });
  repo.write({ 'math.ts': after, 'notes.txt': 'new file\n', 'remove-me.txt': null });
  repo.git('mv', 'old-name.ts', 'new-name.ts');

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    for (const [path, status] of [
      ['math.ts', 'modified'],
      ['notes.txt', 'untracked'],
      ['remove-me.txt', 'deleted'],
      ['new-name.ts', 'renamed'],
    ]) {
      await expect(app.treeRow(path)).toHaveAttribute('data-item-git-status', status);
    }
    await expect.poll(() => app.diffText()).toContain('export const sub');
    await expect.poll(() => app.diffText()).toContain('new file');
  } finally {
    await app.close();
  }
});

test('marking a file viewed survives a relaunch', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });

  let app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await app.viewedToggle('math.ts').click();
    await expect(app.viewedToggle('math.ts')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close();
  }

  app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await expect(app.viewedToggle('math.ts')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close();
  }
});

test('edits made on disk while reviewing show up after refreshing', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before });
  repo.write({ 'math.ts': after });

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    await expect.poll(() => app.diffText()).toContain('export const sub');
    repo.write({ 'math.ts': `${after}export const mul = (a: number, b: number) => a * b;\n` });
    // Codophon re-checks the repository when its window regains focus, as when a user switches
    // back from their editor. (Without focus it polls every 30s.)
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('focus'));
    await expect(app.page.locator('.repository-change-banner')).toHaveClass(/\bvisible\b/);
    expect(await app.diffText()).not.toContain('export const mul');
    await app.page.getByRole('button', { name: 'refresh to see them.' }).click();
    await expect.poll(() => app.diffText()).toContain('export const mul');
  } finally {
    await app.close();
  }
});

test('reviewing a commit shows only that commit', async ({ home, repo }) => {
  repo.commit('init', { 'math.ts': before });
  const sha = repo.commit('add sub', { 'docs.md': '# Docs\n', 'math.ts': after });
  repo.write({ 'uncommitted.txt': 'not part of the commit\n' });

  const app = await Codophon.launch(home, {
    repositoryPath: repo.path,
    source: { ref: sha, type: 'commit' },
  });
  try {
    await expect(app.treeRow('math.ts')).toBeVisible();
    await expect(app.treeRow('docs.md')).toBeVisible();
    await expect(app.treeRow('uncommitted.txt')).toHaveCount(0);
    await expect(app.page.getByText('add sub').first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test('choosing a file in the tree selects and reveals its diff', async ({ home, repo }) => {
  const files = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `src/file-${String(index).padStart(2, '0')}.ts`,
      `export const v${index} = 0;\n`,
    ]),
  );
  repo.commit('init', files);
  repo.write(
    Object.fromEntries(
      Object.keys(files).map((path) => [path, `${files[path]}export const changed = true;\n`]),
    ),
  );

  const app = await Codophon.launch(home, { repositoryPath: repo.path });
  try {
    const last = 'src/file-11.ts';
    await app.treeRow(last).click();
    await expect(app.treeRow(last)).toHaveAttribute('aria-selected', 'true');
    await expect(app.file('file-11.ts')).toHaveClass(/selected/);
    await expect(app.file('file-11.ts')).toBeInViewport();
  } finally {
    await app.close();
  }
});
