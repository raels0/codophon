import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { App, Dialog } from 'electron';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import { buildInstallSkillMenuItem, listAgentSkills } from '../agent-skills.ts';
import { createSkillInstaller } from '../main/agent-skill.ts';
import { createTerminalHelper } from '../main/terminal-helper.ts';

test('lists every bundled skill with its installation target', () => {
  expect(listAgentSkills()).toEqual([
    {
      agentLabel: 'Codex',
      id: 'codex',
      label: 'Codex Skill',
      targets: [{ sourceSubdir: 'skills/codophon', targetSubdir: '.codex/skills/codophon' }],
    },
    {
      agentLabel: 'Claude Code',
      id: 'claude',
      label: 'Claude Code Skill',
      targets: [{ sourceSubdir: 'skills/codophon', targetSubdir: '.claude/skills/codophon' }],
    },
    {
      agentLabel: 'OpenCode',
      files: [
        {
          legacyManagedMarkers: [
            '<!-- Managed by Codophon. Reinstall the OpenCode integration instead of editing this file. -->',
          ],
          managedMarker: '<!-- codophon-managed-opencode-command:v1 -->',
          sourceSubdir: 'skills/opencode-command.md',
          targetSubdir: '.config/opencode/commands/codophon.md',
        },
      ],
      id: 'opencode',
      label: 'OpenCode Skill',
      targets: [
        {
          sourceSubdir: 'skills/codophon',
          targetSubdir: '.config/opencode/skills/codophon',
        },
      ],
    },
  ]);
});

test('builds an Install Skill submenu that routes each agent action', () => {
  const install = vi.fn();
  const menuItem = buildInstallSkillMenuItem(install);
  const browserWindow = undefined;

  expect(menuItem.label).toBe('Install Skill');
  expect(menuItem.submenu.map((item) => item.label)).toEqual(['Codex', 'Claude Code', 'OpenCode']);

  menuItem.submenu[2].click({}, browserWindow);
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ id: 'opencode' }), browserWindow);
});

test('installs the OpenCode skill into its global skills directory', async () => {
  await using directory = await createTemporaryDirectory('codophon-opencode-skill-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'skills/codophon');
  const target = join(home, '.config/opencode/skills/codophon');
  const commandSource = join(root, 'skills/opencode-command.md');
  const commandTarget = join(home, '.config/opencode/commands/codophon.md');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');
  let model = 'anthropic/claude-sonnet-4-6';

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await writeFile(
    commandSource,
    '---\n{{MODEL}}\n---\n<!-- codophon-managed-opencode-command:v1 -->\nRun Codophon.\n',
  );
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    renderManagedFile: (_file, template) => template.replace('{{MODEL}}', `model: ${model}`),
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  expect(installer.getStatus()).toEqual({ installed: true, path: target });
  await expect(realpath(target)).resolves.toBe(await realpath(source));
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain(
    'model: anthropic/claude-sonnet-4-6',
  );

  await rm(commandTarget);
  model = 'openai/gpt-5.5';
  installer.refreshManagedFiles();
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain('model: openai/gpt-5.5');
  expect(installer.getStatus()).toEqual({ installed: true, path: target });
});

test('does not replace a user-authored OpenCode command', async () => {
  await using directory = await createTemporaryDirectory('codophon-opencode-command-conflict-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'skills/codophon');
  const commandSource = join(root, 'skills/opencode-command.md');
  const commandTarget = join(home, '.config/opencode/commands/codophon.md');
  const skill = listAgentSkills().find(({ id }) => id === 'opencode');

  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'opencode/commands'), { recursive: true });
  await mkdir(join(home, '.config/opencode/commands'), { recursive: true });
  await writeFile(commandSource, '<!-- codophon-managed-opencode-command:v1 -->\nRun Codophon.\n');
  await writeFile(
    commandTarget,
    '<!-- This user-authored file mentions Managed by Codophon. -->\nMy custom Codophon command.\n',
  );
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(false);
  await expect(readFile(commandTarget, 'utf8')).resolves.toContain('My custom Codophon command.');
  await expect(lstat(join(home, '.config/opencode/skills/codophon'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('replaces a dangling skill symlink on reinstall', async () => {
  await using directory = await createTemporaryDirectory('codophon-dangling-skill-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'skills/codophon');
  const target = join(home, '.claude/skills/codophon');
  const skill = listAgentSkills().find(({ id }) => id === 'claude');

  await mkdir(source, { recursive: true });
  await mkdir(join(home, '.claude/skills'), { recursive: true });
  await symlink(join(directory.path, 'old-app/claude/skills/codophon'), target);
  expect(skill).toBeDefined();
  const installer = createSkillInstaller({
    app: {
      getPath: () => home,
      isPackaged: false,
    },
    dialog: {
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    root,
    skill: skill!,
  });

  await expect(installer.install()).resolves.toBe(true);
  await expect(realpath(target)).resolves.toBe(await realpath(source));
});

test('replaces a dangling terminal helper symlink on reinstall', async () => {
  await using directory = await createTemporaryDirectory('codophon-dangling-helper-');
  const home = join(directory.path, 'home');
  const root = join(directory.path, 'app');
  const source = join(root, 'bin/codophon.js');
  const target = join(home, '.local/bin/codophon');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(source, '');
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await symlink(join(directory.path, 'old-app/bin/codophon.js'), target);
  const helper = createTerminalHelper({
    app: { getPath: () => home, isPackaged: false } as unknown as App,
    dialog: { showMessageBox: async () => ({ response: 0 }) } as unknown as Dialog,
    root,
    // Keep the helper out of the real /opt/homebrew/bin and /usr/local/bin.
    systemBinDirectories: [],
  });

  await expect(helper.installTerminalHelper(null)).resolves.toBe(true);
  await expect(realpath(target)).resolves.toBe(await realpath(source));
});
