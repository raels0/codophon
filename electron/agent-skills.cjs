// @ts-check

/**
 * @typedef {'codex' | 'claude' | 'opencode'} AgentSkillId
 * @typedef {{
 *   legacyManagedMarkers?: ReadonlyArray<string>;
 *   managedMarker: string;
 *   sourceSubdir: string;
 *   targetSubdir: string;
 * }} AgentSkillFile
 * @typedef {{
 *   agentLabel: string;
 *   files?: ReadonlyArray<AgentSkillFile>;
 *   id: AgentSkillId;
 *   label: string;
 *   targets: ReadonlyArray<{sourceSubdir: string; targetSubdir: string}>;
 * }} AgentSkill
 */

/** @type {ReadonlyArray<AgentSkill>} */
const AGENT_SKILLS = Object.freeze([
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

/** @returns {ReadonlyArray<AgentSkill>} */
const listAgentSkills = () => AGENT_SKILLS;

/**
 * @param {(skill: AgentSkill, browserWindow: import('electron').BaseWindow | undefined) => void} install
 * @returns {import('electron').MenuItemConstructorOptions}
 */
const buildInstallSkillMenuItem = (install) => ({
  label: 'Install Skill',
  submenu: AGENT_SKILLS.map((skill) => ({
    click: (_menuItem, browserWindow) => install(skill, browserWindow),
    label: skill.agentLabel,
  })),
});

module.exports = {
  buildInstallSkillMenuItem,
  listAgentSkills,
};
