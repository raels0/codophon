import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import defaultConfigTemplate from '../config/defaults.json' with { type: 'json' };
import { normalizeAgentBackend } from '../core/config/agents.ts';
import type { CodophonConfig, CodophonDiffStyle, CodophonTheme } from '../core/config/types.ts';
import { normalizeAgentPrompts } from './agent-prompts.ts';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/raels0/codophon/main/core/config/codophon-config.schema.json';
const CODE_FONT_SIZE_DEFAULT = 13;
const CODE_FONT_SIZE_MAX = 32;
const CODE_FONT_SIZE_MIN = 10;

// JSON imports widen string unions, so the shipped defaults are asserted to match the schema.
const defaultConfig = defaultConfigTemplate as CodophonConfig;

const createDefaultConfig = (): CodophonConfig => ({
  keymap: { ...defaultConfig.keymap },
  settings: { ...defaultConfig.settings },
});

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

const normalizeTheme = (theme: unknown): CodophonTheme =>
  theme === 'system' || theme === 'light' || theme === 'dark' ? theme : 'system';

const normalizeDiffStyle = (diffStyle: unknown): CodophonDiffStyle =>
  diffStyle === 'split' || diffStyle === 'unified' ? diffStyle : 'split';

const normalizeSidebarPosition = (position: unknown): 'left' | 'right' =>
  position === 'right' ? 'right' : 'left';

const normalizeCodeFontFamily = (family: unknown): string =>
  typeof family === 'string' ? family.trim() : '';

const normalizeCodeFontSize = (size: unknown): number => {
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return CODE_FONT_SIZE_DEFAULT;
  }

  return Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(size)));
};

const normalizeLastRepositoryPath = (path: unknown) =>
  typeof path === 'string' && path.length > 0 ? path : '';

/**
 * Accept a single combo string or a non-empty list of combo strings.
 */
const normalizeKeyComboBinding = (
  binding: unknown,
  fallback: import('../core/config/types.ts').KeyComboBinding,
): import('../core/config/types.ts').KeyComboBinding => {
  if (typeof binding === 'string') {
    return binding;
  }
  if (
    Array.isArray(binding) &&
    binding.length > 0 &&
    binding.every((combo) => typeof combo === 'string')
  ) {
    return binding;
  }
  return fallback;
};

/**
 * Merge a partial config object on top of defaults.
 */
