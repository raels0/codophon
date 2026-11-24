// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { copyFile, mkdir } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

const electronCachePath = process.env.ELECTRON_CACHE || join(__dirname, '.cache/electron');
const entitlementsPath = join(__dirname, 'electron/entitlements.plist');
const iconPath = existsSync(join(__dirname, 'electron/icons/icon.icns'))
  ? './electron/icons/icon'
  : undefined;
const walkthroughDiffRuntimePath = 'core/lib/narrative-walkthrough-diff.js';
const osxNotarize =
  process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
        tool: 'notarytool',
      }
    : undefined;

/**
 * @typedef {import('@electron-forge/shared-types').ForgeArch} ForgeArch
 * @typedef {import('@electron-forge/shared-types').ForgeConfig} ForgeConfig
 * @typedef {import('@electron-forge/shared-types').ForgePlatform} ForgePlatform
 * @typedef {Omit<import('@electron-forge/shared-types').ForgePackagerOptions, 'osxNotarize' | 'osxSign'> & {
 *   osxNotarize?: Record<string, unknown>;
 *   osxSign?: Record<string, unknown>;
 * }} CodophonPackagerConfig
 * @typedef {{
 *   arch?: Array<ForgeArch>;
 *   config?: Record<string, unknown>;
 *   enabled?: boolean;
 *   name: string;
 *   platforms?: Array<ForgePlatform> | null;
 * }} CodophonMakerConfig
 * @typedef {Omit<ForgeConfig, 'makers' | 'packagerConfig'> & {
 *   makers: Array<CodophonMakerConfig>;
 *   packagerConfig: CodophonPackagerConfig;
 * }} CodophonForgeConfig
 */

/** @type {CodophonForgeConfig} */
module.exports = {
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const source = join(__dirname, walkthroughDiffRuntimePath);
      const destination = join(buildPath, walkthroughDiffRuntimePath);

      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    },
  },
  makers: [
    {
      arch: ['arm64'],
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
  packagerConfig: {
    appBundleId: 'com.github.raels0.codophon',
    appCopyright: 'Copyright (c) 2026 Nakazawa Tech and Codophon contributors',
    asar: false,
    download: {
      cacheRoot: electronCachePath,
    },
    executableName: 'codophon',
    ...(iconPath ? { icon: iconPath } : {}),
    ignore: [
      /^\/\.DS_Store$/,
      /^\/\.cache(?:$|\/)/,
      /^\/\.enum_manifest\.json$/,
      /^\/\.env(?:$|[.])/,
      /^\/\.git(?:$|\/)/,
      /^\/\.gitignore$/,
      /^\/\.github(?:$|\/)/,
      /^\/\.vite-hooks(?:$|\/)/,
      /^\/\.vscode(?:$|\/)/,
      /^\/README\.md$/,
      /^\/e2e(?:$|\/)/,
      /^\/test-results(?:$|\/)/,
      /^\/playwright/,
      /\/__tests__(?:$|\/)/,
      /^\/coverage(?:$|\/)/,
      /^\/docs(?:$|\/)/,
      /^\/forge\.config\.cjs$/,
      /^\/index\.html$/,
      /^\/out(?:$|\/)/,
      /^\/pnpm-workspace\.yaml$/,
      /^\/public(?:$|\/)/,
      /^\/core(?:$|\/)/,
      /^\/tsconfig/,
      /^\/vite\.config\./,
    ],
    name: 'Codophon',
    ...(osxNotarize ? { osxNotarize } : {}),
    osxSign:
      process.env.CODOPHON_UNSIGNED_BUILD === '1'
        ? undefined
        : {
            continueOnError: false,
            hardenedRuntime: true,
            identity: process.env.APPLE_SIGNING_IDENTITY,
            optionsForFile: () => ({
              entitlements: entitlementsPath,
            }),
          },
    protocols: [
      {
        name: 'Codophon',
        schemes: ['codophon'],
      },
    ],
  },
  rebuildConfig: {},
};
