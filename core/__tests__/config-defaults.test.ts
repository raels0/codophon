import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import {
  createDefaultConfig as createElectronDefaultConfig,
  readConfig,
  watchConfig,
  writeConfig,
} from '../../electron/config.ts';
import packageJson from '../../package.json' with { type: 'json' };
import schema from '../config/codophon-config.schema.json' with { type: 'json' };
import { createDefaultConfig } from '../config/defaults.ts';
import { createTemporaryDirectorySync, createTemporaryEnvironment } from './helpers/resources.ts';

const readElectronConfig = (raw: unknown) => {
  using home = createTemporaryDirectorySync('codophon-config-home.');
  using _environment = createTemporaryEnvironment({ HOME: home.path, USERPROFILE: home.path });
  const configDirectory = join(home.path, '.codophon');
  mkdirSync(configDirectory);
  writeFileSync(join(configDirectory, 'codophon.jsonc'), `${JSON.stringify(raw)}\n`);
  return readConfig();
};

const readElectronConfigText = (text: string) => {
  using home = createTemporaryDirectorySync('codophon-config-home.');
  using _environment = createTemporaryEnvironment({ HOME: home.path, USERPROFILE: home.path });
  const configDirectory = join(home.path, '.codophon');
  mkdirSync(configDirectory);
  writeFileSync(join(configDirectory, 'codophon.jsonc'), text);
  return readConfig();
};

const getSchemaDefaults = (section: 'keymap' | 'settings') =>
  Object.fromEntries(
    Object.entries(schema.properties[section].properties).map(([key, property]) => [
      key,
      property.default,
    ]),
  );

test('schema defaults match config defaults', () => {
  const defaults = createDefaultConfig();

  expect(getSchemaDefaults('settings')).toEqual(defaults.settings);
  expect(getSchemaDefaults('keymap')).toEqual(defaults.keymap);
});

test('electron and renderer defaults match', () => {
  expect(createElectronDefaultConfig()).toEqual(createDefaultConfig());
});

test('prompt overrides persist independently of legacy guidance and can be reset', () => {
  using home = createTemporaryDirectorySync('codophon-agent-prompts.');
  using _environment = createTemporaryEnvironment({ HOME: home.path, USERPROFILE: home.path });
  const config = createDefaultConfig();
  config.settings.agentPrompts = {
    ask: '  Answer briefly.  ',
    walkthroughSummary: 'Name the risk.',
  };
  config.settings.walkthroughPrompt = 'Use Japanese.';
  writeConfig(config);
  const saved = readConfig();
  expect(saved.settings.agentPrompts).toEqual({
    ask: 'Answer briefly.',
    walkthroughSummary: 'Name the risk.',
  });
  delete saved.settings.agentPrompts.ask;
  writeConfig(saved);
  expect(readConfig().settings).toMatchObject({
    agentPrompts: { walkthroughSummary: 'Name the risk.' },
    walkthroughPrompt: 'Use Japanese.',
  });
  expect(readConfig().settings.agentPrompts.ask).toBeUndefined();
  expect(
    readElectronConfig({
      settings: { agentPrompts: { ask: ' ', unknown: 'ignored', walkthroughTitles: 9 } },
    }).settings.agentPrompts,
  ).toEqual({});
});

test('command palette bindings accept aliases and retain custom single shortcuts', () => {
  const aliases = ['Mod+Shift+p', 'Mod+k'];
  expect(readElectronConfig({ keymap: { commandBar: aliases } }).keymap.commandBar).toEqual(
    aliases,
  );
  expect(readElectronConfig({ keymap: { commandBar: 'Alt+c' } }).keymap.commandBar).toBe('Alt+c');
  expect(readElectronConfig({ keymap: { commandBar: ['Mod+p', 42] } }).keymap.commandBar).toEqual(
    createDefaultConfig().keymap.commandBar,
  );
});

test('electron config normalizes code font settings', () => {
  expect(readElectronConfig({}).settings.codeFontFamily).toBe('');
  expect(readElectronConfig({}).settings.codeFontSize).toBe(13);

  expect(
    readElectronConfig({
      settings: {
        codeFontFamily: '  JetBrains Mono  ',
        codeFontSize: 14.6,
      },
    }).settings,
  ).toMatchObject({
    codeFontFamily: 'JetBrains Mono',
    codeFontSize: 15,
  });

  expect(
    readElectronConfig({ settings: { codeFontFamily: 42, codeFontSize: 'large' } }).settings,
  ).toMatchObject({
    codeFontFamily: '',
    codeFontSize: 13,
  });
  expect(readElectronConfig({ settings: { codeFontSize: 8 } }).settings.codeFontSize).toBe(10);
  expect(readElectronConfig({ settings: { codeFontSize: 99 } }).settings.codeFontSize).toBe(32);
});

test('old and invalid review themes use the neutral preset', () => {
  expect(readElectronConfig({}).settings.reviewTheme).toBe('neutral');
  for (const reviewTheme of ['classic', null, 42]) {
    expect(readElectronConfig({ settings: { reviewTheme } }).settings.reviewTheme).toBe('neutral');
  }
});

