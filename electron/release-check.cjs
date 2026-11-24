// @ts-check

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Codophon doesn't install updates itself. It notices a newer GitHub release and links to it,
// so a build can never replace itself with something the user didn't choose to download.
const RELEASES_REPOSITORY = 'raels0/codophon';
const RELEASES_URL = `https://github.com/${RELEASES_REPOSITORY}/releases`;
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * @typedef {import('../core/types.ts').CodiffUpdateStatus} UpdateStatus
 * @typedef {{ checkedAt: number; dismissedVersion?: string; latestVersion?: string }} ReleaseState
 */

/** @param {string} version */
const parseVersion = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** @param {string} candidate @param {string} current */
const isNewerVersion = (candidate, current) => {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) {
    return false;
  }
  const index = next.findIndex((part, position) => part !== now[position]);
  return index !== -1 && next[index] > now[index];
};

/** @returns {Promise<string | null>} The latest release version, without its `v` prefix. */
const fetchLatestVersion = async () => {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`,
    {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'codiff-release-check' },
    },
  );
  if (!response.ok) {
    return null;
  }
  const { tag_name: tag } = /** @type {{tag_name?: unknown}} */ (await response.json());
  return typeof tag === 'string' && parseVersion(tag) ? tag.replace(/^v/, '') : null;
};

/**
 * Tracks whether a newer release exists. Failures are silent: a missed check only means the
 * user hears about the release a day later.
 *
 * @param {{
 *   currentVersion: string;
 *   enabled: boolean;
 *   fetchLatest?: () => Promise<string | null>;
 *   now?: () => number;
 *   onChange: (status: UpdateStatus) => void;
 *   stateDirectory: string;
 * }} options
 */
const createReleaseCheck = ({
  currentVersion,
  enabled,
  fetchLatest = fetchLatestVersion,
  now = Date.now,
  onChange,
  stateDirectory,
}) => {
  const statePath = join(stateDirectory, 'release-check.json');
  /** @type {ReleaseState} */
  let state = { checkedAt: 0 };
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) };
  } catch {}

  /** @returns {UpdateStatus} */
  const getStatus = () =>
    enabled &&
    state.latestVersion &&
    state.latestVersion !== state.dismissedVersion &&
    isNewerVersion(state.latestVersion, currentVersion)
      ? { availableVersion: state.latestVersion, currentVersion }
      : { currentVersion };

  /** @param {Partial<ReleaseState>} patch */
  const update = (patch) => {
    state = { ...state, ...patch };
    try {
      mkdirSync(stateDirectory, { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    } catch {}
    onChange(getStatus());
  };

  return {
    /** @param {{force?: boolean}} [options] */
    async check({ force = false } = {}) {
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
    /** @param {boolean} next */
    setEnabled(next) {
      enabled = next;
      onChange(getStatus());
    },
  };
};

module.exports = { createReleaseCheck, isNewerVersion };
