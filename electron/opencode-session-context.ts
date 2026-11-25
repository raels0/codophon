import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanText, truncate } from './agent-shared.ts';
import { getOpenCodeCommand } from './opencode.ts';
import { MAX_SESSION_MESSAGE_CHARS, selectRecentMessages } from './session-context-shared.ts';

const OPENCODE_EXPORT_TIMEOUT_MS = 15_000;
const MAX_OPENCODE_EXPORT_BYTES = 16 * 1024 * 1024;
const SESSION_ID_PATTERN = /^ses_[a-z0-9]{8,}$/i;

import type { WalkthroughContext } from '../core/types.ts';

const normalizeOpenCodeSessionId = (value: unknown) =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : '';

const isNoiseMessage = (text: string) => {
  const normalized = cleanText(text).toLowerCase();
  return (
    normalized === '/codophon' ||
    normalized === '$codophon' ||
    normalized === 'codophon' ||
    normalized === 'show me codophon' ||
    normalized === 'open codophon'
  );
};

const extractMessage = (
  value: unknown,
): import('./session-context-shared.ts').SessionMessage | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const info = 'info' in value ? value.info : null;
  if (!info || typeof info !== 'object') {
    return null;
  }

  const role = 'role' in info ? info.role : undefined;
  if (role !== 'assistant' && role !== 'user') {
    return null;
  }

  const parts = 'parts' in value && Array.isArray(value.parts) ? value.parts : [];
  const text = truncate(
    cleanText(
      parts
        .map((part) =>
          part &&
          typeof part === 'object' &&
          'type' in part &&
          part.type === 'text' &&
          'text' in part &&
          typeof part.text === 'string'
            ? part.text
            : '',
        )
        .filter(Boolean)
        .join('\n'),
    ),
    MAX_SESSION_MESSAGE_CHARS,
  );
  if (!text || isNoiseMessage(text)) {
    return null;
  }

  return { role, text };
};

const extractSessionMessages = (input: unknown) => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('messages' in input) ||
    !Array.isArray(input.messages)
  ) {
    return [];
  }

  return selectRecentMessages(
    input.messages.map(extractMessage).filter((message) => message !== null),
  );
};

const isMatchingSessionExport = (input: unknown, sessionId: string) =>
  Boolean(
    input &&
    typeof input === 'object' &&
    'info' in input &&
    input.info &&
    typeof input.info === 'object' &&
    'id' in input.info &&
    input.info.id === sessionId,
  );

const exportOpenCodeSession = (sessionId: string, timeoutMs: number = OPENCODE_EXPORT_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const directory = mkdtempSync(join(tmpdir(), 'codophon-opencode-session-'));
    const path = join(directory, 'session.json');
    let output: number | undefined;
    let settled = false;
    let timedOut = false;

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const closeOutput = () => {
      if (output == null) {
        return;
      }

      try {
        closeSync(output);
      } catch {}
      output = undefined;
    };

    const removeDirectory = () => {
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {}
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      closeOutput();
      removeDirectory();
      resolve(value);
    };

    try {
      output = openSync(path, 'w', 0o600);
      // OpenCode can truncate large exports when stdout is a pipe. Writing
      // directly to a file descriptor preserves the complete JSON document.
      const child = spawn(getOpenCodeCommand(), ['export', '--pure', sessionId], {
        stdio: ['ignore', output, 'ignore'],
        windowsHide: true,
      });
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        finish(null);
      }, timeoutMs);
      child.once('error', () => finish(null));
      child.once('close', async (code) => {
        if (settled) {
          closeOutput();
          removeDirectory();
          return;
        }

        if (timedOut || code !== 0) {
          finish(null);
          return;
        }

        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        closeOutput();

        try {
          if ((await stat(path)).size > MAX_OPENCODE_EXPORT_BYTES) {
            finish(null);
            return;
          }

          const input = JSON.parse(await readFile(path, 'utf8'));
          finish(isMatchingSessionExport(input, sessionId) ? input : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });

const readOpenCodeSessionContext = async (
  opencodeSessionId: string | undefined,
): Promise<WalkthroughContext | null> => {
  const threadId = normalizeOpenCodeSessionId(opencodeSessionId);
  if (!threadId) {
    return null;
  }

  let session;
  try {
    session = await exportOpenCodeSession(threadId);
  } catch {
    session = null;
  }
  const messages = extractSessionMessages(session);
  return {
    messages,
    risks:
      messages.length === 0
        ? ['Codophon could not find recent readable messages for the linked OpenCode session.']
        : undefined,
    source: {
      generatedAt: new Date().toISOString(),
      threadId,
      type: 'opencode-session-excerpt',
    },
    version: 1,
  };
};

export { readOpenCodeSessionContext };
