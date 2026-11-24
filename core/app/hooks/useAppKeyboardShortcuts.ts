import { useCallback, useEffect, useState } from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodophonKeymap } from '../../config/types.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';

type UseAppKeyboardShortcutsOptions = {
  keymap: CodophonKeymap;
  navigateHunks: (direction: 1 | -1) => void;
  onFocusFileFilter: () => void;
  onOpenDiffSearch: () => void;
  onOpenSelectedFile: () => void;
  onToggleSidebar: () => void;
  onToggleWordWrap: () => void;
  shouldDeferHunkNavigation: () => boolean;
  sidebarCollapsed: boolean;
};

export function useAppKeyboardShortcuts({
  keymap,
  navigateHunks,
  onFocusFileFilter,
  onOpenDiffSearch,
  onOpenSelectedFile,
  onToggleSidebar,
  onToggleWordWrap,
  shouldDeferHunkNavigation,
  sidebarCollapsed,
}: UseAppKeyboardShortcutsOptions) {
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const [shortcutsHelp, setShortcutsHelp] = useState<'held' | 'open' | null>(null);
  const openCommandBar = useCallback(() => setCommandBarVisible(true), []);
  const closeCommandBar = useCallback(() => setCommandBarVisible(false), []);
  const openShortcutsHelp = useCallback(() => setShortcutsHelp('open'), []);
  const closeShortcutsHelp = useCallback(() => setShortcutsHelp(null), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutsHelp === 'open') {
        return;
      }
      if (matchesShortcut(event, keymap, 'commandBar')) {
        event.preventDefault();
        setCommandBarVisible((current) => !current);
        return;
      }
      if (matchesShortcut(event, keymap, 'toggleSidebar')) {
        event.preventDefault();
        onToggleSidebar();
        return;
      }
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'toggleWordWrap')) {
        event.preventDefault();
        onToggleWordWrap();
        return;
      }
      if (matchesShortcut(event, keymap, 'diffSearch')) {
        event.preventDefault();
        onOpenDiffSearch();
        return;
      }
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'openFile')) {
        event.preventDefault();
        onOpenSelectedFile();
        return;
      }
      if (!isNativeInputTarget(event.target)) {
        if (
          shouldDeferHunkNavigation() &&
          (matchesShortcut(event, keymap, 'nextHunk') || matchesShortcut(event, keymap, 'prevHunk'))
        ) {
          return;
        }
        if (matchesShortcut(event, keymap, 'nextHunk')) {
          event.preventDefault();
          navigateHunks(1);
          return;
        }
        if (matchesShortcut(event, keymap, 'prevHunk')) {
          event.preventDefault();
          navigateHunks(-1);
          return;
        }
      }
      if (sidebarCollapsed && matchesShortcut(event, keymap, 'fileFilter')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onFocusFileFilter();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    keymap,
    navigateHunks,
    onFocusFileFilter,
    onOpenDiffSearch,
    onOpenSelectedFile,
    onToggleSidebar,
    onToggleWordWrap,
    shouldDeferHunkNavigation,
    shortcutsHelp,
    sidebarCollapsed,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isNativeInputTarget(event.target)) {
        return;
      }
      if (matchesShortcut(event, keymap, 'shortcutsHelp')) {
        event.preventDefault();
        setShortcutsHelp((current) => current ?? 'held');
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === '?' || event.key === '/' || event.key === 'Shift') {
        dismissHeldHelp();
      }
    };

    const dismissHeldHelp = () =>
      setShortcutsHelp((current) => (current === 'held' ? null : current));

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', dismissHeldHelp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', dismissHeldHelp);
    };
  }, [keymap]);

  return {
    closeCommandBar,
    closeShortcutsHelp,
    commandBarVisible,
    openCommandBar,
    openShortcutsHelp,
    shortcutsHelpOpen: shortcutsHelp === 'open',
    shortcutsHelpVisible: shortcutsHelp != null,
  };
}
