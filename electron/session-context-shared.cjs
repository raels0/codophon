// @ts-check

const { open, readdir } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_SESSION_SCAN_FILES = 20_000;
const MAX_SESSION_MESSAGE_CHARS = 2_400;
const MAX_SESSION_MESSAGES = 18;
const MAX_SESSION_CONTEXT_CHARS = 28_000;
const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSION_READ_BYTES = 16 * 1024 * 1024;

/** @param {string} path */
const readSessionFileTail = async (path) => {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;

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

/**
 * @param {string} root
 * @param {(path: string) => boolean} matches
 */
const findSessionFile = async (root, matches) => {
  /** @type {Array<string>} */
  const stack = [root];
  let scanned = 0;

  while (stack.length > 0 && scanned < MAX_SESSION_SCAN_FILES) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }

    /** @type {Array<import('node:fs').Dirent>} */
    let entries;
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

/** @typedef {NonNullable<import('../core/types.ts').WalkthroughContext['messages']>[number]} SessionMessage */

/**
 * @param {ReadonlyArray<SessionMessage>} messages
 */
const selectRecentMessages = (messages) => {
  /** @type {Array<SessionMessage>} */
  const selected = [];
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

/**
 * @param {string} root
 * @param {(path: string) => boolean} matches
 * @param {(record: unknown) => SessionMessage | null} extractMessage
 */
const readSessionMessages = async (root, matches, extractMessage) => {
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

module.exports = {
  MAX_SESSION_MESSAGE_CHARS,
  SESSION_UUID_PATTERN,
  readSessionMessages,
  selectRecentMessages,
};
