/**
 * @vitest-environment jsdom
 */

import { act, useState } from 'react';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { AgentSettingsDialog } from '../app/components/AgentSettingsDialog.tsx';
import { useAppCommands } from '../app/hooks/useAppCommands.ts';
import { useAppKeyboardShortcuts } from '../app/hooks/useAppKeyboardShortcuts.ts';
import { createDefaultConfig, defaultKeymap } from '../config/defaults.ts';
import type { AgentModelCatalog } from '../config/types.ts';
import { createReviewCommandTarget } from '../lib/review-command-target.ts';
import type { RepositoryState } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, setInputValue } from './helpers/react.tsx';

afterEach(() => vi.unstubAllGlobals());

test('the model picker filters names and IDs and applies the exact provider-qualified ID', async () => {
  function Settings() {
    const [configuredModel, setConfiguredModel] = useState('opencode-default');
    selectAgentModel.mockImplementation(async (_agent, model) => setConfiguredModel(model));
    return (
      <AgentSettingsDialog
        backend="opencode"
        configuredModel={configuredModel}
        initialSection="models"
        onClose={vi.fn()}
        overrides={{}}
      />
    );
  }
  const selectAgentModel = vi.fn<(agent: string, model: string) => Promise<void>>();
  vi.stubGlobal('codophon', {
    getAgentModelCatalog: vi.fn().mockResolvedValue({
      models: [
        { id: 'github-copilot/sonnet', label: 'Claude Sonnet' },
        { id: 'github-copilot/haiku', label: 'Claude Haiku' },
      ],
    }),
    selectAgentModel,
  });
  await using view = await renderReact(<Settings />);
  const search = view.container.querySelector('input')!;
  await setInputValue(search, 'COPILOT sonnet');
  expect(view.container.textContent).not.toContain('Claude Haiku');
  const result = view.container.querySelector<HTMLButtonElement>('.agent-model-list button')!;
  await act(async () => result.click());
  expect(selectAgentModel).toHaveBeenCalledWith('opencode', 'github-copilot/sonnet');
  expect(result.getAttribute('aria-pressed')).toBe('true');
  expect(view.container.querySelector('.agent-settings-current-model code')?.textContent).toBe(
    'github-copilot/sonnet',
  );
});

test('the configured model is visible before discovery and stays visible if refresh fails', async () => {
  const { promise, resolve } = Promise.withResolvers<AgentModelCatalog>();
  const getAgentModelCatalog = vi
    .fn()
    .mockReturnValueOnce(promise)
    .mockRejectedValueOnce(new Error('Catalog unavailable'));
  vi.stubGlobal('codophon', { getAgentModelCatalog });
  const configuredModel = 'github-copilot/custom';
  await using view = await renderReact(
    <AgentSettingsDialog
      backend="opencode"
      configuredModel={configuredModel}
      initialSection="models"
      onClose={vi.fn()}
      overrides={{}}
    />,
  );
  const configured = () => view.container.querySelector('.agent-settings-current-model code');
  expect(configured()?.textContent).toBe(configuredModel);
  expect(view.container.textContent).toContain('Loading available models');
  expect(getAgentModelCatalog).toHaveBeenNthCalledWith(1, false);
  await act(async () =>
    resolve({ models: [{ id: configuredModel, label: 'Custom Copilot model' }] }),
  );
  const refresh = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Refresh',
  )!;
  await act(async () => refresh.click());
  expect(getAgentModelCatalog).toHaveBeenNthCalledWith(2, true);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Catalog unavailable');
  expect(configured()?.textContent).toBe(configuredModel);
});

