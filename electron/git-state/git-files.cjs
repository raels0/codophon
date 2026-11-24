// @ts-check

const {
  EAGER_TEXT_FILE_LIMIT,
  MANUAL_TEXT_FILE_LIMIT,
  bufferToTextFile,
  chunk,
  createLargeBlobResult,
  createEmptyFileContent,
  git,
  gitBufferWithInput,
} = require('./common.cjs');

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @param {ReadonlyArray<string>} paths
 */
const readTreeEntries = async (repoRoot, ref, paths) => {
  /** @type {Map<string, {object: string; type: string}>} */
  const entries = new Map();
  const uniquePaths = [...new Set(paths)];

  for (const pathChunk of chunk(uniquePaths, 200)) {
    const raw = await git(repoRoot, [
      'ls-tree',
      '-rz',
      ref,
      '--',
      ...pathChunk.map((path) => `:(literal)${path}`),
    ]);
    for (const record of raw.split('\0')) {
      if (!record) {
        continue;
      }

      const tabIndex = record.indexOf('\t');
      if (tabIndex === -1) {
        continue;
      }

      const [mode, type, object] = record.slice(0, tabIndex).split(' ');
      const path = record.slice(tabIndex + 1);
      if (mode && type && object) {
        entries.set(path, { object, type });
      }
    }
  }

  return entries;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} objects
 */
const readObjectSizes = async (repoRoot, objects) => {
  /** @type {Map<string, {size: number; type: string}>} */
  const sizes = new Map();
  const uniqueObjects = [...new Set(objects)];
  if (uniqueObjects.length === 0) {
    return sizes;
  }

  const output = (
    await gitBufferWithInput(
      repoRoot,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      `${uniqueObjects.join('\n')}\n`,
    )
  ).toString('utf8');

  for (const line of output.split('\n')) {
    if (!line) {
      continue;
    }

    const [object, type, size] = line.split(' ');
    if (object && type && size && type !== 'missing') {
      sizes.set(object, {
        size: Number(size),
        type,
      });
    }
  }

  return sizes;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<{object: string; size: number}>} objects
 */
const readObjectContents = async (repoRoot, objects) => {
  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  /** @type {Array<{object: string; size: number}>} */
  let batch = [];
  let batchSize = 0;

  const flush = async () => {
    if (batch.length === 0) {
      return;
    }

    const output = await gitBufferWithInput(
      repoRoot,
      ['cat-file', '--batch'],
      `${batch.map((item) => item.object).join('\n')}\n`,
    );
    let offset = 0;

    for (const item of batch) {
      const headerEnd = output.indexOf(10, offset);
      if (headerEnd === -1) {
        break;
      }

      const header = output.subarray(offset, headerEnd).toString('utf8');
      const [, type, sizeText] = header.split(' ');
      const size = Number(sizeText);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;

      if (type === 'blob' && Number.isFinite(size)) {
        contents.set(item.object, output.subarray(contentStart, contentEnd));
      }

      offset = contentEnd + 1;
    }

    batch = [];
    batchSize = 0;
  };

  for (const item of objects) {
    if (batchSize > 0 && batchSize + item.size > 32 * 1024 * 1024) {
      await flush();
    }

    batch.push(item);
    batchSize += item.size;
  }

  await flush();
  return contents;
};

/**
 * Read many files from one Git tree with a bounded number of Git processes.
 *
 * @param {string} repoRoot
 * @param {string} ref
 * @param {ReadonlyArray<string>} paths
 * @param {{force?: boolean; refScopedEmptyCacheKey?: boolean}} [options]
 * @returns {Promise<Map<string, import('./common.cjs').FileContentResult>>}
 */
const readGitFiles = async (repoRoot, ref, paths, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const entries = await readTreeEntries(repoRoot, ref, paths);
  const sizes = await readObjectSizes(
    repoRoot,
    [...entries.values()].filter((entry) => entry.type === 'blob').map((entry) => entry.object),
  );
  const readableObjects = [...sizes.entries()]
    .map(([object, details]) =>
      details.type === 'blob' && details.size <= limit
        ? {
            object,
            size: details.size,
          }
        : null,
    )
    .filter(Boolean);
  const contents = await readObjectContents(repoRoot, readableObjects);
  /** @type {Map<string, import('./common.cjs').FileContentResult>} */
  const files = new Map();

  for (const path of paths) {
    const entry = entries.get(path);
    const object = entry && sizes.get(entry.object);
    const emptyKey = options.refScopedEmptyCacheKey ? `${ref}:${path}:empty` : undefined;
    if (!entry || !object || object.type !== 'blob') {
      files.set(path, createEmptyFileContent(path, emptyKey));
      continue;
    }

    if (object.size > limit) {
      files.set(path, createLargeBlobResult(object.size, limit));
      continue;
    }

    const buffer = contents.get(entry.object);
    files.set(
      path,
      buffer
        ? bufferToTextFile(path, buffer, `${ref}:${path}`)
        : createEmptyFileContent(path, emptyKey),
    );
  }

  return files;
};

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<{path: string; oldPath?: string}>} items
 * @param {Parameters<typeof readGitFiles>[3]} [options]
 */
const readGitFilePairs = async (repoRoot, newRef, oldRef, items, options) => {
  const [oldFiles, newFiles] = await Promise.all([
    oldRef
      ? readGitFiles(
          repoRoot,
          oldRef,
          items.map((item) => item.oldPath || item.path),
          options,
        )
      : new Map(),
    readGitFiles(
      repoRoot,
      newRef,
      items.map((item) => item.path),
      options,
    ),
  ]);
  return { oldFiles, newFiles };
};

module.exports = {
  readGitFilePairs,
  readGitFiles,
};
