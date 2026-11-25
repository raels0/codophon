import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codophon, expect, test } from './harness.ts';

/** A minimal macOS app whose launcher records that it was started. */
const createMacApp = (parent: string, version: string) => {
  const app = join(parent, 'Codophon.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Codophon</string>
  <key>CFBundleIdentifier</key><string>com.github.raels0.codophon.e2e-${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  writeFileSync(join(app, 'Contents', 'Resources', 'version'), version);
  writeFileSync(
    join(app, 'Contents', 'MacOS', 'Codophon'),
    '#!/bin/sh\necho launched > "$0.launched"\n',
    {
      mode: 0o755,
    },
  );
  return app;
};

test.skip(process.platform !== 'darwin', 'Installs a macOS app bundle');

test('an available update downloads, installs on restart, and relaunches the new build', async ({
  home,
  repo,
}) => {
  repo.commit('init', { 'math.ts': 'export const add = 1;\n' });

  const root = mkdtempSync(join(tmpdir(), 'codophon-update-e2e-'));
  const installed = createMacApp(join(root, 'Applications'), '0.0.1');
  const zipPath = join(root, 'release.zip');
  execFileSync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    createMacApp(join(root, 'build'), '99.0.0'),
    zipPath,
  ]);
  const zip = readFileSync(zipPath);
  const server = createServer((request, response) => {
    if (request.url !== '/latest') {
      response.end(zip);
      return;
    }
    const { port } = server.address() as AddressInfo;
    response.end(
      JSON.stringify({
        assets: [
          {
            browser_download_url: `http://127.0.0.1:${port}/zip`,
            digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`,
            name: `Codophon-darwin-${process.arch}-99.0.0.zip`,
            size: zip.length,
          },
        ],
        tag_name: 'v99.0.0',
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const app = await Codophon.launch(
    home,
    { repositoryPath: repo.path },
    {
      CODOPHON_UPDATE_FEED: `http://127.0.0.1:${port}/latest`,
      CODOPHON_UPDATE_TARGET: installed,
    },
  );
  try {
    await app.page.keyboard.press('ControlOrMeta+k');
    await app.page.keyboard.type('check for updates');
    await app.page.keyboard.press('Enter');

    const restart = app.page.getByRole('button', { name: 'Restart to update' });
    await expect(restart).toBeVisible({ timeout: 20_000 });
    const exited = once(app.app.process(), 'exit');
    await restart.click();
    await exited;

    await expect
      .poll(() => readFileSync(join(installed, 'Contents', 'Resources', 'version'), 'utf8'), {
        timeout: 15_000,
      })
      .toBe('99.0.0');
    await expect
      .poll(() => existsSync(join(installed, 'Contents', 'MacOS', 'Codophon.launched')), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(existsSync(`${installed}.previous`)).toBe(false);
  } finally {
    server.close();
    await app.close().catch(() => {});
  }
});
