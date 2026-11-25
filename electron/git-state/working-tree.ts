import type {
  ChangedFile,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
  RepositoryState,
} from '../../core/types.ts';
import { readRepositoryChangeSignature } from '../repository-watcher.ts';
import type { StatusItem } from './common.ts';
import {
  createSection,
  createSummary,
  fileSort,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  createWorkingTreeChangedFile,
  gitOrEmpty,
  getGravatarHash,
  getWhitespaceDiffArgs,
  git,
  readRepositoryRoot,
  MAX_UNTRACKED_INITIAL_ITEMS,
  parseStatus,
  readFileStat,
  readGitImageFile,
  readIndexImageFile,
  readWorkingTreeImageFile,
  validateRepositoryPath,
} from './common.ts';

export type WorkingTreeSectionKind = 'staged' | 'unstaged';

const diffGitHeaderPattern = /^diff --git (.+)$/;

const unquoteGitPath = (value: string) => {
  if (!value.startsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value.slice(1, value.endsWith('"') ? -1 : undefined);
  }
};

const splitDiffGitHeader = (line: string) => {
  const match = line.match(diffGitHeaderPattern);
  if (!match) {
    return null;
  }

  const paths = [];
  let index = 0;
  const value = match[1];
  while (index < value.length && paths.length < 2) {
    while (value[index] === ' ') {
      index += 1;
    }

    if (value[index] === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < value.length) {
        const char = value[end];
        if (char === '"' && !escaped) {
          end += 1;
          break;
        }
        escaped = char === '\\' && !escaped;
        if (char !== '\\') {
          escaped = false;
        }
        end += 1;
      }
      paths.push(unquoteGitPath(value.slice(index, end)));
      index = end;
      continue;
    }

    const end = value.indexOf(' ', index);
    if (end === -1) {
      paths.push(value.slice(index));
      break;
    }

    paths.push(value.slice(index, end));
    index = end + 1;
  }

  return paths.length === 2 ? paths : null;
};

const stripGitDiffPrefix = (path: string) =>
  path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;

const splitPatchByPath = (rawPatch: string): Map<string, { binary: boolean; patch: string }> => {
  const patches = new Map();
  const starts = [];
  const pattern = /^diff --git .+$/gm;
  let match;

  while ((match = pattern.exec(rawPatch))) {
    starts.push(match.index);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? rawPatch.length;
    const patch = rawPatch.slice(start, end);
    const header = patch.slice(0, patch.indexOf('\n') === -1 ? patch.length : patch.indexOf('\n'));
    const paths = splitDiffGitHeader(header);
    const path = paths ? stripGitDiffPrefix(paths[1]) : null;
    if (path) {
      patches.set(path, {
        binary: /Binary files .* differ/.test(patch),
        patch,
      });
    }
  }

  return patches;
};

const readPatchMap = async (
  repoRoot: string,
  kind: WorkingTreeSectionKind,
  options: { showWhitespace?: boolean } = {},
): Promise<Map<string, { binary: boolean; patch: string }>> => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  const args =
    kind === 'staged'
      ? ['diff', '--cached', '--patch', '--no-ext-diff', ...whitespaceArgs]
      : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs];
  return splitPatchByPath(await git(repoRoot, args));
};

const listUntrackedItems = async (repoRoot: string): Promise<Array<StatusItem>> => {
  const [rawFiles, rawDirectories] = await Promise.all([
    git(repoRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.',
      ...generatedDirectoryPathspecExcludes,
    ]),
    git(repoRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--directory',
      '-z',
      '--',
      ...generatedDirectoryPathspecs,
    ]),
  ]);
  const paths = rawFiles.split('\0').filter(Boolean).sort();

  const items: Array<StatusItem> = paths.slice(0, MAX_UNTRACKED_INITIAL_ITEMS).map((path) => ({
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  }));

  if (paths.length > MAX_UNTRACKED_INITIAL_ITEMS) {
    const omitted = paths.length - MAX_UNTRACKED_INITIAL_ITEMS;
    items.push({
      directory: true,
      path: `Untracked files not shown (${omitted} more)`,
      staged: false,
      status: 'untracked',
      summary: createSummary(`${omitted} untracked files are not shown.`, {
        canLoad: false,
        fileCount: omitted,
        loadState: 'directory',
      }),
      unstaged: true,
      untracked: true,
    });
  }

  for (const path of rawDirectories.split('\0').filter(Boolean)) {
    items.push({
      directory: true,
      path: path.endsWith('/') ? path.slice(0, -1) : path,
      staged: false,
      status: 'untracked',
      unstaged: true,
      untracked: true,
    });
  }

  const unique = new Map();
  for (const item of items) {
    unique.set(item.path, item);
  }

  return [...unique.values()].sort(fileSort);
};

