import type { DesktopBridge } from './ipc.ts';

declare module '*.css';

declare global {
  interface Window {
    codophon: DesktopBridge;
  }
}
