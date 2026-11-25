import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

// Homebrew's and the system's bin directories are tried before ~/.local/bin.
const SYSTEM_BIN_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'];

const createTerminalHelper = ({
  app,
  dialog,
  root,
  systemBinDirectories = SYSTEM_BIN_DIRECTORIES,
}: {
  app: import('electron').App;
  dialog: import('electron').Dialog;
  root: string;
  systemBinDirectories?: ReadonlyArray<string>;
}) => {
  const getTerminalHelperSourcePath = () =>
    app.isPackaged
      ? join(process.resourcesPath, 'app/bin/codophon-app')
      : join(root, 'bin/codophon.js');

  const getTerminalHelperTargetPaths = () => [
    ...systemBinDirectories.map((directory) => join(directory, 'codophon')),
    join(app.getPath('home'), '.local/bin/codophon'),
  ];

  const getPreferredTerminalHelperTargetPath = () => {
    for (const directory of systemBinDirectories) {
      try {
        if (existsSync(directory)) {
          accessSync(directory, constants.W_OK);
          return join(directory, 'codophon');
        }
      } catch {
        // Keep looking for a writable install location.
      }
    }

    return join(app.getPath('home'), '.local/bin/codophon');
  };

  const isInstalledTerminalHelper = (targetPath: string) => {
    try {
      if (!existsSync(targetPath)) {
        return false;
      }

      const target = lstatSync(targetPath);
      if (!target.isSymbolicLink()) {
        return false;
      }

      return realpathSync(targetPath) === realpathSync(getTerminalHelperSourcePath());
    } catch {
      return false;
    }
  };

  const getTerminalHelperStatus = () => {
    const installedPath = getTerminalHelperTargetPaths().find((targetPath) =>
      isInstalledTerminalHelper(targetPath),
    );

    return {
      command: 'codophon',
      installed: installedPath != null,
      path: installedPath || getPreferredTerminalHelperTargetPath(),
    };
  };

  const getWritableHelperDirectory = () => {
    for (const directory of systemBinDirectories) {
      try {
        if (existsSync(directory)) {
          accessSync(directory, constants.W_OK);
          return directory;
        }
      } catch {
        // Keep looking for a writable install location.
      }
    }

    const localBin = join(app.getPath('home'), '.local/bin');
    mkdirSync(localBin, { recursive: true });
    return localBin;
  };

  const installTerminalHelper = async (
    browserWindow: import('electron').BaseWindow | undefined | null,
  ) => {
    try {
      const sourcePath = getTerminalHelperSourcePath();
      const targetPath = join(getWritableHelperDirectory(), 'codophon');

      if (!existsSync(sourcePath)) {
        throw new Error(`Could not find terminal helper at ${sourcePath}.`);
      }

      const target = lstatSync(targetPath, { throwIfNoEntry: false });
      if (target) {
        if (!target.isSymbolicLink()) {
          throw new Error(`${targetPath} already exists and is not a symlink.`);
        }

        unlinkSync(targetPath);
      }

      symlinkSync(sourcePath, targetPath);

      const successMessage: import('electron').MessageBoxOptions = {
        buttons: ['OK'],
        message: `Installed codophon at ${targetPath}.`,
        type: 'info',
      };
      if (browserWindow) {
        await dialog.showMessageBox(browserWindow, successMessage);
      } else {
        await dialog.showMessageBox(successMessage);
      }
      return true;
    } catch (error) {
      const errorMessage: import('electron').MessageBoxOptions = {
        buttons: ['OK'],
        detail: error instanceof Error ? error.message : String(error),
        message: 'Could not install the terminal helper.',
        type: 'error',
      };
      if (browserWindow) {
        await dialog.showMessageBox(browserWindow, errorMessage);
      } else {
        await dialog.showMessageBox(errorMessage);
      }
      return false;
    }
  };

  return {
    getTerminalHelperStatus,
    installTerminalHelper,
  };
};

export { createTerminalHelper };
