import { sep } from 'node:path';
import type { DiffImageContentResult, RepositoryState, ReviewSource } from '../../core/types.ts';
import type { StatusItem } from './common.ts';
import {
  chunk,
  createEmptyFileContent,
  fileSort,
  getFingerprint,
  git,
  normalizeStatus,
  readGitImageFile,
  summarizeContent,
  validateRepositoryPath,
} from './common.ts';
import { readGitFilePairs } from './git-files.ts';

export type ComparisonItem = Pick<StatusItem, 'oldPath' | 'path' | 'status'>;

export type SnapshotSource = Extract<
  ReviewSource,
  { type: 'branch-diff' | 'range' | 'commit' | 'pull-request' }
>;

export type ComparisonSnapshot = {
  repoRoot: string;
  newRef: string;
  oldRef?: string;
  source: SnapshotSource;
  status: ComparisonItem[];
};

const parseCommitNameStatus = (
  raw: string,
  options: { sort?: boolean } = {},
): Array<ComparisonItem> => {
  const parts = raw.split('\0').filter(Boolean);

  const files: Array<ComparisonItem> = [];

  for (let index = 0; index < parts.length;) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];

    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        oldPath,
        path,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        path,
        status: normalizeStatus(statusType),
      });
    }
  }

  return options.sort === false ? files : files.sort(fileSort);
};

const readComparisonSnapshot = async (
  repoRoot: string,
  newRef: string,
  oldRef: string | undefined,
  source: SnapshotSource,
): Promise<ComparisonSnapshot> => ({
  newRef,
  oldRef,
  repoRoot,
  source,
  // Batched patches follow Git's order; readComparisonState sorts the finished files.
  status: parseCommitNameStatus(
    await git(
      repoRoot,
      oldRef
        ? ['diff', '--name-status', '-r', '-z', '-M', oldRef, newRef]
        : ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', newRef],
    ),
    { sort: false },
  ),
});

const createComparisonPatchArgs = (
  newRef: string,
  oldRef: string | undefined,
  paths: ReadonlyArray<string>,
) =>
  oldRef
    ? ['diff', '--patch', '--no-ext-diff', '--find-renames', oldRef, newRef, '--', ...paths]
    : ['show', '--format=', '--patch', '--no-ext-diff', '--find-renames', newRef, '--', ...paths];

const readComparisonPatch = (
  repoRoot: string,
  newRef: string,
  oldRef: string | undefined,
  path: string,
) => git(repoRoot, createComparisonPatchArgs(newRef, oldRef, [path]));

const splitCommitPatch = (patch: string) =>
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => `${part}\n`);

const readComparisonPatches = async (
  repoRoot: string,
  newRef: string,
  oldRef: string | undefined,
  items: ReadonlyArray<Pick<StatusItem, 'path'>>,
) => {
  const patches: Map<string, string> = new Map();

  for (const itemChunk of chunk(
    items.map((item) => item.path),
    200,
  )) {
    const patch = await git(repoRoot, createComparisonPatchArgs(newRef, oldRef, itemChunk));
    const patchChunks = splitCommitPatch(patch);

    if (patchChunks.length === itemChunk.length) {
      for (let index = 0; index < itemChunk.length; index += 1) {
        patches.set(itemChunk[index], patchChunks[index]);
      }
    } else {
      await Promise.all(
        itemChunk.map(async (path) => {
          patches.set(path, await readComparisonPatch(repoRoot, newRef, oldRef, path));
        }),
      );
    }
  }

  return patches;
};

const readComparisonContents = async (
  { repoRoot, newRef, oldRef }: ComparisonSnapshot,
  items: ComparisonItem[],
  options?: { force?: boolean },
) => {
  const { oldFiles, newFiles } = await readGitFilePairs(repoRoot, newRef, oldRef, items, options);
  return items.map((item) => {
    const oldPath = item.oldPath || item.path;
    const oldFile = oldFiles.get(oldPath) ?? createEmptyFileContent(oldPath);
    const newFile = newFiles.get(item.path) ?? createEmptyFileContent(item.path);
    return { item, oldFile, newFile, summary: summarizeContent(oldFile, newFile) };
  });
};

