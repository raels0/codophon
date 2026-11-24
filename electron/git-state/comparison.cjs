// @ts-check

const { sep } = require('node:path');
const {
  chunk,
  createEmptyFileContent,
  fileSort,
  getFingerprint,
  git,
  normalizeStatus,
  readGitImageFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const { readGitFilePairs } = require('./git-files.cjs');

/**
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').FileContentResult} FileContentResult
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} ComparisonItem
 * @typedef {Extract<ReviewSource, {type: 'branch-diff' | 'range' | 'commit' | 'pull-request'}>} SnapshotSource
 * @typedef {{ repoRoot: string; newRef: string; oldRef?: string; source: SnapshotSource; status: ComparisonItem[] }} ComparisonSnapshot
 */

/**
 * @param {string} raw
 * @param {{sort?: boolean}} [options]
 * @returns {Array<ComparisonItem>}
 */
const parseCommitNameStatus = (raw, options = {}) => {
  const parts = raw.split('\0').filter(Boolean);
  /** @type {Array<ComparisonItem>} */
  const files = [];

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

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {SnapshotSource} source
 * @returns {Promise<ComparisonSnapshot>}
 */
const readComparisonSnapshot = async (repoRoot, newRef, oldRef, source) => ({
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

/** @param {string} newRef @param {string | undefined} oldRef @param {ReadonlyArray<string>} paths */
const createComparisonPatchArgs = (newRef, oldRef, paths) =>
  oldRef
    ? ['diff', '--patch', '--no-ext-diff', '--find-renames', oldRef, newRef, '--', ...paths]
    : ['show', '--format=', '--patch', '--no-ext-diff', '--find-renames', newRef, '--', ...paths];

/** @param {string} repoRoot @param {string} newRef @param {string | undefined} oldRef @param {string} path */
const readComparisonPatch = (repoRoot, newRef, oldRef, path) =>
  git(repoRoot, createComparisonPatchArgs(newRef, oldRef, [path]));

/** @param {string} patch */
const splitCommitPatch = (patch) =>
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => `${part}\n`);

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'path'>>} items
 */
const readComparisonPatches = async (repoRoot, newRef, oldRef, items) => {
  /** @type {Map<string, string>} */
  const patches = new Map();

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

/**
 * @param {ComparisonSnapshot} snapshot
 * @param {ComparisonItem[]} items
 * @param {{force?: boolean}} [options]
 */
const readComparisonContents = async ({ repoRoot, newRef, oldRef }, items, options) => {
  const { oldFiles, newFiles } = await readGitFilePairs(repoRoot, newRef, oldRef, items, options);
  return items.map((item) => {
    const oldPath = item.oldPath || item.path;
    const oldFile = oldFiles.get(oldPath) ?? createEmptyFileContent(oldPath);
    const newFile = newFiles.get(item.path) ?? createEmptyFileContent(item.path);
    return { item, oldFile, newFile, summary: summarizeContent(oldFile, newFile) };
  });
};

/**
 * @param {ComparisonSnapshot} snapshot
 * @param {Awaited<ReturnType<typeof readComparisonContents>>[number]} content
 * @param {string} patch
 * @param {string} [path]
 * @returns {import('../../core/types.ts').DiffSection}
 */
const createComparisonSection = (
  { newRef, source },
  { item, oldFile, newFile, summary },
  patch,
  path = item.path,
) => ({
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

/** @param {string} launchPath @param {ComparisonSnapshot} snapshot @returns {Promise<RepositoryState>} */
const readComparisonState = async (launchPath, snapshot) => {
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

/** @param {ComparisonSnapshot} snapshot @param {string} requestedPath */
const findComparisonItem = ({ status, source }, requestedPath) => {
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

/** @param {ComparisonSnapshot} snapshot @param {string} path @param {{force?: boolean}} [options] */
const readComparisonSectionContent = async (snapshot, path, options) => {
  const item = findComparisonItem(snapshot, path);
  const [content] = await readComparisonContents(snapshot, [item], options);
  const patch =
    content.summary.loadState === 'ready'
      ? await readComparisonPatch(snapshot.repoRoot, snapshot.newRef, snapshot.oldRef, item.path)
      : '';
  return createComparisonSection(snapshot, content, patch, path);
};

/** @param {ComparisonSnapshot | Promise<ComparisonSnapshot>} comparison @param {string} path @returns {Promise<DiffImageContentResult>} */
const readComparisonImageContent = async (comparison, path) => {
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

module.exports = {
  parseCommitNameStatus,
  readComparisonSnapshot,
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
};