test('the prompt editor shows, saves, and resets the walkthrough summary guidance', async () => {
  const defaults = 'Name the change.';
  const replacement = 'Explain the key tradeoff.';
  const setAgentPrompt = vi
    .fn()
    .mockResolvedValueOnce({ walkthroughSummary: replacement })
    .mockResolvedValueOnce({});
  vi.stubGlobal('codophon', {
    getAgentPrompts: vi
      .fn()
      .mockResolvedValue([
        { id: 'walkthroughSummary', label: 'Walkthrough summary', text: defaults },
      ]),
    setAgentPrompt,
  });
  await using view = await renderReact(
    <AgentSettingsDialog
      backend="opencode"
      configuredModel="opencode-default"
      initialSection="prompts"
      onClose={vi.fn()}
      overrides={{}}
    />,
  );
  const textarea = view.container.querySelector('textarea')!;
  const click = (label: string) =>
    act(async () =>
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === label)
        ?.click(),
    );
  expect(textarea.value).toBe(defaults);
  await setInputValue(textarea, replacement);
  await click('Save prompt');
  expect(setAgentPrompt).toHaveBeenNthCalledWith(1, 'walkthroughSummary', replacement);
  await click('Reset to default');
  expect(setAgentPrompt).toHaveBeenNthCalledWith(2, 'walkthroughSummary', null);
  expect(textarea.value).toBe(defaults);
});

type AppCommandsOptions = Parameters<typeof useAppCommands>[0];
type AppKeyboardShortcutsOptions = Parameters<typeof useAppKeyboardShortcuts>[0];
type AppKeyboardShortcutsState = ReturnType<typeof useAppKeyboardShortcuts>;

function AppCommandsHarness({
  onCommands,
  options,
}: {
  onCommands: (commands: ReturnType<typeof useAppCommands>) => void;
  options: AppCommandsOptions;
}) {
  const commands = useAppCommands(options);
  onCommands(commands);
  return null;
}

function AppKeyboardShortcutsHarness({
  onState,
  options,
}: {
  onState: (state: AppKeyboardShortcutsState) => void;
  options: AppKeyboardShortcutsOptions;
}) {
  const state = useAppKeyboardShortcuts(options);
  onState(state);
  return null;
}