const mergeConfig = (raw: unknown): CodophonConfig => {
  const defaults = createDefaultConfig();

  if (typeof raw !== 'object' || raw === null) {
    return defaults;
  }

  const obj = raw as Record<string, unknown>;
  const rawSettings =
    typeof obj.settings === 'object' && obj.settings !== null
      ? (obj.settings as Record<string, unknown>)
      : {};
  const rawKeymap =
    typeof obj.keymap === 'object' && obj.keymap !== null
      ? (obj.keymap as Record<string, unknown>)
      : {};

  return {
    keymap: {
      askAgent:
        typeof rawKeymap.askAgent === 'string' ? rawKeymap.askAgent : defaults.keymap.askAgent,
      closeSearch:
        typeof rawKeymap.closeSearch === 'string'
          ? rawKeymap.closeSearch
          : defaults.keymap.closeSearch,
      commandBar: normalizeKeyComboBinding(rawKeymap.commandBar, defaults.keymap.commandBar),
      diffSearch:
        typeof rawKeymap.diffSearch === 'string'
          ? rawKeymap.diffSearch
          : defaults.keymap.diffSearch,
      discardComment:
        typeof rawKeymap.discardComment === 'string'
          ? rawKeymap.discardComment
          : defaults.keymap.discardComment,
      doneEditing:
        typeof rawKeymap.doneEditing === 'string'
          ? rawKeymap.doneEditing
          : defaults.keymap.doneEditing,
      editFile:
        typeof rawKeymap.editFile === 'string' ? rawKeymap.editFile : defaults.keymap.editFile,
      fileFilter:
        typeof rawKeymap.fileFilter === 'string'
          ? rawKeymap.fileFilter
          : defaults.keymap.fileFilter,
      nextHunk: normalizeKeyComboBinding(rawKeymap.nextHunk, defaults.keymap.nextHunk),
      nextSearchMatch:
        typeof rawKeymap.nextSearchMatch === 'string'
          ? rawKeymap.nextSearchMatch
          : defaults.keymap.nextSearchMatch,
      openFile:
        typeof rawKeymap.openFile === 'string' ? rawKeymap.openFile : defaults.keymap.openFile,
      prevHunk: normalizeKeyComboBinding(rawKeymap.prevHunk, defaults.keymap.prevHunk),
      prevSearchMatch:
        typeof rawKeymap.prevSearchMatch === 'string'
          ? rawKeymap.prevSearchMatch
          : defaults.keymap.prevSearchMatch,
      shortcutsHelp:
        typeof rawKeymap.shortcutsHelp === 'string'
          ? rawKeymap.shortcutsHelp
          : defaults.keymap.shortcutsHelp,
      submitComment:
        typeof rawKeymap.submitComment === 'string'
          ? rawKeymap.submitComment
          : defaults.keymap.submitComment,
      toggleSidebar:
        typeof rawKeymap.toggleSidebar === 'string'
          ? rawKeymap.toggleSidebar
          : defaults.keymap.toggleSidebar,
      toggleWordWrap:
        typeof rawKeymap.toggleWordWrap === 'string'
          ? rawKeymap.toggleWordWrap
          : defaults.keymap.toggleWordWrap,
    },
    settings: {
      agentPrompts: normalizeAgentPrompts(rawSettings.agentPrompts),
      agentBackend: normalizeAgentBackend(rawSettings.agentBackend),
      checkForUpdates:
        typeof rawSettings.checkForUpdates === 'boolean'
          ? rawSettings.checkForUpdates
          : defaults.settings.checkForUpdates,
      claudeModel:
        typeof rawSettings.claudeModel === 'string'
          ? rawSettings.claudeModel
          : defaults.settings.claudeModel,
      codeFontFamily: normalizeCodeFontFamily(rawSettings.codeFontFamily),
      codeFontSize: normalizeCodeFontSize(rawSettings.codeFontSize),
      copyCommentsOnClose:
        typeof rawSettings.copyCommentsOnClose === 'boolean'
          ? rawSettings.copyCommentsOnClose
          : defaults.settings.copyCommentsOnClose,
      diffStyle: normalizeDiffStyle(rawSettings.diffStyle),
      editorCommand:
        typeof rawSettings.editorCommand === 'string'
          ? rawSettings.editorCommand
          : defaults.settings.editorCommand,
      expandUnchanged:
        typeof rawSettings.expandUnchanged === 'boolean'
          ? rawSettings.expandUnchanged
          : defaults.settings.expandUnchanged,
      lastRepositoryPath: normalizeLastRepositoryPath(rawSettings.lastRepositoryPath),
      openAIModel:
        typeof rawSettings.openAIModel === 'string'
          ? rawSettings.openAIModel
          : defaults.settings.openAIModel,
      openAIReasoningEffort:
        typeof rawSettings.openAIReasoningEffort === 'string'
          ? rawSettings.openAIReasoningEffort.trim()
          : defaults.settings.openAIReasoningEffort,
      opencodeModel:
        typeof rawSettings.opencodeModel === 'string'
          ? rawSettings.opencodeModel
          : defaults.settings.opencodeModel,
      renderMarkdownAs: rawSettings.renderMarkdownAs === 'source' ? 'source' : 'preview',
      reviewCommentsPrefix:
        typeof rawSettings.reviewCommentsPrefix === 'string'
          ? rawSettings.reviewCommentsPrefix
          : defaults.settings.reviewCommentsPrefix,
      reviewTheme: rawSettings.reviewTheme === 'blue-amber' ? 'blue-amber' : 'neutral',
      sidebarPosition: normalizeSidebarPosition(rawSettings.sidebarPosition),
      showOutdated:
        typeof rawSettings.showOutdated === 'boolean'
          ? rawSettings.showOutdated
          : defaults.settings.showOutdated,
      showWhitespace:
        typeof rawSettings.showWhitespace === 'boolean'
          ? rawSettings.showWhitespace
          : defaults.settings.showWhitespace,
      theme: normalizeTheme(rawSettings.theme),
      walkthroughPrompt:
        typeof rawSettings.walkthroughPrompt === 'string'
          ? rawSettings.walkthroughPrompt
          : defaults.settings.walkthroughPrompt,
      wordWrap:
        typeof rawSettings.wordWrap === 'boolean'
          ? rawSettings.wordWrap
          : defaults.settings.wordWrap,
    },
  };
};

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
  normalizeCodeFontFamily,
  normalizeCodeFontSize,
  readConfig,
  watchConfig,
  writeConfig,
};
