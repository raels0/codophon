import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Codophon doesn't install updates itself. It notices a newer GitHub release and links to it,
// so a build can never replace itself with something the user didn't choose to download.
const RELEASES_REPOSITORY = 'raels0/codophon';
const RELEASES_URL = `https://github.com/${RELEASES_REPOSITORY}/releases`;
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

import type { CodophonUpdateStatus as UpdateStatus } from '../core/types.ts';

export type ReleaseState = { checkedAt: number; dismissedVersion?: string; latestVersion?: string };

const parseVersion = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const isNewerVersion = (candidate: string, current: string) => {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) {
    return false;
  }
  const index = next.findIndex((part, position) => part !== now[position]);
  return index !== -1 && next[index] > now[index];
};

/** @returns The latest release version, without its `v` prefix. */
const fetchLatestVersion = async (): Promise<string | null> => {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`,
    {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'codophon-release-check' },
    },
  );
  if (!response.ok) {
    return null;
  }
  const { tag_name: tag } = (await response.json()) as { tag_name?: unknown };
  return typeof tag === 'string' && parseVersion(tag) ? tag.replace(/^v/, '') : null;
};

/**
 * Tracks whether a newer release exists. Failures are silent: a missed check only means the
 * user hears about the release a day later.
 */
const createReleaseCheck = ({
  currentVersion,
  enabled,
  fetchLatest = fetchLatestVersion,
  now = Date.now,
  onChange,
  stateDirectory,
}: {
  currentVersion: string;
  enabled: boolean;
  fetchLatest?: () => Promise<string | null>;
  now?: () => number;
  onChange: (status: UpdateStatus) => void;
  stateDirectory: string;
}) => {
  const statePath = join(stateDirectory, 'release-check.json');

  let state: ReleaseState = { checkedAt: 0 };
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) };
  } catch {}

  const getStatus = (): UpdateStatus =>
    enabled &&
    state.latestVersion &&
    state.latestVersion !== state.dismissedVersion &&
    isNewerVersion(state.latestVersion, currentVersion)
      ? { availableVersion: state.latestVersion, currentVersion }
      : { currentVersion };

  const update = (patch: Partial<ReleaseState>) => {
    state = { ...state, ...patch };
    try {
      mkdirSync(stateDirectory, { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    } catch {}
    onChange(getStatus());
  };

  return {
    async check({ force = false }: { force?: boolean } = {}) {
      if ((enabled || force) && (force || now() - state.checkedAt >= CHECK_INTERVAL_MS)) {
        const latestVersion = await fetchLatest().catch(() => null);
        update({ checkedAt: now(), ...(latestVersion ? { latestVersion } : {}) });
      }
      return getStatus();
    },
    dismiss() {
      update({ dismissedVersion: state.latestVersion });
      return getStatus();
    },
    getStatus,
    releaseUrl: () =>
      state.latestVersion ? `${RELEASES_URL}/tag/v${state.latestVersion}` : RELEASES_URL,

    setEnabled(next: boolean) {
      enabled = next;
      onChange(getStatus());
    },
  };
};

export { createReleaseCheck, isNewerVersion };
