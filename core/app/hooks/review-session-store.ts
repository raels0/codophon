import type { ReviewIdentity, SourceSession } from '../../lib/app-types.ts';
import { getChangedPaths } from '../../lib/reload-selection.ts';
import {
  getFileReviewIdentity,
  getWalkthroughReviewKeyPrefix,
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from '../../lib/review-identity.ts';
import { usesViewedFileState } from '../../lib/source.ts';
import { readViewedForState, writeViewed } from '../../lib/viewed.ts';
import type { ChangedFile, DiffSection, RepositoryState } from '../../types.ts';
import { SnapshotStore } from './snapshot-store.ts';

type ReviewSnapshot = {
  collapsed: Set<string>;
  expandedReviewKeys: Set<string>;
  itemVersionByKey: Record<string, number>;
  reloadDeltaPaths: ReadonlySet<string>;
  repository: RepositoryState | null;
  selectedPath: string | null;
  viewed: Record<string, string>;
};

export type SnapshotLoad =
  | { delta: ReadonlySet<string>; reason: 'launch'; selectedPath: string | null }
  | { reason: 'switch'; session?: SourceSession }
  | { reason: 'refresh' | 'whitespace' }
  | { reason: 'save'; savedPath: string };

const withMembership = (keys: Set<string>, key: string, present: boolean) => {
  const next = new Set(keys);
  if (present) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
};

export class ReviewSessionStore extends SnapshotStore<ReviewSnapshot> {
  constructor() {
    super({
      collapsed: new Set(),
      expandedReviewKeys: new Set(),
      itemVersionByKey: {},
      reloadDeltaPaths: new Set(),
      repository: null,
      selectedPath: null,
      viewed: {},
    });
  }

  private generation = 0;
  getGeneration = () => this.generation;
  invalidateSections = () => {
    this.generation++;
  };
  getRepository = () => this.getSnapshot().repository;
  getViewed = () => this.getSnapshot().viewed;
  setViewed = (viewed: Record<string, string>) => this.publish({ viewed });
  setSelectedPath = (selectedPath: string | null) => {
    if (selectedPath !== this.getSnapshot().selectedPath) {
      this.publish({ selectedPath });
    }
  };
  bumpItemVersion = (key: string) => {
    const { itemVersionByKey } = this.getSnapshot();
    this.publish({
      itemVersionByKey: { ...itemVersionByKey, [key]: (itemVersionByKey[key] ?? 0) + 1 },
    });
  };

  private installListeners = new Set<
    (next: RepositoryState, previous: RepositoryState | null, load: SnapshotLoad) => void
  >();
  onInstall = (
    listener: (next: RepositoryState, previous: RepositoryState | null, load: SnapshotLoad) => void,
  ) => {
    this.installListeners.add(listener);
    return () => {
      this.installListeners.delete(listener);
    };
  };
  install(repository: RepositoryState, load: SnapshotLoad) {
    const current = this.getSnapshot();
    const session = load.reason === 'switch' ? load.session : undefined;
    const previous = load.reason === 'launch' || load.reason === 'switch' ? session : current;
    const selection = load.reason === 'launch' ? load.selectedPath : previous?.selectedPath;
    const selectedPath = repository.files.some((file) => file.path === selection)
      ? (selection ?? null)
      : (repository.files[0]?.path ?? null);
    const viewed =
      load.reason === 'save' ? current.viewed : readViewedForState(repository, previous?.viewed);
    const delta =
      load.reason === 'refresh' || load.reason === 'save'
        ? getChangedPaths(current.repository?.files ?? [], repository.files)
        : new Set<string>();
    const preserveOverrides = load.reason !== 'whitespace' && previous;
    const collapsed = preserveOverrides
      ? new Set(previous.collapsed)
      : new Set(
          repository.files
            .filter((file) => viewed[file.path] === file.fingerprint)
            .map((file) => file.path),
        );
    const expandedReviewKeys = new Set(preserveOverrides ? previous.expandedReviewKeys : []);
    const itemVersionByKey =
      load.reason === 'save' || load.reason === 'refresh' ? { ...current.itemVersionByKey } : {};
    for (const path of delta) {
      collapsed.delete(path);
      itemVersionByKey[path] = (itemVersionByKey[path] ?? 0) + 1;
    }
    if (load.reason === 'save' && !delta.size) {
      itemVersionByKey[load.savedPath] = (itemVersionByKey[load.savedPath] ?? 0) + 1;
    }
    if (
      previous &&
      (load.reason === 'refresh' || (load.reason === 'switch' && repository.viewedFiles))
    ) {
      for (const { fingerprint, path } of repository.files) {
        const isViewed = viewed[path] === fingerprint;
        if (isViewed === (previous.viewed[path] === fingerprint)) {
          continue;
        }
        expandedReviewKeys.delete(path);
        if (isViewed) {
          collapsed.add(path);
        } else {
          collapsed.delete(path);
        }
      }
    }
    this.invalidateSections();
    this.publish({
      collapsed,
      expandedReviewKeys,
      itemVersionByKey,
      reloadDeltaPaths:
        load.reason === 'launch'
          ? load.delta
          : load.reason === 'save'
            ? current.reloadDeltaPaths
            : delta,
      repository,
      selectedPath,
      viewed,
    });
    for (const listener of this.installListeners) {
      listener(repository, current.repository, load);
    }
  }

  patchSection(generation: number, path: string, section: DiffSection) {
    const { itemVersionByKey, repository } = this.getSnapshot();
    if (!repository || generation !== this.generation) {
      return;
    }
    this.publish({
      itemVersionByKey: { ...itemVersionByKey, [path]: (itemVersionByKey[path] ?? 0) + 1 },
      repository: {
        ...repository,
        files: repository.files.map((file) =>
          file.path !== path
            ? file
            : {
                ...file,
                sections: file.sections.map((candidate) =>
                  candidate.id === section.id ? section : candidate,
                ),
              },
        ),
      },
    });
  }

  toggleCollapsed = (file: ChangedFile, isCollapsed: boolean, key = file.path) => {
    const { collapsed, expandedReviewKeys, itemVersionByKey } = this.getSnapshot();
    this.publish({
      collapsed: withMembership(collapsed, key, !isCollapsed),
      expandedReviewKeys: withMembership(expandedReviewKeys, key, isCollapsed),
      itemVersionByKey: { ...itemVersionByKey, [key]: (itemVersionByKey[key] ?? 0) + 1 },
    });
  };

  toggleViewed = (
    file: ChangedFile,
    isViewed: boolean,
    identity: ReviewIdentity = getFileReviewIdentity(file),
  ) => {
    const current = this.getSnapshot();
    const viewed = updateReviewIdentityViewed(current.viewed, identity, isViewed);
    const fileKey = identity.coverage?.file.key ?? file.path;
    const prefix = getWalkthroughReviewKeyPrefix(fileKey);
    const clearOverrides = (keys: Set<string>) =>
      new Set(
        [...keys].filter(
          (key) =>
            key !== fileKey && (identity.coverage ? key !== identity.key : !key.startsWith(prefix)),
        ),
      );
    const resetFile = identity.coverage || identity.key === file.path;
    this.publish({
      collapsed: resetFile
        ? clearOverrides(current.collapsed)
        : updateReviewIdentityCollapsed(current.collapsed, identity, isViewed),
      expandedReviewKeys: resetFile
        ? clearOverrides(current.expandedReviewKeys)
        : withMembership(current.expandedReviewKeys, identity.key, false),
      itemVersionByKey: {
        ...current.itemVersionByKey,
        [identity.key]: (current.itemVersionByKey[identity.key] ?? 0) + 1,
      },
      viewed,
    });
    if (current.repository && usesViewedFileState(current.repository.source)) {
      writeViewed(current.repository.root, viewed);
    }
    return viewed;
  };
}
