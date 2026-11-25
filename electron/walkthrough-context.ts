import { readFileSync } from 'node:fs';
import { cleanText, truncate } from './agent-shared.ts';

const MAX_CONTEXT_FILE_CHARS = 32_000;
const MAX_TEXT_CHARS = 1_800;
const MAX_LIST_ITEMS = 16;
const MAX_FILE_ITEMS = 120;
const MAX_MESSAGE_ITEMS = 18;
const MAX_MESSAGE_TEXT_CHARS = 2_400;

import type { WalkthroughContext } from '../core/types.ts';

const normalizeString = (value: unknown, maxLength: number = MAX_TEXT_CHARS) => {
  const normalized = cleanText(value);
  return normalized ? truncate(normalized, maxLength) : undefined;
};

const normalizeStringList = (value: unknown, maxLength: number = MAX_TEXT_CHARS) => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .map((item) => normalizeString(item, maxLength))
    .filter((item) => typeof item === 'string')
    .slice(0, MAX_LIST_ITEMS);

  return values.length > 0 ? values : undefined;
};

const normalizeChangedFiles = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const files = value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const path = normalizeString('path' in item ? item.path : undefined, 500);
      const role = normalizeString('role' in item ? item.role : undefined, 800);
      if (!path || !role) {
        return null;
      }

      return {
        path,
        rationale: normalizeString('rationale' in item ? item.rationale : undefined, 800),
        role,
      };
    })
    .filter((item) => item != null)
    .slice(0, MAX_FILE_ITEMS);

  return files.length > 0 ? files : undefined;
};

const normalizeMessages = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const messages = value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const role = 'role' in item ? item.role : undefined;
      if (role !== 'assistant' && role !== 'user') {
        return null;
      }

      const text = normalizeString('text' in item ? item.text : undefined, MAX_MESSAGE_TEXT_CHARS);
      if (!text) {
        return null;
      }

      return { role, text };
    })
    .filter((item) => item != null)
    .slice(0, MAX_MESSAGE_ITEMS);

  return messages.length > 0 ? messages : undefined;
};

const normalizeWalkthroughContext = (
  input: unknown,
  codexSessionId?: string,
): WalkthroughContext | null => {
  if (!input || typeof input !== 'object') {
    if (!codexSessionId) {
      return null;
    }

    return {
      source: {
        generatedAt: new Date().toISOString(),
        threadId: codexSessionId,
        type: 'codex-session',
      },
      version: 1,
    };
  }

  const source =
    'source' in input && input.source && typeof input.source === 'object' ? input.source : {};
  const threadId =
    normalizeString('threadId' in source ? source.threadId : undefined, 160) ||
    normalizeString('codexSessionId' in input ? input.codexSessionId : undefined, 160) ||
    codexSessionId;
  const generatedAt =
    normalizeString('generatedAt' in source ? source.generatedAt : undefined, 80) ||
    new Date().toISOString();

  const context = {
    changedFiles: normalizeChangedFiles('changedFiles' in input ? input.changedFiles : undefined),
    constraints: normalizeStringList('constraints' in input ? input.constraints : undefined),
    decisions: normalizeStringList('decisions' in input ? input.decisions : undefined),
    implementationSummary: normalizeString(
      'implementationSummary' in input ? input.implementationSummary : undefined,
    ),
    messages: normalizeMessages('messages' in input ? input.messages : undefined),
    objective: normalizeString('objective' in input ? input.objective : undefined),
    risks: normalizeStringList('risks' in input ? input.risks : undefined),
    source: {
      generatedAt,
      ...(threadId ? { threadId } : {}),
      type: 'codex-session',
    },
    validation: normalizeStringList('validation' in input ? input.validation : undefined),
    version: 1,
  };

  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as unknown as WalkthroughContext;
};

const readWalkthroughContextFile = (
  contextPath: string,
  codexSessionId?: string,
): WalkthroughContext | null => {
  const raw = readFileSync(contextPath, 'utf8');
  if (raw.length > MAX_CONTEXT_FILE_CHARS) {
    throw new Error(`Context file exceeds ${MAX_CONTEXT_FILE_CHARS} characters.`);
  }

  const input = JSON.parse(raw);
  return normalizeWalkthroughContext(input, codexSessionId);
};

const readWalkthroughContext = (
  contextPath?: string,
  codexSessionId?: string,
): WalkthroughContext | null => {
  if (!contextPath) {
    return normalizeWalkthroughContext(null, codexSessionId);
  }

  try {
    return readWalkthroughContextFile(contextPath, codexSessionId);
  } catch (error) {
    return normalizeWalkthroughContext(
      {
        risks: [
          `Codophon could not read the supplied Codex walkthrough context: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
      codexSessionId,
    );
  }
};

const mergeWalkthroughContexts = (
  providedContext: WalkthroughContext | null | undefined,
  sessionContext: WalkthroughContext | null | undefined,
) => {
  if (!providedContext) {
    return sessionContext;
  }

  if (!sessionContext) {
    return providedContext;
  }

  return {
    ...sessionContext,
    ...providedContext,
    messages: sessionContext.messages,
    risks: [...(sessionContext.risks || []), ...(providedContext.risks || [])],
    source: sessionContext.source,
  };
};

export { mergeWalkthroughContexts, readWalkthroughContext };
