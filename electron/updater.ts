// Codophon updates itself from GitHub releases. A daily check finds a newer release; on macOS
// and Windows the matching zip downloads in the background, is checked against the release's
// size and SHA-256 digest, and is staged next to the installed app. Restarting (or quitting)
// hands off to a small script that swaps the new build in once Codophon has exited.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { CodophonUpdateStatus as UpdateStatus } from '../core/types.ts';

const RELEASES_REPOSITORY = 'raels0/codophon';
const RELEASES_URL = `https://github.com/${RELEASES_REPOSITORY}/releases`;
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`;
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;
const STAGING_DIRECTORY = '.codophon-update';

const execFileAsync = promisify(execFile);

export type ReleaseState = { checkedAt: number; dismissedVersion?: string; latestVersion?: string };

export type ReleaseAsset = { digest?: string; name: string; size: number; url: string };

export type Release = { assets: ReadonlyArray<ReleaseAsset>; version: string };

/** The installed app Codophon replaces, and what to start once the new build is in place. */
export type InstallTarget = { launch: string; path: string; platform: 'darwin' | 'win32' };

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

const fetchLatestRelease = async (feedUrl = LATEST_RELEASE_URL): Promise<Release | null> => {
  const response = await fetch(feedUrl, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'codophon-updater' },
  });
  if (!response.ok) {
    return null;
  }
  const { assets, tag_name: tag } = (await response.json()) as {
    assets?: Array<{
      browser_download_url?: unknown;
      digest?: unknown;
      name?: unknown;
      size?: unknown;
    }>;
    tag_name?: unknown;
  };
  if (typeof tag !== 'string' || !parseVersion(tag)) {
    return null;
  }
  return {
    assets: (assets ?? []).flatMap((asset) =>
      typeof asset.name === 'string' &&
      typeof asset.size === 'number' &&
      typeof asset.browser_download_url === 'string'
        ? [
            {
              ...(typeof asset.digest === 'string' ? { digest: asset.digest } : {}),
              name: asset.name,
              size: asset.size,
              url: asset.browser_download_url,
            },
          ]
        : [],
    ),
    version: tag.replace(/^v/, ''),
  };
};

/** The zip electron-forge makes for this platform, e.g. `Codophon-win32-x64-1.2.0.zip`. */
const findAsset = (release: Release, platform: string, arch: string) =>
  release.assets.find(
    (asset) => asset.name === `Codophon-${platform}-${arch}-${release.version}.zip`,
  ) ?? null;

const isWritable = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where the running app is installed, or null when it can't replace itself there: an
 * unsupported platform, a folder the user can't write to, or a quarantined macOS app that
 * runs from a read-only translocated copy.
 */
const getInstallTarget = (
  execPath = process.execPath,
  platform = process.platform,
): InstallTarget | null => {
  let target: InstallTarget | null = null;
  if (platform === 'darwin') {
    const bundle = resolve(execPath, '..', '..', '..');
    if (bundle.endsWith('.app') && !bundle.includes('/AppTranslocation/')) {
      target = { launch: bundle, path: bundle, platform };
    }
  } else if (platform === 'win32') {
    target = { launch: execPath, path: dirname(execPath), platform };
  }
  return target && isWritable(target.path) && isWritable(dirname(target.path)) ? target : null;
};

const extractZip = async (zipPath: string, destination: string, platform: string) => {
  mkdirSync(destination, { recursive: true });
  if (platform === 'darwin') {
    // ditto keeps the framework symlinks and permissions inside the app bundle intact.
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, destination]);
  } else {
    // Windows' own bsdtar reads zips; Git for Windows puts a GNU tar earlier on PATH that doesn't.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await execFileAsync(tar, ['-xf', zipPath, '-C', destination]);
  }
};

/** The app inside an extracted release: `Codophon.app`, or the folder holding the executable. */
const findExtractedApp = (directory: string, target: InstallTarget): string | null => {
  const candidates = [directory, ...readdirSync(directory).map((name) => join(directory, name))];
  if (target.platform === 'darwin') {
    return (
      candidates.find(
        (path) => path.endsWith('.app') && existsSync(join(path, 'Contents', 'Info.plist')),
      ) ?? null
    );
  }
  return candidates.find((path) => existsSync(join(path, basename(target.launch)))) ?? null;
};

const INSTALL_SCRIPT_SH = `#!/bin/bash
# Swaps a downloaded Codophon update into place once the running app has exited.
# Usage: install-update.sh <pid> <installed app> <staged app> [command to relaunch...]
pid="$1"; target="$2"; staged="$3"; shift 3
exec >"\${0%/*}/install-update.log" 2>&1
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
backup="$target.previous"
rm -rf "$backup"
if [ ! -e "$staged" ]; then
  echo "No update staged at $staged"
