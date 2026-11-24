// @ts-check

const { homedir } = require('node:os');
const { join } = require('node:path');
const { cleanText, truncate } = require('./agent-shared.cjs');
const {
  MAX_SESSION_MESSAGE_CHARS,
  SESSION_UUID_PATTERN,
  readSessionMessages,
} = require('./session-context-shared.cjs');

/**
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 */

/** @param {unknown} value */
const normalizeCodexSessionId = (value) =>
  typeof value === 'string' && SESSION_UUID_PATTERN.test(value) ? value : '';

const getCodexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

/** @param {unknown} value */
const extractContentText = (value) => {
  if (!Array.isArray(value)) {
    return '';
  }

  return cleanText(
    value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }

        if (
          'text' in item &&
          typeof item.text === 'string' &&
          (!('type' in item) ||
            item.type === 'input_text' ||
            item.type === 'output_text' ||
            item.type === 'text')
        ) {
          return item.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n'),
  );
};

/** @param {string} text */
const isNoiseMessage = (text) => {
  const normalized = cleanText(text).toLowerCase();
  return (
    normalized === '$codophon' ||
    normalized === 'show me codophon' ||
    normalized === 'open codophon'
  );
};

/** @param {string} path @param {string} sessionId */
const pathMatchesSessionId = (path, sessionId) =>
  path.endsWith('.jsonl') && path.toLowerCase().includes(sessionId.toLowerCase());

/** @param {unknown} input @returns {import('./session-context-shared.cjs').SessionMessage | null} */
const extractMessage = (input) => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (!('type' in input) || input.type !== 'response_item') {
    return null;
  }

  const payload = 'payload' in input ? input.payload : null;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (!('type' in payload) || payload.type !== 'message') {
    return null;
  }

  const role = 'role' in payload ? payload.role : undefined;
  if (role !== 'assistant' && role !== 'user') {
    return null;
  }

  const text = truncate(
    extractContentText('content' in payload ? payload.content : null),
    MAX_SESSION_MESSAGE_CHARS,
  );
  if (!text || isNoiseMessage(text)) {
    return null;
  }

  return { role, text };
};

/**
 * @param {string | undefined} codexSessionId
 * @returns {Promise<WalkthroughContext | null>}
 */
const readCodexSessionContext = async (codexSessionId) => {
  const threadId = normalizeCodexSessionId(codexSessionId);
  if (!threadId) {
    return null;
  }

  const messages = await readSessionMessages(
    join(getCodexHome(), 'sessions'),
    (path) => pathMatchesSessionId(path, threadId),
    extractMessage,
  );

  return {
    messages,
    risks:
      messages.length === 0
        ? ['Codophon could not find recent readable messages for the linked Codex session.']
        : undefined,
    source: {
      generatedAt: new Date().toISOString(),
      threadId,
      type: 'codex-session-excerpt',
    },
    version: 1,
  };
};

module.exports = { readCodexSessionContext };
