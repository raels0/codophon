import { afterEach, beforeEach, expect, test } from 'vite-plus/test';
import { createEditorOpener } from '../main/editor.ts';

const originalCodophonEditor = process.env.CODOPHON_EDITOR;

beforeEach(() => {
  delete process.env.CODOPHON_EDITOR;
});

afterEach(() => {
  if (originalCodophonEditor === undefined) {
    delete process.env.CODOPHON_EDITOR;
  } else {
    process.env.CODOPHON_EDITOR = originalCodophonEditor;
  }
});

const createOpener = (
  options: { getEditorCommand?: () => string; platform?: NodeJS.Platform } = {},
) =>
  createEditorOpener({
    ...options,
    shell: {
      openPath: async () => '',
    },
  });

test('falls back to the macOS default text editor for text files without app associations', () => {
  const opener = createOpener({
    platform: 'darwin',
  });

  expect(opener.getEditorCommands('/Users/test/.codophon/codophon.jsonc')).toContainEqual({
    args: ['-t', '/Users/test/.codophon/codophon.jsonc'],
    command: 'open',
  });
});

test('parses custom editor commands with quoted arguments', () => {
  const opener = createOpener();

  expect(opener.parseEditorCommand('editor --goto "{file}"')).toEqual([
    'editor',
    '--goto',
    '{file}',
  ]);
});

test('uses the configured editor command before built-in commands', () => {
  const opener = createOpener({
    getEditorCommand: () => 'cursor --goto "{file}"',
  });

  expect(opener.getEditorCommands('/Users/test/project/file.ts')[0]).toEqual({
    args: ['--goto', '/Users/test/project/file.ts'],
    command: 'cursor',
  });
});

test('expands the repo placeholder in configured editor commands', () => {
  const opener = createOpener({
    getEditorCommand: () => 'subl "{repo}" "{file}"',
  });

  expect(
    opener.getEditorCommands('/Users/test/project/src/file.ts', {
      repoPath: '/Users/test/project',
    })[0],
  ).toEqual({
    args: ['/Users/test/project', '/Users/test/project/src/file.ts'],
    command: 'subl',
  });
});

test('opens definitions at their line in configured and built-in editors', () => {
  const opener = createOpener({
    getEditorCommand: () => 'cursor --goto "{file}:{line}"',
  });

  const commands = opener.getEditorCommands('/Users/test/project/src/file.ts', {
    lineNumber: 42,
    repoPath: '/Users/test/project',
  });
  expect(commands[0]).toEqual({
    args: ['--goto', '/Users/test/project/src/file.ts:42'],
    command: 'cursor',
  });
  expect(commands).toContainEqual({
    args: ['-g', '/Users/test/project/src/file.ts:42'],
    command: 'code',
  });
});

test('appends the file path when the configured editor command only uses the repo placeholder', () => {
  const opener = createOpener({
    getEditorCommand: () => 'subl "{repo}"',
  });

  expect(
    opener.getEditorCommands('/Users/test/project/src/file.ts', {
      repoPath: '/Users/test/project',
    })[0],
  ).toEqual({
    args: ['/Users/test/project', '/Users/test/project/src/file.ts'],
    command: 'subl',
  });
});

test('lets CODOPHON_EDITOR override the configured editor command', () => {
  process.env.CODOPHON_EDITOR = 'zed --wait';

  const opener = createOpener({
    getEditorCommand: () => 'cursor --goto "{file}"',
  });

  expect(opener.getEditorCommands('/Users/test/project/file.ts')[0]).toEqual({
    args: ['--wait', '/Users/test/project/file.ts'],
    command: 'zed',
  });
});