elif mv "$target" "$backup"; then
  if mv "$staged" "$target"; then
    rm -rf "$backup"
  else
    mv "$backup" "$target"
  fi
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
echo Done
if [ "$#" -gt 0 ]; then exec "$@"; fi
`;

const INSTALL_SCRIPT_PS1 = `# Swaps a downloaded Codophon update into place once the running app has exited.
# Reads its parameters from install-update.json next to it, so no path passes through cmd.exe.
$request = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'install-update.json') | ConvertFrom-Json
$ProcessId = [int]$request.pid; $Target = $request.target; $Staged = $request.staged; $Launch = $request.launch
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'install-update.log'
function Write-Log([string]$Message) { Add-Content -LiteralPath $log -Value $Message }
Set-Content -LiteralPath $log -Value "Installing $Staged into $Target"
try { Wait-Process -Id $ProcessId -Timeout 600 } catch {}
# Windows and antivirus scans can keep files locked for a moment after the app exits.
function Move-WithRetry([string]$From, [string]$To) {
  for ($i = 0; $i -lt 50; $i++) {
    try { Move-Item -LiteralPath $From -Destination $To; return $true }
    catch { Write-Log $_.Exception.Message; Start-Sleep -Milliseconds 200 }
  }
  return $false
}
$backup = "$Target.previous"
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
if (-not (Test-Path -LiteralPath $Staged)) {
  Write-Log "No update staged at $Staged"
} elseif (Move-WithRetry $Target $backup) {
  if (Move-WithRetry $Staged $Target) {
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Move-WithRetry $backup $Target | Out-Null
  }
}
if ($Launch) { Start-Process -FilePath $Launch }
Write-Log 'Done'
`;

type InstallRequest = {
  pid: number;
  relaunch: boolean;
  scriptDirectory: string;
  staged: string;
  target: InstallTarget;
};

/**
 * Starts the script that replaces `target.path` with `staged` once process `pid` exits, then
 * optionally relaunches. It runs detached so it outlives Codophon.
 */
const runInstallScript = ({ pid, relaunch, scriptDirectory, staged, target }: InstallRequest) => {
  mkdirSync(scriptDirectory, { recursive: true });
  const options = {
    cwd: scriptDirectory,
    detached: true,
    stdio: 'ignore' as const,
    windowsHide: true,
  };
  if (target.platform === 'win32') {
    const script = join(scriptDirectory, 'install-update.ps1');
    writeFileSync(script, INSTALL_SCRIPT_PS1);
    writeFileSync(
      join(scriptDirectory, 'install-update.json'),
      JSON.stringify({ launch: relaunch ? target.launch : '', pid, staged, target: target.path }),
    );
    // A detached PowerShell has no console and silently never starts; `start` gives it one.
    const powershell = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
    return spawn('cmd.exe', [`/d /s /c "start "" /b ${powershell}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  const script = join(scriptDirectory, 'install-update.sh');
  writeFileSync(script, INSTALL_SCRIPT_SH, { mode: 0o755 });
  const launch = relaunch ? ['/usr/bin/open', target.launch] : [];
  return spawn('/bin/bash', [script, String(pid), target.path, staged, ...launch], options);
};

const downloadAsset = async (
  asset: ReleaseAsset,
  destination: string,
  onProgress: (fraction: number) => void,
) => {
  const response = await fetch(asset.url, { headers: { 'user-agent': 'codophon-updater' } });
  if (!response.ok || !response.body) {
    throw new Error(`The download failed (HTTP ${response.status}).`);
  }
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      onProgress(Math.min(1, received / asset.size));
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    meter,
    createWriteStream(destination),
  );
  if (received !== asset.size) {
    throw new Error('The download was incomplete.');
  }
  if (asset.digest && asset.digest !== `sha256:${hash.digest('hex')}`) {
    throw new Error("The download doesn't match the release's checksum.");
  }
};

type Download =
  | { progress: number; state: 'downloading' }
  | { staged: string; state: 'ready' }
  | { error: string; state: 'failed' };

