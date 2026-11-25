// @ts-check
/// <reference types="node" />

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');

const packagePath = resolve(process.argv[2]);
const expectedArch = process.argv[3];
assert.ok(['arm64', 'x64'].includes(expectedArch), 'Specify the expected Windows architecture.');
assert.equal(process.platform, 'win32');
assert.equal(
  process.arch,
  expectedArch,
  'The packaged Electron runtime has the wrong architecture.',
);

const appRequire = createRequire(join(packagePath, 'resources', 'app', 'package.json'));
const keymap = appRequire('native-keymap/build/Release/keymapping.node');
assert.ok(
  Object.keys(keymap.getKeyMap()).length > 0,
  'The native keyboard module must load and run.',
);

// Flush the result before exiting: native-keymap keeps its layout listener alive.
process.stdout.write(
  `Verified Windows ${expectedArch}: Electron and keyboard mapping.\n`,
  (error) => {
    if (error) {
      throw error;
    }
    process.exit(0);
  },
);
