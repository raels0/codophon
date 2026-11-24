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
const normalizeClaudeSessionId = (value) =>
  typeof value === 'string' && SESSION_UUID_PATTERN.test(value) ? value : '';

const getClaudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** @param {unknown} value */
const extractContentText = (value) => {
  if (typeof value === 'string') {
    return cleanText(value);
  }

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
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
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
    normalized === '/codophon' ||
    normalized === 'codophon' ||
    normalized === 'show me codophon' ||
    normalized === 'open codophon'
  );
};

/** @param {string} path @param {string} sessionId */
const pathMatchesSessionId = (path, sessionId) =>
  path.toLowerCase().endsWith(`${sessionId.toLowerCase()}.jsonl`);

/** @param {unknown} input @returns {import('./session-context-shared.cjs').SessionMessage | null} */
const extractMessage = (input) => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (!('type' in input) || (input.type !== 'user' && input.type !== 'assistant')) {
    return null;
  }

  const message = 'message' in input ? input.message : null;
  if (!message || typeof message !== 'object') {
    return null;
  }

  const role = 'role' in message ? message.role : undefined;
  if (role !== 'assistant' && role !== 'user') {
    return null;
  }

  const text = truncate(
    extractContentText('content' in message ? message.content : null),
    MAX_SESSION_MESSAGE_CHARS,
  );
  if (!text || isNoiseMessage(text)) {
    return null;
  }

  return { role, text };
};

/**
 * @param {string | undefined} claudeSessionId
 * @returns {Promise<WalkthroughContext | null>}
 */
const readClaudeSessionContext = async (claudeSessionId) => {
  const threadId = normalizeClaudeSessionId(claudeSessionId);
  if (!threadId) {
    return null;
  }

  const messages = await readSessionMessages(
    join(getClaudeHome(), 'projects'),
    (path) => pathMatchesSessionId(path, threadId),
    extractMessage,
  );

  return {
    messages,
    risks:
      messages.length === 0
        ? ['Codophon could not find recent readable messages for the linked Claude Code session.']
        : undefined,
    source: {
      generatedAt: new Date().toISOString(),
      threadId,
      type: 'claude-session-excerpt',
    },
    version: 1,
  };
};

module.exports = { readClaudeSessionContext };