const readWorkingTreeState = async (
  launchPath: string,
  options: { eagerContents?: boolean; showWhitespace?: boolean } = {},
): Promise<Omit<RepositoryState, 'branch'>> => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const shouldUsePatchOnly = options.eagerContents === false;
  const [trackedStatus, untrackedItems, stagedPatches, unstagedPatches] = await Promise.all([
    git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
    listUntrackedItems(repoRoot),
    shouldUsePatchOnly ? readPatchMap(repoRoot, 'staged', options) : new Map(),
    shouldUsePatchOnly ? readPatchMap(repoRoot, 'unstaged', options) : new Map(),
  ]);
  const status = [...parseStatus(trackedStatus), ...untrackedItems].sort(fileSort);

  const files: Array<ChangedFile> = [];

  for (const item of status) {
    const sections: Array<DiffSection> = [];

    if (item.staged) {
      sections.push(
        await createSection(repoRoot, item, 'staged', {
          patch: stagedPatches.get(item.path),
          patchOnly: shouldUsePatchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    if (item.unstaged) {
      sections.push(
        await createSection(repoRoot, item, 'unstaged', {
          patch: item.status === 'conflicted' ? undefined : unstagedPatches.get(item.path),
          patchOnly: shouldUsePatchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    files.push(createWorkingTreeChangedFile(item, sections));
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

const getStatusItemForPath = async (repoRoot: string, path: string): Promise<StatusItem> => {
  const trackedStatus = parseStatus(
    await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
  );
  const trackedItem = trackedStatus.find((item) => item.path === path);
  if (trackedItem) {
    return trackedItem;
  }

  const stat = await readFileStat(repoRoot, path);
  return {
    directory: Boolean(stat?.isDirectory()),
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  };
};

const readDiffSectionContent = async (launchPath: string, request: DiffSectionContentRequest) => {
  const repoRoot = await readRepositoryRoot(launchPath);
  const path = validateRepositoryPath(request.path);
  if (request.kind === 'commit' || request.source?.type === 'commit') {
    throw new Error('Lazy loading commit diffs is not supported.');
  }

  const item = await getStatusItemForPath(repoRoot, path);
  return createSection(repoRoot, item, request.kind as WorkingTreeSectionKind, {
    force: request.force,
    showWhitespace: request.showWhitespace,
  });
};

const readDiffImageContent = async (
  launchPath: string,
  request: DiffImageContentRequest,
): Promise<DiffImageContentResult> => {
  try {
    const repoRoot = await readRepositoryRoot(launchPath);
    const path = validateRepositoryPath(request.path);
    if (request.kind === 'commit' || request.source?.type === 'commit') {
      throw new Error('Commit image diffs are loaded through the commit reader.');
    }

    const item = await getStatusItemForPath(repoRoot, path);
    const oldPath = item.oldPath || item.path;
    const [oldImage, newImage] =
      request.kind === 'staged'
        ? await Promise.all([
            readGitImageFile(repoRoot, 'HEAD', oldPath),
            readIndexImageFile(repoRoot, item.path),
          ])
        : await Promise.all([
            item.untracked
              ? undefined
              : readIndexImageFile(repoRoot, item.path, item.conflictStage),
            readWorkingTreeImageFile(repoRoot, item.path),
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

const readGitIdentity = async (launchPath: string) => {
  const [configuredName, configuredEmail] = await Promise.all([
    gitOrEmpty(launchPath, ['config', '--get', 'user.name']),
    gitOrEmpty(launchPath, ['config', '--get', 'user.email']),
  ]);
  const email = configuredEmail.trim();
  const name = configuredName.trim();

  return {
    email,
    gravatarUrl: email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined,
    name,
  };
};

export {
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
};
