import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord, createDefaultConfig, readConfigProperties } from '../core/config/defaults.ts';
import type { CodophonConfig } from '../core/config/types.ts';
import { normalizeAgentPrompts } from './agent-prompts.ts';
import { normalizeClaudeModel } from './claude.ts';
import { normalizeOpenAIModel } from './codex.ts';
import { normalizeOpenCodeModel } from './opencode.ts';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/raels0/codophon/main/core/config/codophon-config.schema.json';

const getConfigDir = () => join(homedir(), '.codophon');

const getConfigPath = (configDir?: string) => join(configDir ?? getConfigDir(), 'codophon.jsonc');

/**
 * Strip JSONC comments (line comments and block comments) to produce valid JSON.
 */
const stripJsoncComments = (text: string): string => {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }

    if (text[i] === '"') {
      inString = true;
      result += text[i];
      i++;
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '/') {
      // Line comment: skip to end of line
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '*') {
      // Block comment: skip to closing */
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    result += text[i];
    i++;
  }

  return result;
};

/**
 * Strip trailing commas from JSON (e.g., `[1, 2,]` or `{"a": 1,}`).
 */
const stripTrailingCommas = (text: string): string => {
  let result = '';
  let inString = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      result += character;
      if (character === '\\') {
        result += text[++index] ?? '';
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === ',') {
      let next = index + 1;
      while (/\s/.test(text[next] ?? '')) {
        next++;
      }
      if (text[next] === ']' || text[next] === '}') {
        continue;
      }
    }

    result += character;
  }

  return result;
};

/**
 * Parse a JSONC string into a JavaScript object.
 */
const parseJsonc = (text: string): unknown =>
  JSON.parse(stripTrailingCommas(stripJsoncComments(text)));

// Older config files stored each model and the extra walkthrough guidance at the top level.
function mergeConfig(raw: unknown): CodophonConfig {
  const obj = asRecord(raw);
  const saved = asRecord(obj.settings);
  const agents = asRecord(saved.agents);
  const value = readConfigProperties(raw);
  value.settings.codeFontFamily = value.settings.codeFontFamily.trim();
  value.settings.agents = {
    claude: { model: normalizeClaudeModel(asRecord(agents.claude).model ?? saved.claudeModel) },
    codex: {
      model: normalizeOpenAIModel(asRecord(agents.codex).model ?? saved.openAIModel),
      reasoningEffort: value.settings.agents.codex.reasoningEffort.trim(),
    },
    opencode: {
      model: normalizeOpenCodeModel(asRecord(agents.opencode).model ?? saved.opencodeModel),
    },
  };
  if (
    asRecord(agents.codex).reasoningEffort === undefined &&
    typeof saved.openAIReasoningEffort === 'string'
  ) {
    value.settings.agents.codex.reasoningEffort = saved.openAIReasoningEffort.trim();
  }
  value.settings.agentPrompts = normalizeAgentPrompts({
    walkthrough: saved.walkthroughPrompt,
    ...asRecord(saved.agentPrompts),
  });
  return value;
}

/**
 * Read and parse the config file. Returns defaults if the file does not exist or is invalid.
 */
const readConfig = (configDir?: string): CodophonConfig => {
  const configPath = getConfigPath(configDir);

  if (!existsSync(configPath)) {
    return createDefaultConfig();
  }

  try {
    const text = readFileSync(configPath, 'utf8');
    const raw = parseJsonc(text);
    return mergeConfig(raw);
  } catch {
    return createDefaultConfig();
  }
};

/** Write a config object to the config file as JSONC with a $schema reference. */
const writeConfig = (config: CodophonConfig) => {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const output = {
    $schema: SCHEMA_URL,
    keymap: config.keymap,
    settings: config.settings,
  };

  writeFileSync(getConfigPath(), JSON.stringify(output, null, 2) + '\n');
};

/**
 * Create the config file with defaults if it doesn't already exist.
 * @returns true if the file was created, false if it already existed.
 */
const initConfig = (): boolean => {
  if (existsSync(getConfigPath())) {
    return false;
  }

  writeConfig(createDefaultConfig());
  return true;
};

const importPreviousConfig = () => {
  if (existsSync(getConfigPath())) {
    return;
  }
  const previousPath = join(homedir(), '.codiff', 'codiff.jsonc');
  if (existsSync(previousPath)) {
    try {
      writeConfig(mergeConfig(parseJsonc(readFileSync(previousPath, 'utf8'))));
    } catch {}
  }
};

/**
 * Watch the config file for changes.
 *  * @returns stop watching
 */
const watchConfig = (onChange: (config: CodophonConfig) => void): (() => void) => {
  const configDir = getConfigDir();

  // Ensure the directory exists for watching
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let debounceTimer = null as ReturnType<typeof setTimeout> | null;

  // Watch the directory so we detect file creation/deletion too
  const watcher = watch(configDir, (eventType, filename) => {
    if (filename !== 'codophon.jsonc') {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange(readConfig());
    }, 200);
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
};

export {
  createDefaultConfig,
  getConfigPath,
  initConfig,
  importPreviousConfig,
  mergeConfig,
  readConfig,
  watchConfig,
  writeConfig,
};
