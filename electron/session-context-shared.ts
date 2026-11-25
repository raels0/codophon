import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_LABELS, type AgentBackend } from '../core/config/agents.ts';
import type { WalkthroughContext } from '../core/types.ts';
import { cleanText, truncate } from './agent-shared.ts';

const MAX_SESSION_SCAN_FILES = 20_000;
const MAX_SESSION_MESSAGE_CHARS = 2_400;
const MAX_SESSION_MESSAGES = 18;
const MAX_SESSION_CONTEXT_CHARS = 28_000;
const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSION_READ_BYTES = 16 * 1024 * 1024;

const readSessionFileTail = async (path: string) => {
  let handle: import('node:fs/promises').FileHandle | undefined;

  try {
    handle = await open(path, 'r');
    const file = await handle.stat();
    if (!file.isFile() || file.size === 0) {
      return '';
    }

    const length = Math.min(file.size, MAX_SESSION_READ_BYTES);
    const offset = file.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let totalBytesRead = 0;

    while (totalBytesRead < length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        length - totalBytesRead,
        offset + totalBytesRead,
      );
      if (bytesRead === 0) {
        break;
      }
      totalBytesRead += bytesRead;
    }

    const text = buffer.toString('utf8', 0, totalBytesRead);

    if (offset === 0) {
      return text;
    }

    const precedingByte = Buffer.allocUnsafe(1);
    const { bytesRead: precedingBytesRead } = await handle.read(precedingByte, 0, 1, offset - 1);
    if (precedingBytesRead === 1 && precedingByte[0] === 0x0a) {
      return text;
    }

    const firstCompleteLine = text.indexOf('\n');
    return firstCompleteLine === -1 ? '' : text.slice(firstCompleteLine + 1);
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
};

const findSessionFile = async (root: string, matches: (path: string) => boolean) => {
  const stack: Array<string> = [root];
  let scanned = 0;

  while (stack.length > 0 && scanned < MAX_SESSION_SCAN_FILES) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }

    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        b.name.localeCompare(a.name),
      );
    } catch {
      continue;
    }

    const directories = [];
    for (const entry of entries) {
      scanned += 1;
      const path = join(directory, entry.name);
      if (entry.isFile() && matches(path)) {
        return path;
      }

      if (entry.isDirectory()) {
        directories.push(path);
      }

      if (scanned >= MAX_SESSION_SCAN_FILES) {
        break;
      }
    }

    stack.push(...directories.reverse());
  }

  return null;
};

export type SessionMessage = NonNullable<
  import('../core/types.ts').WalkthroughContext['messages']
>[number];

const selectRecentMessages = (messages: ReadonlyArray<SessionMessage>) => {
  const selected: Array<SessionMessage> = [];
  let totalChars = 0;
  for (let i = messages.length - 1; i >= 0 && selected.length < MAX_SESSION_MESSAGES; i--) {
    const message = messages[i];
    const cost = message.role.length + message.text.length + 2;
    if (selected.length && totalChars + cost > MAX_SESSION_CONTEXT_CHARS) break;
    selected.push(message);
    totalChars += cost;
  }
  return selected.reverse();
};

const readSessionMessages = async (
  root: string,
  matches: (path: string) => boolean,
  extractMessage: (record: unknown) => SessionMessage | null,
) => {
  const path = await findSessionFile(root, matches);
  if (!path) return [];
  const messages = [];
  for (const line of (await readSessionFileTail(path)).split('\n')) {
    if (!line.trim()) continue;
    try {
      const message = extractMessage(JSON.parse(line));
      if (message) messages.push(message);
    } catch {
      // Ignore malformed transcript records.
    }
  }
  return selectRecentMessages(messages);
};

export function objectFields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function sessionMessage(
  role: unknown,
  content: unknown,
  agent: AgentBackend,
): SessionMessage | null {
  if (role !== 'user' && role !== 'assistant') return null;
  const raw =
    agent === 'claude' && typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              const { type, text } = objectFields(part);
              const isText =
                type === 'text' ||
                (agent === 'codex' &&
                  (type === undefined || type === 'input_text' || type === 'output_text'));
              return isText && typeof text === 'string' ? text : '';
            })
            .filter(Boolean)
            .join('\n')
        : '';
  const text = truncate(cleanText(raw), MAX_SESSION_MESSAGE_CHARS);
  const normalized = cleanText(text).toLowerCase();
  if (!normalized || ['show me codophon', 'open codophon'].includes(normalized)) return null;
  if (agent !== 'claude' && normalized === '$codophon') return null;
  if (agent !== 'codex' && ['codophon', '/codophon'].includes(normalized)) return null;
  return { role, text };
}

export function sessionContext(
  agent: AgentBackend,
  threadId: string,
  messages: SessionMessage[],
): WalkthroughContext {
  return {
    messages,
    risks: messages.length
      ? undefined
      : [
          `Codophon could not find recent readable messages for the linked ${AGENT_LABELS[agent]} session.`,
        ],
    source: { generatedAt: new Date().toISOString(), threadId, type: `${agent}-session-excerpt` },
    version: 1,
  };
}

export async function readJsonlSession(
  agent: 'claude' | 'codex',
  threadId: string | undefined,
  root: string,
  matches: (path: string, id: string) => boolean,
  extract: (record: Record<string, unknown>) => SessionMessage | null,
) {
  if (!threadId || !SESSION_UUID_PATTERN.test(threadId)) return null;
  const messages = await readSessionMessages(
    root,
    (path) => matches(path.toLowerCase(), threadId.toLowerCase()),
    (record) => extract(objectFields(record)),
  );
  return sessionContext(agent, threadId, messages);
}

export { selectRecentMessages };
