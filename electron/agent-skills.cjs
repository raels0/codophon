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
    targets: [{ sourceSubdir: 'skills/codiff', targetSubdir: '.codex/skills/codiff' }],
  },
  {
    agentLabel: 'Claude Code',
    id: 'claude',
    label: 'Claude Code Skill',
    targets: [{ sourceSubdir: 'skills/codiff', targetSubdir: '.claude/skills/codiff' }],
  },
  {
    agentLabel: 'OpenCode',
    files: [
      {
        legacyManagedMarkers: [
          '<!-- Managed by Codiff. Reinstall the OpenCode integration instead of editing this file. -->',
        ],
        managedMarker: '<!-- codiff-managed-opencode-command:v1 -->',
        sourceSubdir: 'skills/opencode-command.md',
        targetSubdir: '.config/opencode/commands/codiff.md',
      },
    ],
    id: 'opencode',
    label: 'OpenCode Skill',
    targets: [
      {
        sourceSubdir: 'skills/codiff',
        targetSubdir: '.config/opencode/skills/codiff',
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
