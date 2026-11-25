import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

export type EditorCommand = { args: Array<string>; command: string };

export type EditorCommandContext = { lineNumber?: number; repoPath?: string };

const createEditorOpener = ({
  getEditorCommand = () => '',
  platform = process.platform,
  shell,
}: {
  getEditorCommand?: () => string;
  platform?: NodeJS.Platform;
  shell: import('electron').Shell;
}) => {
  // Handles simple editor commands with quoted arguments. Keep this small unless
  // we need full shell-style escaping semantics.
  const parseEditorCommand = (command: string) =>
    command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];

  const runEditorCommand = (command: string, args: ReadonlyArray<string>) =>
    new Promise((resolveCommand) => {
      execFile(command, args, { windowsHide: true }, (error) => resolveCommand(!error));
    });

  const replaceEditorPlaceholders = (
    arg: string,
    absolutePath: string,
    context: EditorCommandContext,
  ) =>
    arg
      .replaceAll('{file}', absolutePath)
      .replaceAll('{line}', context.lineNumber ? String(context.lineNumber) : '')
      .replaceAll('{repo}', context.repoPath || dirname(absolutePath));

  const getCustomEditorArgs = (
    args: ReadonlyArray<string>,
    absolutePath: string,
    context: EditorCommandContext,
  ) => {
    if (args.length === 0) {
      return [absolutePath];
    }

    const expandedArgs = args.map((arg) => replaceEditorPlaceholders(arg, absolutePath, context));
    return args.some((arg) => arg.includes('{file}'))
      ? expandedArgs
      : [...expandedArgs, absolutePath];
  };

  const getEditorCommands = (
    absolutePath: string,
    context: EditorCommandContext = {},
  ): Array<EditorCommand> => {
    const commands: Array<EditorCommand> = [];
    const customEditor = process.env.CODOPHON_EDITOR || getEditorCommand();
    if (customEditor) {
      const [command, ...args] = parseEditorCommand(customEditor);
      if (command) {
        commands.push({
          args: getCustomEditorArgs(args, absolutePath, context),
          command,
        });
      }
    }

    for (const command of ['/opt/homebrew/bin/code', '/usr/local/bin/code', 'code']) {
      commands.push({
        args: ['-g', context.lineNumber ? `${absolutePath}:${context.lineNumber}` : absolutePath],
        command,
      });
    }

    if (platform === 'darwin') {
      commands.push({
        args: ['-a', 'Visual Studio Code', absolutePath],
        command: 'open',
      });
      commands.push({
        args: ['-t', absolutePath],
        command: 'open',
      });
    }

    return commands;
  };

  const openFileInEditor = async (absolutePath: string, context: EditorCommandContext = {}) => {
    for (const { args, command } of getEditorCommands(absolutePath, context)) {
      if (await runEditorCommand(command, args)) {
        return;
      }
    }

    await shell.openPath(absolutePath);
  };

  return {
    getEditorCommands,
    openFileInEditor,
    parseEditorCommand,
  };
};

export { createEditorOpener };