const createUpdater = ({
  arch = process.arch,
  currentVersion,
  enabled,
  extract = extractZip,
  fetchRelease = fetchLatestRelease,
  installTarget,
  now = Date.now,
  onChange,
  pid = process.pid,
  quit,
  stateDirectory,
}: {
  arch?: string;
  currentVersion: string;
  enabled: boolean;
  extract?: (zipPath: string, destination: string, platform: string) => Promise<void>;
  fetchRelease?: () => Promise<Release | null>;
  installTarget: InstallTarget | null;
  now?: () => number;
  onChange: (status: UpdateStatus) => void;
  pid?: number;
  quit: () => void;
  stateDirectory: string;
}) => {
  const statePath = join(stateDirectory, 'release-check.json');
  const scriptDirectory = join(stateDirectory, 'updates');
  const stagingDirectory = installTarget
    ? join(dirname(installTarget.path), STAGING_DIRECTORY)
    : null;

  let state: ReleaseState = { checkedAt: 0 };
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) };
  } catch {}
  let asset: ReleaseAsset | null = null;
  let download: Download | null = null;
  let downloading: Promise<void> | null = null;
  let installing = false;

  // Leftovers from an earlier update: the staged copy and the previous build.
  if (stagingDirectory && installTarget) {
    for (const path of [stagingDirectory, `${installTarget.path}.previous`]) {
      try {
        rmSync(path, { force: true, recursive: true });
      } catch {}
    }
  }

  const isAvailable = () =>
    enabled &&
    state.latestVersion != null &&
    state.latestVersion !== state.dismissedVersion &&
    isNewerVersion(state.latestVersion, currentVersion);

  const getStatus = (): UpdateStatus => {
    if (!isAvailable()) {
      return { currentVersion };
    }
    const status: UpdateStatus = { availableVersion: state.latestVersion, currentVersion };
    if (download?.state === 'ready') {
      status.download = { state: 'ready' };
    } else if (download) {
      status.download = download;
    }
    return status;
  };

  const save = (patch: Partial<ReleaseState>) => {
    state = { ...state, ...patch };
    try {
      mkdirSync(stateDirectory, { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    } catch {}
  };

  const setDownload = (next: Download | null) => {
    download = next;
    onChange(getStatus());
  };

  const startDownload = () => {
    if (!installTarget || !stagingDirectory || !asset || download?.state === 'ready') {
      return downloading ?? Promise.resolve();
    }
    downloading ??= (async () => {
      const release = asset!;
      setDownload({ progress: 0, state: 'downloading' });
      try {
        rmSync(stagingDirectory, { force: true, recursive: true });
        mkdirSync(stagingDirectory, { recursive: true });
        const zipPath = join(stagingDirectory, release.name);
        let shown = 0;
        await downloadAsset(release, zipPath, (fraction) => {
          const progress = Math.floor(fraction * 100);
          if (progress !== shown) {
            shown = progress;
            setDownload({ progress, state: 'downloading' });
          }
        });
        const extracted = join(stagingDirectory, 'app');
        await extract(zipPath, extracted, installTarget.platform);
        rmSync(zipPath, { force: true });
        const staged = findExtractedApp(extracted, installTarget);
        if (!staged) {
          throw new Error("The release doesn't contain a Codophon app for this computer.");
        }
        setDownload({ staged, state: 'ready' });
      } catch (error) {
        rmSync(stagingDirectory, { force: true, recursive: true });
        setDownload({
          error: error instanceof Error ? error.message : String(error),
          state: 'failed',
        });
      } finally {
        downloading = null;
      }
    })();
    return downloading;
  };

  const install = (relaunch: boolean) => {
    if (installing || download?.state !== 'ready' || !installTarget || !stagingDirectory) {
      return false;
    }
    installing = true;
    runInstallScript({
      pid,
      relaunch,
      scriptDirectory,
      staged: download.staged,
      target: installTarget,
    }).unref();
    return true;
  };

  return {
    /** Looks for a newer release (at most daily unless forced) and starts downloading it. */
    async check({ force = false }: { force?: boolean } = {}) {
      // A known update still needs its download link after a restart, whatever the schedule.
      const due =
        force || now() - state.checkedAt >= CHECK_INTERVAL_MS || (isAvailable() && !asset);
      if ((enabled || force) && due) {
        const release = await fetchRelease().catch(() => null);
        asset = release ? findAsset(release, installTarget?.platform ?? '', arch) : null;
        save({
          checkedAt: now(),
          ...(release ? { latestVersion: release.version } : {}),
          ...(force ? { dismissedVersion: undefined } : {}),
        });
        onChange(getStatus());
      }
      if (isAvailable() && asset) {
        void startDownload();
      }
      return getStatus();
    },
    /** True when this install can replace itself, otherwise updates go through the release page. */
    canInstall: () => installTarget != null && asset != null,
    dismiss() {
      save({ dismissedVersion: state.latestVersion });
      onChange(getStatus());
      return getStatus();
    },
    /** Retries a failed or missing download; resolves once it settles. */
    download: () => startDownload(),
    getStatus,
    /** Installs the downloaded update and restarts into it. */
    installAndRestart() {
      if (install(true)) {
        quit();
        return true;
      }
      return false;
    },
    /** Installs a downloaded update as Codophon quits, without relaunching. */
    installOnQuit() {
      if (isAvailable()) {
        install(false);
      }
    },
    releaseUrl: () =>
      state.latestVersion ? `${RELEASES_URL}/tag/v${state.latestVersion}` : RELEASES_URL,
    setEnabled(next: boolean) {
      enabled = next;
      onChange(getStatus());
    },
  };
};

export { createUpdater, fetchLatestRelease, getInstallTarget, isNewerVersion, runInstallScript };
