import type { AgentBackend } from '../core/config/agents.ts';
export type AgentSkillId = AgentBackend;

export type AgentSkillFile = {
  legacyManagedMarkers: ReadonlyArray<string>;
  managedMarker: string;
  sourceSubdir: string;
  targetSubdir: string;
};

export type AgentSkill = {
  agentLabel: string;
  files?: ReadonlyArray<AgentSkillFile>;
  id: AgentSkillId;
  label: string;
  targets: ReadonlyArray<{ sourceSubdir: string; targetSubdir: string }>;
};

const AGENT_SKILLS: ReadonlyArray<AgentSkill> = Object.freeze([
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

const listAgentSkills = (): ReadonlyArray<AgentSkill> => AGENT_SKILLS;

const buildInstallSkillMenuItem = (
  install: (skill: AgentSkill, browserWindow: import('electron').BaseWindow | undefined) => void,
) => ({
  label: 'Install Skill',
  submenu: AGENT_SKILLS.map((skill) => ({
    click: (_menuItem: unknown, browserWindow?: import('electron').BaseWindow) =>
      install(skill, browserWindow),
    label: skill.agentLabel,
  })),
});

export { buildInstallSkillMenuItem, listAgentSkills };
