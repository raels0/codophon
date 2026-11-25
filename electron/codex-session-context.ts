import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonlSession, objectFields, sessionMessage } from './session-context-shared.ts';

export const readCodexSessionContext = (threadId: string | undefined) =>
  readJsonlSession(
    'codex',
    threadId,
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
    (path, id) => path.endsWith('.jsonl') && path.includes(id),
    (record) => {
      const { type, role, content } = objectFields(record.payload);
      if (record.type !== 'response_item' || type !== 'message') return null;
      return sessionMessage(role, content, 'codex');
    },
  );
