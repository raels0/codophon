import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type AgentSkillFile = {
  legacyManagedMarkers: ReadonlyArray<string>;
  managedMarker: string;
  sourceSubdir: string;
  targetSubdir: string;
};

export type AgentSkillTarget = { sourceSubdir: string; targetSubdir: string };

export type AgentSkill = {
  files?: ReadonlyArray<AgentSkillFile>;
  label: string;
  targets: ReadonlyArray<AgentSkillTarget>;
};

/**
 * Installs every skill an agent bundles with a single action: each is symlinked
 * from the app into the agent's skills directory.
 */
const createSkillInstaller = ({
  app,
  dialog,
  renderManagedFile,
  root,
  skill,
}: {
  app: import('electron').App;
  dialog: import('electron').Dialog;
  renderManagedFile?: (file: AgentSkillFile, template: string) => string;
  root: string;
  skill: AgentSkill;
}) => {
  const getSourcePath = (item: { sourceSubdir: string }) =>
    app.isPackaged
      ? join(process.resourcesPath, 'app', item.sourceSubdir)
      : join(root, item.sourceSubdir);

  const getTargetPath = (item: { targetSubdir: string }) =>
    join(app.getPath('home'), item.targetSubdir);

  const getRenderedFile = (file: AgentSkillFile) => {
    const template = readFileSync(getSourcePath(file), 'utf8');
    return renderManagedFile ? renderManagedFile(file, template) : template;
  };

  const isManagedFile = (file: AgentSkillFile, contents: string) => {
    const markers = new Set([file.managedMarker, ...(file.legacyManagedMarkers || [])]);
    return contents
      .split(/\r?\n/, 20)
      .slice(0, 20)
      .some((line) => markers.has(line));
  };

  const isInstalledTarget = (target: AgentSkillTarget) => {
    try {
      const targetPath = getTargetPath(target);
      if (!existsSync(targetPath)) {
        return false;
      }

      const stats = lstatSync(targetPath);
      if (!stats.isSymbolicLink()) {
        return false;
      }

      return realpathSync(targetPath) === realpathSync(getSourcePath(target));
    } catch {
      return false;
    }
  };

  const isInstalledFile = (file: AgentSkillFile) => {
    try {
      const targetPath = getTargetPath(file);
      return (
        existsSync(targetPath) &&
        lstatSync(targetPath).isFile() &&
        readFileSync(targetPath, 'utf8') === getRenderedFile(file)
      );
    } catch {
      return false;
    }
  };

  const getStatus = () => ({
    installed: skill.targets.every(isInstalledTarget) && (skill.files || []).every(isInstalledFile),
    // Representative path (the first skill); the install dialog lists them all.
    path: getTargetPath(skill.targets[0]),
  });

  /** @returns the installed path */
  const installTarget = (target: AgentSkillTarget): string => {
    const sourcePath = getSourcePath(target);
    const targetPath = getTargetPath(target);

    mkdirSync(dirname(targetPath), { recursive: true });
    accessSync(dirname(targetPath), constants.W_OK);

    const stats = lstatSync(targetPath, { throwIfNoEntry: false });
    if (stats) {
      if (!stats.isSymbolicLink()) {
        throw new Error(`${targetPath} already exists and is not a symlink.`);
      }
      unlinkSync(targetPath);
    }

    symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
    return targetPath;
  };

  /** @returns the installed path */
  const installFile = (file: AgentSkillFile): string => {
    const targetPath = getTargetPath(file);

    mkdirSync(dirname(targetPath), { recursive: true });
    accessSync(dirname(targetPath), constants.W_OK);

    if (existsSync(targetPath)) {
      const stats = lstatSync(targetPath);
      const contents = stats.isFile() ? readFileSync(targetPath, 'utf8') : '';
      if (!stats.isFile() || !isManagedFile(file, contents)) {
        throw new Error(`${targetPath} already exists and is not managed by Codophon.`);
      }
    }

    writeFileSync(targetPath, getRenderedFile(file), { encoding: 'utf8', mode: 0o644 });
    return targetPath;
  };

  const refreshManagedFiles = () => {
    if (!skill.targets.every(isInstalledTarget)) {
      return;
    }

    for (const file of skill.files || []) {
      const targetPath = getTargetPath(file);
      if (!existsSync(targetPath)) {
        installFile(file);
        continue;
      }
      if (!lstatSync(targetPath).isFile()) {
        continue;
      }

      const contents = readFileSync(targetPath, 'utf8');
      if (!isManagedFile(file, contents)) {
        continue;
      }

      const rendered = getRenderedFile(file);
      if (contents !== rendered) {
        writeFileSync(targetPath, rendered, { encoding: 'utf8', mode: 0o644 });
      }
    }
  };

  const install = async (browserWindow: import('electron').BaseWindow | undefined | null) => {
    try {
      for (const target of skill.targets) {
        const sourcePath = getSourcePath(target);
        const targetPath = getTargetPath(target);
        if (!existsSync(sourcePath)) {
          throw new Error(`Could not find the ${skill.label} at ${sourcePath}.`);
        }
        if (lstatSync(targetPath, { throwIfNoEntry: false })?.isSymbolicLink() === false) {
          throw new Error(`${targetPath} already exists and is not a symlink.`);
        }
      }

      for (const file of skill.files || []) {
        const sourcePath = getSourcePath(file);
        const targetPath = getTargetPath(file);
        if (!existsSync(sourcePath)) {
          throw new Error(`Could not find the ${skill.label} command at ${sourcePath}.`);
        }

        getRenderedFile(file);
        if (existsSync(targetPath)) {
          const stats = lstatSync(targetPath);
          const contents = stats.isFile() ? readFileSync(targetPath, 'utf8') : '';
          if (!stats.isFile() || !isManagedFile(file, contents)) {
            throw new Error(`${targetPath} already exists and is not managed by Codophon.`);
          }
        }
      }

      const installedPaths = [
        ...skill.targets.map(installTarget),
        ...(skill.files || []).map(installFile),
      ];

      const successMessage: import('electron').MessageBoxOptions = {
        buttons: ['OK'],
        detail: installedPaths.join('\n'),
        message: `Installed the Codophon ${skill.label}.`,
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
        message: `Could not install the ${skill.label}.`,
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
    getStatus,
    install,
    refreshManagedFiles,
  };
};

export { createSkillInstaller };
