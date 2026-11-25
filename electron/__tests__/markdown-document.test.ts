import { chmod, lstat, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import { readMarkdownDocument, writeMarkdownDocument } from '../markdown-document.ts';

test('reads and atomically writes repository Markdown documents', async () => {
  await using directory = await createTemporaryDirectory('codophon-markdown-');
  const path = join(directory.path, 'plan.md');
  const context = { repositoryRoot: directory.path };

  await writeFile(path, '# Original\n');
  const document = await readMarkdownDocument({ kind: 'repository', path: 'plan.md' }, context);
  const saved = await writeMarkdownDocument(
    {
      baseVersion: document.version,
      content: '# Updated\n',
      kind: 'repository',
      path: 'plan.md',
    },
    context,
  );

  expect(saved.content).toBe('# Updated\n');
  expect(saved.version).not.toBe(document.version);
  expect(await readFile(path, 'utf8')).toBe('# Updated\n');
});

test('preserves repository Markdown file permissions when saving', async () => {
  await using directory = await createTemporaryDirectory('codophon-markdown-mode-');
  const path = join(directory.path, 'executable.md');
  const context = { repositoryRoot: directory.path };

  await writeFile(path, '# Original\n');
  await chmod(path, 0o755);
  const document = await readMarkdownDocument(
    { kind: 'repository', path: 'executable.md' },
    context,
  );

  await writeMarkdownDocument(
    {
      baseVersion: document.version,
      content: '# Updated\n',
      kind: 'repository',
      path: 'executable.md',
    },
    context,
  );

  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test('returns the disk document when a stale version attempts to overwrite it', async () => {
  await using directory = await createTemporaryDirectory('codophon-markdown-conflict-');
  const path = join(directory.path, 'plan.md');
  const context = { repositoryRoot: directory.path };

  await writeFile(path, '# Original\n');
  const document = await readMarkdownDocument({ kind: 'repository', path: 'plan.md' }, context);
  await writeFile(path, '# External edit\n');

  await expect(
    writeMarkdownDocument(
      {
        baseVersion: document.version,
        content: '# Local edit\n',
        kind: 'repository',
        path: 'plan.md',
      },
      context,
    ),
  ).rejects.toMatchObject({
    document: {
      content: '# External edit\n',
    },
    name: 'MarkdownDocumentConflictError',
  });
});

test('rejects repository Markdown paths that resolve outside through a symlink', async () => {
  await using root = await createTemporaryDirectory('codophon-markdown-symlink-root-');
  await using outside = await createTemporaryDirectory('codophon-markdown-symlink-outside-');
  const outsidePath = join(outside.path, 'outside.md');

  await writeFile(outsidePath, '# Outside\n');
  await symlink(outside.path, join(root.path, 'docs'));

  await expect(
    readMarkdownDocument(
      { kind: 'repository', path: 'docs/outside.md' },
      { repositoryRoot: root.path },
    ),
  ).rejects.toThrow('escapes the repository');
  expect(await readFile(outsidePath, 'utf8')).toBe('# Outside\n');
});
