export type CodophonDiffStyle = 'split' | 'unified';
export type CodophonTheme = 'system' | 'light' | 'dark';
export type CodophonReviewTheme = 'neutral' | 'blue-amber';
export type { AgentBackend as CodophonAgentBackend } from './agents.ts';
import type { AgentBackend as CodophonAgentBackend } from './agents.ts';

export type AgentPromptId =
  | 'walkthrough'
  | 'ask'
  | 'commitMessage'
  | 'walkthroughDesign'
  | 'walkthroughRevision'
  | 'walkthroughStops'
  | 'walkthroughSummary'
  | 'walkthroughTitles';
export type AgentPromptOverrides = Partial<Record<AgentPromptId, string>>;
export type AgentPromptModule = { id: AgentPromptId; label: string; text: string };
export type AgentSettingsSection = 'models' | 'prompts';
export type AgentModelCatalog = {
  models: ReadonlyArray<{ id: string; label: string }>;
  note?: string;
};

type Schema = typeof import('./codophon-config.schema.json');
type SettingDescriptors = Schema['properties']['settings']['properties'];
type PrimitiveSettings = {
  [
    K in keyof SettingDescriptors as SettingDescriptors[K] extends {
      default: string | boolean | number;
    }
      ? K
      : never
  ]: SettingDescriptors[K] extends { default: infer V } ? V : never;
};
type ChoiceSettings = {
  agentBackend: CodophonAgentBackend;
  diffStyle: CodophonDiffStyle;
  renderMarkdownAs: 'preview' | 'source';
  reviewTheme: CodophonReviewTheme;
  sidebarPosition: 'left' | 'right';
  theme: CodophonTheme;
};
export type CodophonSettings = Omit<PrimitiveSettings, keyof ChoiceSettings> &
  ChoiceSettings & {
    agentPrompts: AgentPromptOverrides;
    agents: { [K in CodophonAgentBackend]: { model: string } } & {
      codex: { model: string; reasoningEffort: string };
    };
  };

export type SettingsPatch = Partial<
  Pick<CodophonSettings, 'diffStyle' | 'reviewTheme' | 'showOutdated' | 'wordWrap'>
> & {
  codeFontSize?: 'increase' | 'decrease' | 'reset';
};

export type KeyCombo = string;

// A shortcut can be a single combo or a list of aliases that all trigger the action.
export type KeyComboBinding = KeyCombo | ReadonlyArray<KeyCombo>;

type KeyDescriptors = Schema['properties']['keymap']['properties'];
export type CodophonKeymap = {
  [K in keyof KeyDescriptors]: KeyDescriptors[K] extends { oneOf: unknown }
    ? KeyComboBinding
    : KeyCombo;
};

export type CodophonConfig = {
  keymap: CodophonKeymap;
  settings: CodophonSettings;
};
