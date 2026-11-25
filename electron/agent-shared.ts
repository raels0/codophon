import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Backend-neutral helpers shared by the Codex and Claude Code agent backends.

const oneLine = (value: unknown, fallback: string = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

const cleanText = (value: unknown, fallback: string = '') =>
  oneLine(value, fallback).replace(/\s*\.{3}\[truncated]$/i, '');

const normalizeEnum = <T>(value: unknown, allowed: ReadonlySet<T>, fallback: T) =>
  allowed.has(value as T) ? (value as T) : fallback;

/**
 * Walk `text` and return the first balanced JSON object or array, or `null`
 * if none is found.
 */
const extractFirstJson = (text: string): string | null => {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(i, j + 1);
        }
      }
    }
  }
  return null;
};

const schemaRequiredFields = (schema: unknown): ReadonlyArray<string> => {
  if (!schema || typeof schema !== 'object') return [];
  const required = (schema as any).required;
  if (!Array.isArray(required)) return [];
  return required.filter((field) => typeof field === 'string');
};

const hasAllRequiredFields = (parsed: unknown, required: ReadonlyArray<string>): boolean => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const field of required) {
    if (!(field in parsed)) return false;
  }
  return true;
};

const coerceResultToSchema = (parsed: unknown, schema: unknown): unknown => {
  const required = schemaRequiredFields(schema);
  if (!required.length || hasAllRequiredFields(parsed, required)) return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;

  const next: Record<string, unknown> = { ...(parsed as object) };
  const aliases = [
    ['reply', 'text'],
    ['reply', 'response'],
    ['reply', 'answer'],
    ['reply', 'message'],
    ['reply', 'body'],
  ];
  for (const [target, alias] of aliases) {
    if (required.includes(target) && !(target in next) && alias in next) {
      next[target] = next[alias];
    }
  }
  return hasAllRequiredFields(next, required) ? next : parsed;
};

const buildSchemaReminder = (schema: unknown): string => {
  const required = schemaRequiredFields(schema);
  if (!schema || typeof schema !== 'object') return '';
  const requiredInstruction = required.length
    ? ` It must include the field${required.length === 1 ? '' : 's'} ${required
        .map((field) => `\`${field}\``)
        .join(', ')}.`
    : '';
  return `\n\nYour final reply must be a single JSON object.${requiredInstruction} Do not include any prose outside the JSON. Follow this JSON Schema exactly:\n${JSON.stringify(schema)}`;
};

const normalizeStructuredOutput = (output: string, schema: unknown, agentLabel: string): string => {
  const text = output.trim();
  const serialize = (value: unknown) => JSON.stringify(coerceResultToSchema(value, schema));

  try {
    return serialize(JSON.parse(text));
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return serialize(JSON.parse(fenced[1].trim()));
    } catch {}
  }

  const balanced = extractFirstJson(text);
  if (balanced) {
    try {
      return serialize(JSON.parse(balanced));
    } catch {}
  }

  if (text) {
    return JSON.stringify({ text });
  }

  throw new Error(`${agentLabel} did not produce a final answer.`);
};

const parseJSONMessage = (message: string): unknown => {
  try {
    return JSON.parse(message);
  } catch {
    const match = message.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('The agent did not return JSON.');
    }

    return JSON.parse(match[0]);
  }
};

const isExecutableFile = (path: string) => {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
};

const getExecutableNames = (command: string) => {
  if (process.platform !== 'win32') {
    return [command];
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
};

const findExecutableOnPath = (command: string) => {
  const path = process.env.PATH;
  if (!path) {
    return null;
  }

  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const executable of getExecutableNames(command)) {
      const candidate = join(directory, executable);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

export {
  buildSchemaReminder,
  cleanText,
  findExecutableOnPath,
  isExecutableFile,
  normalizeEnum,
  normalizeStructuredOutput,
  oneLine,
  parseJSONMessage,
  truncate,
};