test('app commands register the complete command set and delegate dynamic actions', async () => {
  const file = createChangedFile('src/app.ts');
  const source = { type: 'working-tree' } as const;
  const target = createReviewCommandTarget(source, file);
  const preferencesRef = {
    current: {
      ...createDefaultConfig().settings,
    },
  };
  const stateRef = {
    current: {
      branch: 'main',
      files: [file],
      generatedAt: 1,
      launchPath: '/repo',
      root: '/repo',
      source,
    } satisfies RepositoryState,
  };
  const viewedRef = {
    current: {
      [target.reviewIdentity.key]: target.reviewIdentity.fingerprint,
    },
  };
  const changeSidebarMode = vi.fn();
  const focusFileFilter = vi.fn();
  const getReviewCommandTarget = vi.fn(() => target);
  const onOpenDiffSearch = vi.fn();
  const onOpenReviewSource = vi.fn();
  const onOpenSelectedFile = vi.fn();
  const onOpenReviewBrief = vi.fn();
  const onOpenShortcutsHelp = vi.fn();
  const onRefreshRepository = vi.fn();
  const onSetReviewTheme = vi.fn();
  const onToggleSidebar = vi.fn();
  const onToggleViewed = vi.fn();
  const onToggleWordWrap = vi.fn();
  let commands: ReturnType<typeof useAppCommands> = [];
  await using _view = await renderReact(
    <AppCommandsHarness
      onCommands={(nextCommands) => (commands = nextCommands)}
      options={{
        changeSidebarMode,
        focusFileFilter,
        getRepository: () => stateRef.current,
        getReviewCommandTarget,
        getViewed: () => viewedRef.current,
        onOpenAskHistory: null,
        onOpenDiffSearch,
        onOpenReviewBrief,
        onOpenReviewSource,
        onOpenSelectedFile,
        onOpenShortcutsHelp,
        onRefreshRepository,
        onSetReviewTheme,
        onToggleSidebar,
        onToggleViewed,
        onToggleWordWrap,
        preferencesRef,
        reviewCommentsRef: { current: [] },
      }}
    />,
  );

  expect(commands.map((command) => command.id)).toEqual([
    'file-filter',
    'diff-search',
    'open-pull-request',
    'open-commit',
    'open-branch',
    'open-folder',
    'sidebar-tree',
    'sidebar-history',
    'sidebar-walkthrough',
    'copy-comments',
    'copy-review-brief',
    'copy-comments-and-close',
    'toggle-viewed',
    'edit-file',
    'open-file',
    'toggle-sidebar',
    'toggle-outdated-comments',
    'toggle-diff-layout',
    'toggle-word-wrap',
    'review-theme-neutral',
    'review-theme-blue-amber',
    'increase-code-font-size',
    'decrease-code-font-size',
    'reset-code-font-size',
    'open-config-file',
    'reload',
    'keyboard-shortcuts',
  ]);
  const command = (id: string) => {
    const match = commands.find((candidate) => candidate.id === id);
    if (!match) {
      throw new Error(`Missing command: ${id}`);
    }
    return match;
  };
  const updateSettings = vi.fn(async () => {});
  vi.stubGlobal('codophon', { updateSettings });
  for (const [commandName, action] of [
    ['Increase', 'increase'],
    ['Decrease', 'decrease'],
    ['Reset', 'reset'],
  ] as const) {
    const font = command(action + '-code-font-size');
    expect(font.title).toBe(commandName + ' Code Font Size');
    font.execute();
    expect(updateSettings).toHaveBeenLastCalledWith({ codeFontSize: action });
  }
  const editRequests = vi.fn();
  window.addEventListener('codophon:edit-selected-file', editRequests);
  command('edit-file').execute();
  window.removeEventListener('codophon:edit-selected-file', editRequests);
  expect(editRequests).toHaveBeenCalledOnce();
  expect(command('edit-file').keymapAction).toBe('editFile');

  command('file-filter').execute();
  command('diff-search').execute();
  command('open-pull-request').execute();
  command('open-commit').execute();
  command('open-branch').execute();
  command('sidebar-history').execute();
  command('open-file').execute();
  command('toggle-sidebar').execute();
  command('toggle-word-wrap').execute();
  command('reload').execute();
  command('copy-review-brief').execute();
  command('keyboard-shortcuts').execute();
  command('toggle-viewed').execute();
  expect(focusFileFilter).toHaveBeenCalledOnce();
  expect(onOpenDiffSearch).toHaveBeenCalledOnce();
  expect(onOpenReviewSource.mock.calls).toEqual([['pull-request'], ['commit'], ['branch']]);
  expect(changeSidebarMode).toHaveBeenCalledWith('history');
  expect(onOpenSelectedFile).toHaveBeenCalledOnce();
  expect(onToggleSidebar).toHaveBeenCalledOnce();
  expect(onToggleWordWrap).toHaveBeenCalledOnce();
  expect(onRefreshRepository).toHaveBeenCalledOnce();
  expect(onOpenReviewBrief).toHaveBeenCalledOnce();
  expect(onOpenShortcutsHelp).toHaveBeenCalledOnce();
  expect(command('open-file').description?.()).toBe(file.path);
  expect(onToggleViewed).toHaveBeenCalledWith(file, true, target.reviewIdentity);
  expect(command('toggle-word-wrap').description?.()).toBe('Enable Word Wrap');
  preferencesRef.current.wordWrap = true;
  expect(command('toggle-word-wrap').description?.()).toBe('Disable Word Wrap');
  expect(command('review-theme-neutral').description?.()).toBe('Selected');
  command('review-theme-neutral').execute();
  command('review-theme-blue-amber').execute();
  expect(onSetReviewTheme.mock.calls).toEqual([['neutral'], ['blue-amber']]);
  preferencesRef.current.reviewTheme = 'blue-amber';
  expect(command('review-theme-blue-amber').description?.()).toBe('Selected');
});

const keyboardKeymap = {
  ...defaultKeymap,
  commandBar: 'c',
  diffSearch: 'f',
  fileFilter: 'l',
  nextHunk: 'n',
  openFile: 'o',
  prevHunk: 'p',
  shortcutsHelp: '?',
  toggleSidebar: 'b',
  toggleWordWrap: 'z',
};

const noop = () => {};

const dispatchKey = (type: 'keydown' | 'keyup', key: string, target: EventTarget = window) => {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key,
  });
  target.dispatchEvent(event);
  return event;
};