test.each(['neutral', 'blue-amber'] as const)(
  'review theme %s survives save and reload',
  (reviewTheme) => {
    using home = createTemporaryDirectorySync('codophon-review-theme.');
    using _environment = createTemporaryEnvironment({ HOME: home.path, USERPROFILE: home.path });
    const config = createDefaultConfig();
    config.settings.reviewTheme = reviewTheme;
    config.settings.theme = 'dark';
    writeConfig(config);
    expect(readConfig().settings).toMatchObject({ reviewTheme, theme: 'dark' });
  },
);

test('electron config normalizes sidebar position', () => {
  expect(readElectronConfig({}).settings.sidebarPosition).toBe('left');
  expect(
    readElectronConfig({ settings: { sidebarPosition: 'right' } }).settings.sidebarPosition,
  ).toBe('right');
  expect(
    readElectronConfig({ settings: { sidebarPosition: 'bottom' } }).settings.sidebarPosition,
  ).toBe('left');
});

test('old configurations retain automatic reasoning and custom values survive save and reload', async () => {
  expect(readElectronConfig({}).settings.openAIReasoningEffort).toBe('');
  expect(
    readElectronConfig({ settings: { openAIReasoningEffort: 42 } }).settings.openAIReasoningEffort,
  ).toBe('');
  using home = createTemporaryDirectorySync('codophon-model-config.');
  using _environment = createTemporaryEnvironment({ HOME: home.path, USERPROFILE: home.path });
  const configDirectory = join(home.path, '.codophon');
  mkdirSync(configDirectory);
  writeFileSync(
    join(configDirectory, 'codophon.jsonc'),
    JSON.stringify({ settings: { openAIModel: 'gpt-6.1-sol', openAIReasoningEffort: ' high ' } }),
  );
  const config = readConfig();
  expect(config.settings).toMatchObject({
    openAIModel: 'gpt-6.1-sol',
    openAIReasoningEffort: 'high',
  });
  let reloaded: ReturnType<typeof createDefaultConfig> | undefined;
  const stop = watchConfig((next) => {
    reloaded = next;
  });
  try {
    // macOS FSEvents subscribes asynchronously and has no ready signal, so a write made the
    // instant the watcher starts can be missed. Real config edits never race startup like this.
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    writeConfig({ ...config, settings: { ...config.settings, openAIReasoningEffort: 'ultra' } });
    expect(readConfig().settings).toMatchObject({
      openAIModel: 'gpt-6.1-sol',
      openAIReasoningEffort: 'ultra',
    });
    await vi.waitFor(
      () =>
        expect(reloaded?.settings).toMatchObject({
          openAIModel: 'gpt-6.1-sol',
          openAIReasoningEffort: 'ultra',
        }),
      { timeout: 5000 },
    );
  } finally {
    stop();
  }
});

test('electron config keeps custom walkthrough prompt text only when it is a string', () => {
  expect(
    readElectronConfig({
      settings: {
        walkthroughPrompt: 'Respond in German with product-review terminology.',
      },
    }).settings.walkthroughPrompt,
  ).toBe('Respond in German with product-review terminology.');

  expect(
    readElectronConfig({
      settings: {
        walkthroughPrompt: ['Respond in German'],
      },
    }).settings.walkthroughPrompt,
  ).toBe('');
});

test('electron config strips trailing commas without changing strings', () => {
  const config = readElectronConfigText(`{
    // JSONC comments and trailing commas remain supported.
    "settings": {
      "walkthroughPrompt": "Preserve comma,} and comma,] with an escaped quote: \\"",
      "wordWrap": false,
    },
    "keymap": {
      "nextHunk": ["j", "n",],
    },
  }`);

  expect(config.settings.walkthroughPrompt).toBe(
    'Preserve comma,} and comma,] with an escaped quote: "',
  );
  expect(config.settings.wordWrap).toBe(false);
  expect(config.keymap.nextHunk).toEqual(['j', 'n']);
});

const forgeConfig = createRequire(import.meta.url)('../../forge.config.cjs') as {
  hooks: { packageAfterCopy: (config: unknown, buildPath: string) => Promise<void> };
};

test('electron defaults load from packaged app shape', async () => {
  using directory = createTemporaryDirectorySync('codophon-package-shape.');
  const packageRoot = directory.path;
  mkdirSync(join(packageRoot, 'config'));
  mkdirSync(join(packageRoot, 'electron'));
  writeFileSync(join(packageRoot, 'package.json'), '{"type":"module"}');
  copyFileSync('config/defaults.json', join(packageRoot, 'config/defaults.json'));
  copyFileSync('electron/config.ts', join(packageRoot, 'electron/config.ts'));
  copyFileSync('electron/agent-prompts.ts', join(packageRoot, 'electron/agent-prompts.ts'));
  await forgeConfig.hooks.packageAfterCopy({}, packageRoot);

  const packaged = (await import(
    join(packageRoot, 'electron/config.ts')
  )) as typeof import('../../electron/config.ts');
  expect(packaged.createDefaultConfig()).toEqual(createDefaultConfig());
});

test('npm package includes runtime config and bundled skills', () => {
  expect(packageJson.files).toContain('config');
  expect(packageJson.files).toContain('skills');
});
