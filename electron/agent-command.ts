import { spawn } from 'node:child_process';
import { oneLine, findExecutableOnPath, isExecutableFile } from './agent-shared.ts';

export type AgentCommandTransport = {
  command: string;
  spawn?: typeof spawn;
};

const resolveAgentCommandTransport = (
  transport: AgentCommandTransport | undefined,
  getCommand: () => string,
) => ({
  command: transport?.command || getCommand(),
  spawn: transport?.spawn || spawn,
});

const findAgentCommand = (
  command: string,
  overrideKey: string,
  installPaths: ReadonlyArray<string>,
  notFound: (detail?: string) => Error,
) => {
  const override = process.env[overrideKey]?.trim();
  if (override) {
    if (!isExecutableFile(override)) {
      throw notFound(
        `${overrideKey} is set to ${JSON.stringify(override)}, but that file is not executable.`,
      );
    }
    return override;
  }

  const path = findExecutableOnPath(command) || installPaths.find(isExecutableFile);
  if (!path) throw notFound();
  return path;
};

const collectAgentOutput = (
  child: import('node:child_process').ChildProcessWithoutNullStreams,
  options: {
    label: string;
    prompt: string;
    timeoutMs: number;
    timeoutMessage: string;
    getLaunchError: (error: Error) => Error;
    getExitError?: (message: string, signal: NodeJS.Signals | null) => Error;
    onStdout?: (text: string) => void;
  },
): Promise<string> =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdinError = '';
    const timer = setTimeout(() => {
      reject(new Error(options.timeoutMessage));
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr += text;
    });
    child.stdin.on('error', (error) => {
      stdinError = error.message;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(options.getLaunchError(error));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr || stdout || stdinError;
      const message =
        detail ||
        (signal
          ? `${options.label} was terminated by ${signal}.`
          : `${options.label} exited with code ${code}.`);
      reject(options.getExitError?.(message, signal) ?? new Error(oneLine(message)));
    });
    child.stdin.end(options.prompt);
  });

export { collectAgentOutput, findAgentCommand, resolveAgentCommandTransport };
