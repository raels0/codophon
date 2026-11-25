import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { getFingerprint, git } from './git-state/common.ts';

const FOCUSED_POLL_INTERVAL = 2500;
const HIDDEN_POLL_INTERVAL = 30_000;
const SELF_WRITE_CHECK_DELAY = 250;
const VISIBLE_POLL_INTERVAL = 10_000;

const normalizeRepositoryWatcherPath = (path: string, pathSeparator: string = sep) =>
  pathSeparator === '\\' ? path.replaceAll('\\', '/') : path;

const readStatusPath = (record: string, count: number) => {
  let index = 0;
  for (let field = 0; field < count; field += 1) {
    index = record.indexOf(' ', index);
    if (index === -1) {
      return '';
    }
    index += 1;
  }
  return record.slice(index);
};

const parseRepositoryWatcherStatus = (raw: string) => {
  let branchHead = '';
  let branchOid = '';

  const paths: Set<string> = new Set();
  const records = raw.split('\0').filter(Boolean);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      branchOid = record.slice('# branch.oid '.length);
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      branchHead = record.slice('# branch.head '.length);
      continue;
    }
    if (record.startsWith('? ')) {
      paths.add(record.slice(2));
      continue;
    }
    if (record.startsWith('1 ')) {
      paths.add(readStatusPath(record, 8));
      continue;
    }
    if (record.startsWith('2 ')) {
      paths.add(readStatusPath(record, 9));
      const oldPath = records[++index];
      if (oldPath) {
        paths.add(oldPath);
      }
      continue;
    }
    if (record.startsWith('u ')) {
      paths.add(readStatusPath(record, 10));
    }
  }

  return {
    head: `${branchOid}\0${branchHead}`,
    paths: [...paths],
  };
};