const createComparisonSection = (
  { newRef, source }: ComparisonSnapshot,
  { item, oldFile, newFile, summary }: Awaited<ReturnType<typeof readComparisonContents>>[number],
  patch: string,
  path: string = item.path,
): import('../../core/types.ts').DiffSection => ({
  binary: summary.binary || /Binary files .* differ/.test(patch),
  id:
    source.type === 'pull-request'
      ? `${path}:pull-request:${source.number}`
      : `${item.path}:${newRef}`,
  kind: source.type === 'pull-request' ? 'pull-request' : 'commit',
  loadState: summary.loadState,
  newFile: newFile.file,
  oldFile: oldFile.file,
  patch,
  summary: summary.summary,
});

const readComparisonState = async (
  launchPath: string,
  snapshot: ComparisonSnapshot,
): Promise<Omit<RepositoryState, 'branch'>> => {
  const { newRef, oldRef, repoRoot, source, status } = snapshot;
  const contents = await readComparisonContents(snapshot, status);
  const readyItems = contents
    .filter(({ summary }) => summary.loadState === 'ready')
    .map(({ item }) => item);
  const patches = await readComparisonPatches(repoRoot, newRef, oldRef, readyItems);
  const files = contents
    .map((content) => {
      const { item } = content;
      const patch = patches.get(item.path) || '';
      const section = createComparisonSection(snapshot, content, patch);
      return {
        ...item,
        oldPath: item.oldPath,
        fingerprint: getFingerprint(
          `${newRef}\n${item.status}\n${item.oldPath || ''}\n${section.loadState || 'ready'}\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${patch}\n${section.oldFile?.contents || ''}\n${section.newFile?.contents || ''}`,
        ),
        sections: [section],
      };
    })
    .sort(fileSort);
  return { files, generatedAt: Date.now(), launchPath, root: repoRoot, source };
};

const findComparisonItem = ({ status, source }: ComparisonSnapshot, requestedPath: string) => {
  const path = validateRepositoryPath(requestedPath).split(sep).join('/');
  const item = status.find((candidate) => candidate.path === path);
  if (!item) {
    const label =
      source.type === 'pull-request'
        ? 'pull request'
        : source.type === 'branch-diff'
          ? 'branch'
          : source.type;
    throw new Error(`File is not part of this ${label}.`);
  }
  return item;
};

const readComparisonSectionContent = async (
  snapshot: ComparisonSnapshot,
  path: string,
  options?: { force?: boolean },
) => {
  const item = findComparisonItem(snapshot, path);
  const [content] = await readComparisonContents(snapshot, [item], options);
  const patch =
    content.summary.loadState === 'ready'
      ? await readComparisonPatch(snapshot.repoRoot, snapshot.newRef, snapshot.oldRef, item.path)
      : '';
  return createComparisonSection(snapshot, content, patch, path);
};

const readComparisonImageContent = async (
  comparison: ComparisonSnapshot | Promise<ComparisonSnapshot>,
  path: string,
): Promise<DiffImageContentResult> => {
  try {
    const snapshot = await comparison;
    const { repoRoot, oldRef, newRef } = snapshot;
    const item = findComparisonItem(snapshot, path);
    const [oldImage, newImage] = await Promise.all([
      oldRef ? readGitImageFile(repoRoot, oldRef, item.oldPath || item.path) : undefined,
      readGitImageFile(repoRoot, newRef, item.path),
    ]);

    if (!oldImage && !newImage) {
      return {
        reason: 'Codophon could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codophon could not load this image.',
      status: 'unavailable',
    };
  }
};

export {
  parseCommitNameStatus,
  readComparisonSnapshot,
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
};
