import { defineConfig } from '@playwright/test';

// End-to-end flows drive the real Electron app (see e2e/harness.ts). Each test gets its own
// HOME, so tests never share config or window state. Concurrent Electron launches on macOS
// crash during startup, so flows run one at a time.
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  retries: process.env.CI ? 1 : 0,
  testDir: 'e2e',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
  workers: 1,
});