const readRepositoryWatcherPathState = async (repoRoot: string, path: string, exact: boolean) => {
  try {
    const absolutePath = join(repoRoot, path);
    const stat = await fs.lstat(absolutePath);
    const metadata = `${path}\0${
      stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : stat.isFile()
            ? 'file'
            : 'other'
    }\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
    if (!exact) {
      return { metadata };
    }

    const version = stat.isSymbolicLink()
      ? getFingerprint(await fs.readlink(absolutePath))
      : stat.isFile()
        ? getFingerprint(await fs.readFile(absolutePath))
        : undefined;
    return { metadata, version };
  } catch {
    return { metadata: `${path}\0missing` };
  }
};

/**
 * Read a repository watcher snapshot with one Git process. `repoRoot` must
 * already be the repository root.
 */
const readRepositoryWatcherSnapshot = async (
  repoRoot: string,
  exactPaths: Iterable<string> = [],
  knownDirtyPaths: Iterable<string> = [],
) => {
  const knownDirtyPathSet = new Set(knownDirtyPaths);
  const statusArgs = ['status', '--porcelain=v2', '--branch', '-z', '-uall'];
  // Git status hashes modified tracked files. Known dirty paths are monitored
  // through metadata instead, while this command discovers all new changes.
  if (knownDirtyPathSet.size > 0) {
    statusArgs.push(
      '--',
      '.',
      ...[...knownDirtyPathSet].map((path) => `:(exclude,literal)${path}`),
    );
  }
  const status = parseRepositoryWatcherStatus(await git(repoRoot, statusArgs));
  const normalizedExactPaths = new Set(
    [...exactPaths].map((path) => normalizeRepositoryWatcherPath(path)),
  );
  const statusPaths = new Set([...status.paths, ...knownDirtyPathSet]);
  const paths = new Set([...statusPaths, ...normalizedExactPaths]);
  const states = await Promise.all(
    [...paths].map(
      async (path) =>
        [
          path,
          await readRepositoryWatcherPathState(repoRoot, path, normalizedExactPaths.has(path)),
        ] as const,
    ),
  );

  const pathSignatures: Record<string, string> = {};

  const pathVersions: Record<string, string> = {};

  for (const [path, state] of states) {
    if (statusPaths.has(path)) {
      pathSignatures[path] = state.metadata;
    }
    if (state.version) {
      pathVersions[path] = state.version;
    }
  }

  const sortedSignatures = Object.entries(pathSignatures).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    head: status.head,
    pathSignatures: Object.fromEntries(sortedSignatures),
    pathVersions,
    root: repoRoot,
    signature: getFingerprint(
      [status.head, ...sortedSignatures.map(([, signature]) => signature)].join('\0'),
    ),
  };
};

const readRepositoryChangeSignature = async (
  launchPath: string,
  exactPaths: Iterable<string> = [],
) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  return readRepositoryWatcherSnapshot(repoRoot, exactPaths);
};

const repositoryWatcherSnapshotsMatchExpectedWrites = (
  left: { head: string; pathSignatures: Record<string, string> },
  right: {
    head: string;
    pathSignatures: Record<string, string>;
    pathVersions?: Record<string, string>;
  },
  expectedPathVersions: ReadonlyMap<string, string>,
) => {
  if (left.head !== right.head) {
    return false;
  }

  for (const [path, version] of expectedPathVersions) {
    if (right.pathVersions?.[path] !== version.slice(0, 16)) {
      return false;
    }
  }

  const paths = new Set([
    ...Object.keys(left.pathSignatures),
    ...Object.keys(right.pathSignatures),
  ]);
  for (const path of paths) {
    if (
      !expectedPathVersions.has(normalizeRepositoryWatcherPath(path)) &&
      left.pathSignatures[path] !== right.pathSignatures[path]
    ) {
      return false;
    }
  }

  return true;
};

const getRepositoryWatcherPollInterval = (
  states: ReadonlyArray<{ focused: boolean; visible: boolean }>,
) => {
  if (states.some(({ focused }) => focused)) {
    return FOCUSED_POLL_INTERVAL;
  }
  if (states.some(({ visible }) => visible)) {
    return VISIBLE_POLL_INTERVAL;
  }
  return HIDDEN_POLL_INTERVAL;
};

const createRepositoryWatcherCoordinator = ({
  readSnapshot,
  scheduleTimeout = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
}: {
  readSnapshot: (
    root: string,
    exactPaths: Iterable<string>,
    knownDirtyPaths: Iterable<string>,
  ) => Promise<{
    head: string;
    pathSignatures: Record<string, string>;
    pathVersions?: Record<string, string>;
    root: string;
    signature: string;
  }>;
  scheduleTimeout?: (callback: () => void, delay: number) => () => void;
}) => {
  type RepositoryWatcher = {
    checking: boolean;
    pendingSelfWrites: Map<
      string,
      { completed: boolean; generation: number; ownerId: number; version?: string }
    >;
    recheckRequested: boolean;
    resetRequested: Set<number>;
    root: string;
    snapshot?: Awaited<ReturnType<typeof readSnapshot>>;
    subscribers: Map<
      number,
      {
        changed: boolean;
        getState: () => { focused: boolean; visible: boolean };
        notify: (root: string) => void;
        snapshot?: Awaited<ReturnType<typeof readSnapshot>>;
      }
    >;
    cancelTimer?: () => void;
  };

  const watchers: Map<string, RepositoryWatcher> = new Map();

  const subscriberRoots: Map<number, string> = new Map();

  const clearTimer = (watcher: RepositoryWatcher) => {
    watcher.cancelTimer?.();
    watcher.cancelTimer = undefined;
  };

  const getPollInterval = (watcher: RepositoryWatcher) =>
    getRepositoryWatcherPollInterval(
      [...watcher.subscribers.values()]
        .filter(({ changed }) => !changed)
        .map(({ getState }) => {
          try {
            return getState();
          } catch {
            return { focused: false, visible: false };
          }
        }),
    );

  const schedule = (watcher: RepositoryWatcher, delay: number) => {
    clearTimer(watcher);
    watcher.cancelTimer = scheduleTimeout(() => {
      watcher.cancelTimer = undefined;
      void check(watcher);
    }, delay);
  };

  const schedulePoll = (watcher: RepositoryWatcher) => {
    if ([...watcher.subscribers.values()].some(({ changed }) => !changed)) {
      schedule(watcher, getPollInterval(watcher));
    }
  };

  const check = async (watcher: RepositoryWatcher, resetIds: Iterable<number> = []) => {
    if (watchers.get(watcher.root) !== watcher || watcher.subscribers.size === 0) {
      return;
    }
    clearTimer(watcher);
    if (watcher.checking) {
      watcher.recheckRequested = true;
      for (const id of resetIds) {
        watcher.resetRequested.add(id);
      }
      return;
    }

    watcher.checking = true;
    const requestedResetIds = new Set([...watcher.resetRequested, ...resetIds]);
    watcher.resetRequested.clear();
    const pendingSelfWrites = new Map(watcher.pendingSelfWrites);
    try {
      const snapshot = await readSnapshot(
        watcher.root,
        pendingSelfWrites.keys(),
        Object.keys(watcher.snapshot?.pathSignatures ?? {}),
      );
      const pendingWritesChanged =
        watcher.pendingSelfWrites.size !== pendingSelfWrites.size ||
        [...pendingSelfWrites].some(
          ([path, pendingWrite]) =>
            watcher.pendingSelfWrites.get(path)?.generation !== pendingWrite.generation,
        );
      if (pendingWritesChanged) {
        watcher.recheckRequested = true;
        for (const id of requestedResetIds) {
          watcher.resetRequested.add(id);
        }
        return;
      }
      if ([...pendingSelfWrites.values()].some(({ completed }) => !completed)) {
        for (const id of requestedResetIds) {
          watcher.resetRequested.add(id);
        }
        return;
      }

      for (const [id, subscriber] of watcher.subscribers) {
        if (requestedResetIds.has(id) || subscriber.snapshot == null) {
          subscriber.changed = false;
          subscriber.snapshot = snapshot;
          continue;
        }
        if (subscriber.changed) {
          continue;
        }

        const expectedPathVersions = new Map(
          [...pendingSelfWrites]
            .filter((entry) => entry[1].ownerId === id && entry[1].version)
            .map(([path, pendingWrite]) => [path, pendingWrite.version as string]),
        );
        if (
          repositoryWatcherSnapshotsMatchExpectedWrites(
            subscriber.snapshot,
            snapshot,
            expectedPathVersions,
          )
        ) {
          subscriber.snapshot = snapshot;
        } else {
          subscriber.changed = true;
          subscriber.notify(snapshot.root);
        }
      }

      watcher.snapshot = snapshot;
      for (const [path, pendingWrite] of pendingSelfWrites) {
        const currentWrite = watcher.pendingSelfWrites.get(path);
        if (pendingWrite.completed && currentWrite?.generation === pendingWrite.generation) {
          watcher.pendingSelfWrites.delete(path);
        }
      }
    } finally {
      watcher.checking = false;
      if (watcher.pendingSelfWrites.size > 0) {
        watcher.recheckRequested = false;
        schedule(watcher, SELF_WRITE_CHECK_DELAY);
      } else if (watcher.recheckRequested || watcher.resetRequested.size > 0) {
        watcher.recheckRequested = false;
        schedule(watcher, 0);
      } else {
        schedulePoll(watcher);
      }
    }
  };

  const detach = (id: number) => {
    const root = subscriberRoots.get(id);
    if (!root) {
      return;
    }
    subscriberRoots.delete(id);
    const watcher = watchers.get(root);
    if (!watcher) {
      return;
    }
    watcher.subscribers.delete(id);
    watcher.resetRequested.delete(id);
    for (const [path, pendingWrite] of watcher.pendingSelfWrites) {
      if (pendingWrite.ownerId === id) {
        watcher.pendingSelfWrites.delete(path);
      }
    }
    if (watcher.subscribers.size === 0) {
      clearTimer(watcher);
      watchers.delete(root);
    } else {
      schedule(watcher, 0);
    }
  };

  return {
    async attach(subscriber: {
      getState: () => { focused: boolean; visible: boolean };
      id: number;
      notify: (root: string) => void;
      root: string;
    }) {
      const currentRoot = subscriberRoots.get(subscriber.id);
      if (currentRoot && currentRoot !== subscriber.root) {
        detach(subscriber.id);
      }

      let watcher = watchers.get(subscriber.root);
      if (!watcher) {
        watcher = {
          checking: false,
          pendingSelfWrites: new Map(),
          recheckRequested: false,
          resetRequested: new Set(),
          root: subscriber.root,
          subscribers: new Map(),
        };
        watchers.set(subscriber.root, watcher);
      }
      watcher.subscribers.set(subscriber.id, {
        changed: false,
        getState: subscriber.getState,
        notify: subscriber.notify,
        snapshot: watcher.snapshot,
      });
      subscriberRoots.set(subscriber.id, subscriber.root);

      if (watcher.snapshot == null) {
        await check(watcher, [subscriber.id]);
      } else {
        schedulePoll(watcher);
      }
    },

    beginWrite(id: number, path: string) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      const subscriber = watcher?.subscribers.get(id);
      if (!root || !watcher || !subscriber || subscriber.changed) {
        return null;
      }

      const normalizedPath = normalizeRepositoryWatcherPath(path);
      const generation = (watcher.pendingSelfWrites.get(normalizedPath)?.generation ?? 0) + 1;
      watcher.pendingSelfWrites.set(normalizedPath, {
        completed: false,
        generation,
        ownerId: id,
      });
      if (watcher.checking) {
        watcher.recheckRequested = true;
      }
      return { generation, path: normalizedPath, root };
    },

    async checkNow(id: number) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      if (watcher) {
        await check(watcher);
      }
    },

    detach,

    finishWrite(
      token: { generation: number; path: string; root: string } | null,
      version: string | null,
    ) {
      if (!token) {
        return;
      }
      const watcher = watchers.get(token.root);
      const pendingWrite = watcher?.pendingSelfWrites.get(token.path);
      if (!watcher || pendingWrite?.generation !== token.generation) {
        return;
      }

      if (version) {
        pendingWrite.completed = true;
        pendingWrite.version = version;
      } else {
        watcher.pendingSelfWrites.delete(token.path);
      }
      schedule(watcher, SELF_WRITE_CHECK_DELAY);
    },

    focus(id: number) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      if (watcher?.subscribers.get(id)?.changed === false) {
        schedule(watcher, 0);
      }
    },

    getWatcherCount() {
      return watchers.size;
    },

    getWatcherSubscriberCount(root: string) {
      return watchers.get(root)?.subscribers.size ?? 0;
    },

    async reset(id: number, root: string) {
      const watcherRoot = subscriberRoots.get(id);
      const watcher = watcherRoot === root ? watchers.get(root) : undefined;
      if (watcher) {
        await check(watcher, [id]);
      }
    },

    visibilityChanged(id: number) {
      const root = subscriberRoots.get(id);
      const watcher = root ? watchers.get(root) : undefined;
      if (watcher) {
        schedulePoll(watcher);
      }
    },
  };
};

export {
  createRepositoryWatcherCoordinator,
  getRepositoryWatcherPollInterval,
  normalizeRepositoryWatcherPath,
  parseRepositoryWatcherStatus,
  readRepositoryChangeSignature,
  readRepositoryWatcherSnapshot,
  repositoryWatcherSnapshotsMatchExpectedWrites,
};
