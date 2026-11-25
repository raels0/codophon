// Create a git commit from a walkthrough's staging set. The renderer hands in the
// human-written subject, the agent-drafted body, and the repo-relative paths the
// reviewer chose to include. Only those paths are committed — any other staged
// changes are left untouched — so a reviewer can land part of a working tree.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WalkthroughCommitRequest, WalkthroughCommitResult } from '../core/types.ts';
import { git, validateRepositoryPath } from './git-state/common.ts';

/** Remove ANSI escape sequences (colors, cursor movement, OSC) from text. */
const stripAnsi = (text: string) =>
  text.replaceAll(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\^_])/g,
    '',
  );

/**
 * Run `git commit`, forwarding its output (pre-commit hook output included) as
 * plain text as it arrives so the renderer can show hooks running live.
 */
const gitStreaming = (
  repoPath: string,
  args: ReadonlyArray<string>,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      cwd: repoPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let combined = '';
    const forward = (data: Buffer) => {
      const chunk = stripAnsi(data.toString()).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      combined += chunk;
      onOutput?.(chunk);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(combined.trim() || `git exited with status ${exitCode}`));
      }
    });
  });

/**
 * @param repoPath Absolute repository root.
 * @param onOutput Receives commit output (hook output included) as it is produced.
 */
const createWalkthroughCommit = async (
  repoPath: string,
  request: Omit<WalkthroughCommitRequest, 'body'> & { body?: string },
  onOutput?: (chunk: string) => void,
): Promise<WalkthroughCommitResult> => {
  const subject = typeof request?.subject === 'string' ? request.subject.trim() : '';
  if (!subject) {
    return { reason: 'A commit subject is required.', status: 'failed' };
  }

  // Each path is repo-relative; validateRepositoryPath rejects absolute paths and
  // `..` traversal, so a malformed document can't reach outside the repository.
  let paths;
  try {
    paths = [...new Set((Array.isArray(request?.paths) ? request.paths : []).map(String))]
      .filter(Boolean)
      .map((path) => validateRepositoryPath(path));
  } catch {
    return { reason: 'A selected file path is invalid.', status: 'failed' };
  }
  if (paths.length === 0) {
    return { reason: 'Select at least one file to commit.', status: 'failed' };
  }

  const body = typeof request?.body === 'string' ? request.body.trim() : '';
  const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;

  try {
    // Stage exactly the chosen paths (covers untracked files too), then commit
    // only those paths so previously-staged work on other files stays staged.
    await git(repoPath, ['add', '--', ...paths]);
    const tempDirectory = mkdtempSync(join(tmpdir(), 'codophon-commit-message-'));
    const messagePath = join(tempDirectory, 'message.txt');
    try {
      writeFileSync(messagePath, message);
      await gitStreaming(repoPath, ['commit', '-F', messagePath, '--', ...paths], onOutput);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
    const hash = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    return { hash, status: 'committed' };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'failed',
    };
  }
};

export { createWalkthroughCommit };
