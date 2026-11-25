import schema from './codophon-config.schema.json' with { type: 'json' };
import type { CodophonConfig } from './types.ts';

export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type Descriptor = {
  default?: unknown;
  enum?: ReadonlyArray<string>;
  maximum?: number;
  minimum?: number;
  properties?: Record<string, Descriptor>;
  type?: string;
};

// Each schema default determines the accepted primitive type. Nested objects use
// their declared properties and shortcut arrays also accept a single binding.
function readProperty(property: Descriptor, value: unknown): unknown {
  const fallback = property.default;
  if (property.properties && fallback === undefined) {
    const record = asRecord(value);
    return Object.fromEntries(
      Object.entries(property.properties).map(([key, child]) => [
        key,
        readProperty(child, record[key]),
      ]),
    );
  }
  if (Array.isArray(fallback)) {
    return typeof value === 'string' ||
      (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string'))
      ? value
      : [...fallback];
  }
  if (property.enum) {
    return typeof value === 'string' && property.enum.includes(value) ? value : fallback;
  }
  if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(
      property.maximum ?? Infinity,
      Math.max(property.minimum ?? -Infinity, Math.round(value)),
    );
  }
  if (typeof fallback === 'object') {
    return {};
  }
  return typeof value === typeof fallback && typeof value !== 'number' ? value : fallback;
}

export function readConfigProperties(raw?: unknown): CodophonConfig {
  const { keymap, settings } = asRecord(raw);
  return {
    keymap: readProperty(schema.properties.keymap, keymap) as CodophonConfig['keymap'],
    settings: readProperty(schema.properties.settings, settings) as CodophonConfig['settings'],
  };
}

export const createDefaultConfig = () => readConfigProperties();
const defaults = createDefaultConfig();
export const defaultSettings = Object.freeze(defaults.settings);
export const defaultKeymap = Object.freeze(defaults.keymap);
