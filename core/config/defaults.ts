import defaults from '../../config/defaults.json' with { type: 'json' };
import type { CodophonConfig, CodophonKeymap, CodophonSettings } from './types.ts';

// TypeScript widens values imported from JSON, so it cannot know that
// "split" is a valid CodophonDiffStyle or "system" is a valid CodophonTheme.
// We keep defaults in JSON so Electron and the renderer share one source.
// If config gets deeper or more complex, replace this cast with runtime
// validation or a typed source that generates the CJS shape.
const defaultConfigTemplate = defaults as CodophonConfig;

export const createDefaultConfig = (): CodophonConfig => ({
  keymap: { ...defaultConfigTemplate.keymap },
  settings: { ...defaultConfigTemplate.settings },
});

export const defaultKeymap: Readonly<CodophonKeymap> = Object.freeze({
  ...defaultConfigTemplate.keymap,
});
export const defaultSettings: Readonly<CodophonSettings> = Object.freeze({
  ...defaultConfigTemplate.settings,
});