test('app keyboard shortcuts route commands and respect native input and walkthrough guards', async () => {
  let deferHunkNavigation = true;
  const navigateHunks = vi.fn();
  const onFocusFileFilter = vi.fn();
  const onOpenDiffSearch = vi.fn();
  const onOpenSelectedFile = vi.fn();
  const onToggleSidebar = vi.fn();
  const onToggleWordWrap = vi.fn();
  let state: AppKeyboardShortcutsState | null = null;
  const getState = () => {
    if (!state) {
      throw new Error('Keyboard shortcuts did not render.');
    }
    return state;
  };
  await using _view = await renderReact(
    <AppKeyboardShortcutsHarness
      onState={(nextState) => (state = nextState)}
      options={{
        keymap: keyboardKeymap,
        navigateHunks,
        onFocusFileFilter,
        onOpenDiffSearch,
        onOpenSelectedFile,
        onToggleSidebar,
        onToggleWordWrap,
        shouldDeferHunkNavigation: () => deferHunkNavigation,
        sidebarCollapsed: true,
      }}
    />,
  );

  await act(async () => {
    expect(dispatchKey('keydown', 'c').defaultPrevented).toBe(true);
  });
  expect(getState().commandBarVisible).toBe(true);
  await act(async () => {
    getState().closeCommandBar();
    dispatchKey('keydown', 'b');
    dispatchKey('keydown', 'f');
    dispatchKey('keydown', 'o');
    dispatchKey('keydown', 'l');
    dispatchKey('keydown', 'n');
  });
  expect(getState().commandBarVisible).toBe(false);
  expect(onToggleSidebar).toHaveBeenCalledOnce();
  expect(onOpenDiffSearch).toHaveBeenCalledOnce();
  expect(onOpenSelectedFile).toHaveBeenCalledOnce();
  expect(onFocusFileFilter).toHaveBeenCalledOnce();
  expect(navigateHunks).not.toHaveBeenCalled();
  deferHunkNavigation = false;
  await act(async () => {
    dispatchKey('keydown', 'n');
    dispatchKey('keydown', 'p');
  });
  expect(navigateHunks.mock.calls).toEqual([[1], [-1]]);
  const input = document.createElement('input');
  document.body.append(input);
  await act(async () => {
    dispatchKey('keydown', 'z', input);
  });
  expect(onToggleWordWrap).not.toHaveBeenCalled();
  await act(async () => {
    dispatchKey('keydown', 'z');
  });
  expect(onToggleWordWrap).toHaveBeenCalledOnce();
  input.remove();
});

test('shortcut help remains visible only while its key chord is held', async () => {
  let state: AppKeyboardShortcutsState | null = null;
  const getState = () => {
    if (!state) {
      throw new Error('Keyboard shortcuts did not render.');
    }
    return state;
  };
  await using _view = await renderReact(
    <AppKeyboardShortcutsHarness
      onState={(nextState) => (state = nextState)}
      options={{
        keymap: keyboardKeymap,
        navigateHunks: noop,
        onFocusFileFilter: noop,
        onOpenDiffSearch: noop,
        onOpenSelectedFile: noop,
        onToggleSidebar: noop,
        onToggleWordWrap: noop,
        shouldDeferHunkNavigation: () => false,
        sidebarCollapsed: false,
      }}
    />,
  );

  await act(async () => {
    dispatchKey('keydown', '?');
  });
  expect(getState().shortcutsHelpVisible).toBe(true);
  await act(async () => {
    dispatchKey('keyup', '?');
  });
  expect(getState().shortcutsHelpVisible).toBe(false);
  await act(async () => {
    dispatchKey('keydown', '?');
    window.dispatchEvent(new Event('blur'));
  });
  expect(getState().shortcutsHelpVisible).toBe(false);
  await act(async () => getState().openShortcutsHelp());
  await act(async () => {
    dispatchKey('keyup', '?');
    window.dispatchEvent(new Event('blur'));
    dispatchKey('keydown', 'c');
  });
  expect(getState().shortcutsHelpOpen).toBe(true);
  expect(getState().commandBarVisible).toBe(false);
  await act(async () => getState().closeShortcutsHelp());
  expect(getState().shortcutsHelpVisible).toBe(false);
});
