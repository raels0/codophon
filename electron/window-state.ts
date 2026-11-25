import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 320;
const MIN_OVERLAP = 100;

const getDefaultConfigDir = () => join(homedir(), '.codophon');

export type WindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
};

const parseWindowState = (raw: unknown): WindowState | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const { x, y, width, height, isMaximized, isFullScreen } = obj;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_WINDOW_WIDTH ||
    height < MIN_WINDOW_HEIGHT
  ) {
    return null;
  }

  return {
    height,
    isFullScreen: typeof isFullScreen === 'boolean' ? isFullScreen : false,
    isMaximized: typeof isMaximized === 'boolean' ? isMaximized : false,
    width,
    x,
    y,
  };
};

const readWindowState = (configDir?: string): WindowState | null => {
  const filePath = join(configDir ?? getDefaultConfigDir(), 'window-state.json');

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return parseWindowState(raw);
  } catch {
    return null;
  }
};

const writeWindowState = (state: WindowState, configDir?: string) => {
  const dir = configDir ?? getDefaultConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(dir, 'window-state.json'), JSON.stringify(state, null, 2) + '\n');
};

const validateWindowStateOnScreen = (
  state: WindowState,
  displays: ReadonlyArray<{ workArea: { x: number; y: number; width: number; height: number } }>,
): WindowState | null => {
  for (const display of displays) {
    const { workArea } = display;
    const overlapX = Math.max(
      0,
      Math.min(state.x + state.width, workArea.x + workArea.width) - Math.max(state.x, workArea.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(state.y + state.height, workArea.y + workArea.height) -
        Math.max(state.y, workArea.y),
    );

    if (overlapX >= MIN_OVERLAP && overlapY >= MIN_OVERLAP) {
      return state;
    }
  }

  return null;
};

export {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
};
