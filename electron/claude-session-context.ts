import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WalkthroughContext } from '../core/types.ts';
import { cleanText, truncate } from './agent-shared.ts';
import {
  MAX_SESSION_MESSAGE_CHARS,
  SESSION_UUID_PATTERN,
  readSessionMessages,
} from './session-context-shared.ts';

const normalizeClaudeSessionId = (value: unknown) =>
  typeof value === 'string' && SESSION_UUID_PATTERN.test(value) ? value : '';

const getClaudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const extractContentText = (value: unknown) => {
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

const isNoiseMessage = (text: string) => {
  const normalized = cleanText(text).toLowerCase();
  return (
    normalized === '/codophon' ||
    normalized === 'codophon' ||
    normalized === 'show me codophon' ||
    normalized === 'open codophon'
  );
};

const pathMatchesSessionId = (path: string, sessionId: string) =>
  path.toLowerCase().endsWith(`${sessionId.toLowerCase()}.jsonl`);

const extractMessage = (
  input: unknown,
): import('./session-context-shared.ts').SessionMessage | null => {
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

const readClaudeSessionContext = async (
  claudeSessionId: string | undefined,
): Promise<WalkthroughContext | null> => {
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

export { readClaudeSessionContext };
