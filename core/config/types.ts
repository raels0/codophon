export type CodophonDiffStyle = 'split' | 'unified';
export type CodophonTheme = 'system' | 'light' | 'dark';
export type CodophonReviewTheme = 'neutral' | 'blue-amber';
export type { AgentBackend as CodophonAgentBackend } from './agents.ts';
import type { AgentBackend as CodophonAgentBackend } from './agents.ts';

export type AgentPromptId =
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

export type CodophonSettings = {
  agentBackend: CodophonAgentBackend;
  agentPrompts: AgentPromptOverrides;
  checkForUpdates: boolean;
  claudeModel: string;
  codeFontFamily: string;
  codeFontSize: number;
  copyCommentsOnClose: boolean;
  diffStyle: CodophonDiffStyle;
  editorCommand: string;
  expandUnchanged: boolean;
  lastRepositoryPath: string;
  openAIModel: string;
  openAIReasoningEffort: string;
  opencodeModel: string;
  renderMarkdownAs: 'preview' | 'source';
  reviewCommentsPrefix: string;
  reviewTheme: CodophonReviewTheme;
  showOutdated: boolean;
  showWhitespace: boolean;
  sidebarPosition: 'left' | 'right';
  theme: CodophonTheme;
  walkthroughPrompt: string;
  wordWrap: boolean;
};

export type KeyCombo = string;

// A shortcut can be a single combo or a list of aliases that all trigger the action.
export type KeyComboBinding = KeyCombo | ReadonlyArray<KeyCombo>;

export type CodophonKeymap = {
  askAgent: KeyCombo;
  closeSearch: KeyCombo;
  commandBar: KeyComboBinding;
  diffSearch: KeyCombo;
  discardComment: KeyCombo;
  doneEditing: KeyCombo;
  editFile: KeyCombo;
  fileFilter: KeyCombo;
  nextHunk: KeyComboBinding;
  nextSearchMatch: KeyCombo;
  openFile: KeyCombo;
  prevHunk: KeyComboBinding;
  prevSearchMatch: KeyCombo;
  shortcutsHelp: KeyCombo;
  submitComment: KeyCombo;
  toggleSidebar: KeyCombo;
  toggleWordWrap: KeyCombo;
};

export type CodophonConfig = {
  keymap: CodophonKeymap;
  settings: CodophonSettings;
};
