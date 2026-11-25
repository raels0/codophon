import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonlSession, objectFields, sessionMessage } from './session-context-shared.ts';

export const readClaudeSessionContext = (threadId: string | undefined) =>
  readJsonlSession(
    'claude',
    threadId,
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    (path, id) => path.endsWith(`${id}.jsonl`),
    (record) => {
      if (record.type !== 'user' && record.type !== 'assistant') return null;
      const { role, content } = objectFields(record.message);
      return sessionMessage(role, content, 'claude');
    },
  );
