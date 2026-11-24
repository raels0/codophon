import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  _electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { LaunchRequest } from '../electron/main/launch-request.cjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { encodeLaunchRequest } = require('../electron/main/launch-request.cjs') as {
  encodeLaunchRequest: (request: LaunchRequest) => string;
};

const gitEnvironment = {
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export type Files = Record<string, string | null>;

/** A throwaway Git repository. `null` file contents delete the file. */
export class Repo {
  constructor(readonly path: string) {}

  git(...args: Array<string>) {
    return execFileSync('git', ['-C', this.path, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...gitEnvironment },
    }).trim();
  }

  write(files: Files) {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(this.path, path);
      if (contents == null) {
        rmSync(absolute, { force: true });
      } else {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, contents);
      }
    }
  }

  commit(message: string, files: Files) {
    this.write(files);
    this.git('add', '-A');
    this.git('commit', '-qm', message);
    return this.git('rev-parse', 'HEAD');
  }
}

export class Codophon {
  private constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
  ) {}

  static async launch(home: string, request: LaunchRequest, env: Record<string, string> = {}) {
    const app = await _electron.launch({
      args: [root, encodeLaunchRequest(request)],
      cwd: root,
      env: {
        ...(process.env as Record<string, string>),
        ELECTRON_RENDERER_URL: '',
        HOME: home,
        SHELL: '/bin/sh',
        ...env,
      },
    });
    const page = await app.firstWindow();
    await page.locator('.codiff-file-header, .empty-state, .walkthrough').first().waitFor();
    return new Codophon(app, page);
  }

  /** The diff card for a file. */
  file(path: string) {
    return this.page.locator('.codiff-file-header', { hasText: path });
  }

  /** The sidebar tree row for a file, by repository path. */
  treeRow(path: string) {
    return this.page.locator(`file-tree-container [data-item-path="${path}"]`);
  }

  /** The Viewed toggle in a file's diff header. */
  viewedToggle(path: string) {
    return this.file(path).getByRole('button', { name: 'Viewed' });
  }

  /** The position of a file among the rendered diffs, in review order. */
  async fileIndex(path: string) {
    const headers = await this.page
      .locator('.codiff-file-header:not(.codiff-source-description-header) .codiff-file-path')
      .allTextContents();
    const index = headers.findIndex((text) => text.trim() === path);
    if (index === -1) {
      throw new Error(`No diff header for ${path}; found ${headers.join(', ')}`);
    }
    return index;
  }

  /** Hover an added line and click its gutter "+" to start a comment there. */
  async startCommentOnLine(path: string, lineNumber: number) {
    const diff = this.page.locator('diffs-container').nth(await this.fileIndex(path));
    const line = diff.locator(`[data-line="${lineNumber}"][data-line-type="change-addition"]`);
    const add = diff.locator('button[data-utility-button]');
    // The gutter button appears on hover; re-hover if a layout pass moved the line away.
    await expect(async () => {
      await line.hover();
      await add.click({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    // Posted comments on the same line render read-only with the same label.
    await this.page
      .getByRole('textbox', { name: new RegExp(`Comment on ${path}`) })
      .and(this.page.locator('[contenteditable="true"]'))
      .click();
  }

  /** Text of the rendered diff, across the shadow roots the diff viewer uses. */
  async diffText() {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('diffs-container')]
        .map((host) => host.shadowRoot?.textContent ?? '')
        .join('\n'),
    );
  }

  async clipboard() {
    return this.app.evaluate(({ clipboard }) => clipboard.readText());
  }

  close() {
    return this.app.close();
  }
}

/** Configure the fake Claude Code CLI as the agent; returns the env and its call log. */
export const useFakeAgent = (home: string) => {
  const log = join(home, 'fake-agent.jsonl');
  mkdirSync(join(home, '.codiff'), { recursive: true });
  writeFileSync(
    join(home, '.codiff/codiff.jsonc'),
    JSON.stringify({ settings: { agentBackend: 'claude' } }),
  );
  writeFileSync(log, '');
  return {
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: Array<string>; prompt: string }),
    env: { CODIFF_CLAUDE_PATH: join(root, 'e2e/fake-agent.mjs'), FAKE_AGENT_LOG: log },
  };
};

type Fixtures = { home: string; repo: Repo; workspace: string };

export const test = base.extend<Fixtures>({
  home: async ({ workspace }, provide) => {
    const home = join(workspace, 'home');
    mkdirSync(home);
    await provide(home);
  },
  repo: async ({ workspace }, provide) => {
    const repo = new Repo(join(workspace, 'repo'));
    mkdirSync(repo.path);
    repo.git('init', '-q', '-b', 'main');
    await provide(repo);
  },
  // eslint-disable-next-line no-empty-pattern
  workspace: async ({}, provide) => {
    if (!existsSync(join(root, 'dist/index.html'))) {
      throw new Error('Build the renderer first: vp build');
    }
    const workspace = mkdtempSync(join(tmpdir(), 'codophon-e2e-'));
    await provide(workspace);
    rmSync(workspace, { force: true, recursive: true });
  },
});

export { expect } from '@playwright/test';
