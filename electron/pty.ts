import { accessSync, chmodSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);

// pnpm can install node-pty's prebuilt macOS spawn-helper without the
// executable bit, which makes pty.spawn fail with `posix_spawnp failed`.
const ensureSpawnHelperIsExecutable = () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const helper = join(
    dirname(nodeRequire.resolve('node-pty/package.json')),
    'prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper',
  );
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    try {
      chmodSync(helper, 0o755);
    } catch {
      // Let node-pty report the failure if the helper cannot be repaired.
    }
  }
};

const spawnPty: typeof import('node-pty').spawn = (...args) => {
  ensureSpawnHelperIsExecutable();
  return nodeRequire('node-pty').spawn(...args);
};

export { spawnPty };
