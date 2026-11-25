import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type {
  ChangedFile,
  DiffImageRevision,
  DiffSection,
  GitFileStatus,
} from '../../core/types.ts';

export type WorkingTreeSectionKind = 'staged' | 'unstaged';

export type TextFile = { cacheKey: string; contents: string; name: string };

export type DiffSummary = {
  reason: string;
  canLoad?: boolean;
  fileCount?: number;
  fingerprint?: string;
  limit?: number;
  loadState?: DiffSection['loadState'];
  size?: number;
};

export type FileContentResult = {
  binary: boolean;
  file?: TextFile;
  fingerprint?: string;
  loadState?: DiffSection['loadState'];
  summary?: DiffSummary;
};

export type StatusItem = {
  conflictStage?: 1 | 2 | 3;
  directory?: boolean;
  oldPath?: string;
  path: string;
  staged: boolean;
  status: GitFileStatus;
  summary?: DiffSummary;
  unstaged: boolean;
  untracked: boolean;
};

export type ReadFileOptions = {
  force?: boolean;
  patch?: { binary: boolean; patch: string };
  patchOnly?: boolean;
  showWhitespace?: boolean;
};

export type PullRequestReference = { number: number; owner: string; repo: string; url: string };

export type GitHubRemote = { owner: string; repo: string };

export type GitHubPullRequestFile = {
  filename: string;
  patch: string;
  previous_filename?: string;
  status: string;
};

export type GitHubPullRequestMetadata = { head: { sha?: string }; title?: string };

export type GitHubReviewComment = { [key: string]: any };

const getFingerprint = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

const chunk = (values: ReadonlyArray<string>, size: number) => {
  const chunks: Array<Array<string>> = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const readRepositoryRoot = async (launchPath: string) =>
  (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();

const getGravatarHash = (email: string) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex');

const git = async (
  repoPath: string,
  args: ReadonlyArray<string>,
  options: { encoding?: BufferEncoding } = {},
): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: options.encoding || 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const gitBuffer = async (repoPath: string, args: ReadonlyArray<string>): Promise<Buffer> => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const gitBufferWithInput = (
  repoPath: string,
  args: ReadonlyArray<string>,
  input: string | Buffer,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Array<Buffer> = [];

    const stderr: Array<Buffer> = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        reject(error);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const error = new Error(
          Buffer.concat(stderr).toString('utf8') || `git exited with status ${code}`,
        );
        reject(error);
      }
    });

    child.stdin.end(input);
  });

const EAGER_TEXT_FILE_LIMIT = 1024 * 1024;
const MANUAL_TEXT_FILE_LIMIT = 2 * 1024 * 1024;
const IMAGE_FILE_LIMIT = 32 * 1024 * 1024;
const MAX_UNTRACKED_INITIAL_ITEMS = 1000;
const imageMimeTypes = new Map([
  ['.apng', 'image/apng'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const GENERATED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.next',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const generatedDirectoryPathspecExcludes = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  `:(exclude)${name}/**`,
  `:(exclude)**/${name}/**`,
]);

const generatedDirectoryPathspecs = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  name,
  `:(glob)**/${name}/`,
]);

const fileSort = (left: { path: string }, right: { path: string }) => {
  const leftParts = left.path.split('/');
  const rightParts = right.path.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
};

const parseStatus = (raw: string): Array<StatusItem> => {
  const parts = raw.split('\0').filter(Boolean);
  const files = new Map();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);

    let oldPath: string | undefined;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++index];
    }

    const current = files.get(path) || {
      oldPath,
      path,
      staged: false,
      status: 'modified',
      unstaged: false,
      untracked: false,
    };

    if (x === '?' && y === '?') {
      current.status = 'untracked';
      current.unstaged = true;
      current.untracked = true;
    } else if (['AA', 'AU', 'DD', 'DU', 'UA', 'UD', 'UU'].includes(`${x}${y}`)) {
      const conflictCode = `${x}${y}`;
      if (conflictCode === 'DD') {
        current.conflictStage = 1;
      } else if (conflictCode !== 'DU' && conflictCode !== 'UA') {
        current.conflictStage = 2;
      }
      current.staged = false;
      current.status = 'conflicted';
      current.unstaged = true;
    } else {
      current.staged = x !== ' ';
      current.unstaged = y !== ' ';

      const statusCode = current.staged ? x : y;
      current.status =
        statusCode === 'A'
          ? 'added'
          : statusCode === 'D'
            ? 'deleted'
            : statusCode === 'R' || statusCode === 'C'
              ? 'renamed'
              : 'modified';
    }

    files.set(path, current);
  }

  return [...files.values()].sort(fileSort);
};

const isBinaryBuffer = (buffer: Buffer) => buffer.includes(0);

const formatBytes = (size: number) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

const getImageMimeType = (path: string) => {
  const dotIndex = path.lastIndexOf('.');
  return dotIndex === -1 ? undefined : imageMimeTypes.get(path.slice(dotIndex).toLowerCase());
};

const bufferToImageRevision = (path: string, buffer: Buffer): DiffImageRevision => {
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }

  if (buffer.length > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(buffer.length)}, so Codophon skipped rendering it.`);
  }

  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    name: path,
    size: buffer.length,
  };
};

const createSummary = (reason: string, details: Partial<DiffSummary> = {}): DiffSummary => ({
  reason,
  ...details,
});

const validateRepositoryPath = (path: unknown) => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository path.');
  }

  if (path.split(/[\\/]+/u).includes('..')) {
    throw new Error('Invalid repository path.');
  }

  const normalized = normalize(path);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error('Invalid repository path.');
  }

  return normalized;
};

const readFileStat = async (repoRoot: string, path: string) => {
  try {
    return await fs.lstat(join(repoRoot, path));
  } catch {
    return undefined;
  }
};

const getBlobSize = async (repoRoot: string, spec: string) => {
  try {
    return Number((await git(repoRoot, ['cat-file', '-s', spec])).trim());
  } catch {
    return undefined;
  }
};

const bufferToTextFile = (name: string, buffer: Buffer, cacheKey: string): FileContentResult => {
  const fingerprint = getFingerprint(buffer);

  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      fingerprint,
      file: undefined,
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
        size: buffer.length,
      }),
    };
  }

  return {
    binary: false,
    file: {
      cacheKey,
      contents: buffer.toString('utf8'),
      name,
    },
  };
};

const readImageSpec = async (
  repoRoot: string,
  spec: string,
  path: string,
): Promise<DiffImageRevision | undefined> => {
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }

  const size = await getBlobSize(repoRoot, spec);
  if (size == null) {
    return undefined;
  }

  if (size > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(size)}, so Codophon skipped rendering it.`);
  }

  try {
    return bufferToImageRevision(path, await gitBuffer(repoRoot, ['show', spec]));
  } catch {
    return undefined;
  }
};

const readGitImageFile = (repoRoot: string, ref: string, path: string) =>
  readImageSpec(repoRoot, `${ref}:${path}`, path);

const readIndexImageFile = (repoRoot: string, path: string, stage?: 1 | 2 | 3) =>
  readImageSpec(repoRoot, stage ? `:${stage}:${path}` : `:${path}`, path);

const readWorkingTreeImageFile = async (repoRoot: string, path: string) => {
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }

  const stat = await readFileStat(repoRoot, path);
  if (!stat || !stat.isFile()) {
    return undefined;
  }

  if (stat.size > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(stat.size)}, so Codophon skipped rendering it.`);
  }

  return bufferToImageRevision(path, await fs.readFile(join(repoRoot, path)));
};

const createLargeBlobResult = (
  size: number,
  limit: number,
  label: string = 'File',
): FileContentResult => ({
  binary: false,
  loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
  summary: createSummary(
    size > MANUAL_TEXT_FILE_LIMIT
      ? `${label} is ${formatBytes(size)}, so Codophon skipped rendering it.`
      : `${label} is ${formatBytes(size)} and will be loaded on demand.`,
    {
      canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
      limit,
      size,
    },
  ),
});

const createEmptyFileContent = (path: string, cacheKey: string = `empty:${path}`) => ({
  binary: false,
  file: { cacheKey, contents: '', name: path },
});

const readTextSpec = async (
  repoRoot: string,
  spec: string,
  path: string,
  cacheKey: string,
  options: ReadFileOptions,
): Promise<FileContentResult> => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return createLargeBlobResult(size, limit);
    }
    return bufferToTextFile(path, await gitBuffer(repoRoot, ['show', spec]), cacheKey);
  } catch {
    return createEmptyFileContent(path, `${cacheKey}:empty`);
  }
};

const readGitFile = (repoRoot: string, ref: string, path: string, options: ReadFileOptions = {}) =>
  readTextSpec(repoRoot, `${ref}:${path}`, path, `${ref}:${path}`, options);

const readIndexFile = (
  repoRoot: string,
  path: string,
  options: ReadFileOptions = {},
  stage?: 1 | 2 | 3,
) =>
  readTextSpec(repoRoot, stage ? `:${stage}:${path}` : `:${path}`, path, `index:${path}`, options);

const readWorkingTreeFile = async (
  repoRoot: string,
  path: string,
  options: ReadFileOptions = {},
): Promise<FileContentResult> => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;

  try {
    const stat = await readFileStat(repoRoot, path);
    if (!stat) {
      throw new Error('File is missing.');
    }

    if (stat.isDirectory()) {
      return {
        binary: false,
        loadState: 'directory',
        summary: createSummary('Untracked directory is collapsed by default.', {
          canLoad: false,
        }),
      };
    }

    if (stat.isSymbolicLink()) {
      const contents = await fs.readlink(join(repoRoot, path));
      const size = Buffer.byteLength(contents);

      if (size > limit) {
        return createLargeBlobResult(size, limit, 'Symlink target');
      }

      return {
        binary: false,
        file: {
          cacheKey: `worktree:${path}:symlink:${contents}`,
          contents,
          name: path,
        },
      };
    }

    if (!stat.isFile()) {
      return {
        binary: false,
        loadState: 'error',
        summary: createSummary('Path is not a regular file.', {
          canLoad: false,
          size: stat.size,
        }),
      };
    }

    if (stat.size > limit) {
      return createLargeBlobResult(stat.size, limit);
    }

    const buffer = await fs.readFile(join(repoRoot, path));
    return bufferToTextFile(path, buffer, `worktree:${path}:${buffer.length}`);
  } catch {
    return createEmptyFileContent(path, `worktree:${path}:empty`);
  }
};

const createPatchForNewFile = (path: string, contents: string) => {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = contents.endsWith('\n') ? '' : '\n\\ No newline at end of file';

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(noNewline, '\n');
};

const getWhitespaceDiffArgs = (options: { showWhitespace?: boolean } = {}): Array<string> =>
  options.showWhitespace === false ? ['--ignore-all-space'] : [];

const getPatch = async (
  repoRoot: string,
  item: StatusItem,
  kind: WorkingTreeSectionKind,
  options: { showWhitespace?: boolean } = {},
) => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  if (item.status === 'conflicted' && !item.conflictStage) {
    const newFile = await readWorkingTreeFile(repoRoot, item.path, options);
    return {
      binary: newFile.binary,
      patch: newFile.file ? createPatchForNewFile(item.path, newFile.file.contents) : '',
    };
  }
  const args =
    item.status === 'conflicted'
      ? [
          'diff',
          item.conflictStage === 1 ? '--base' : item.conflictStage === 3 ? '--theirs' : '--ours',
          '--patch',
          '--no-ext-diff',
          ...whitespaceArgs,
          '--',
          item.path,
        ]
      : kind === 'staged'
        ? [
            'diff',
            '--cached',
            '--patch',
            '--no-ext-diff',
            ...whitespaceArgs,
            '--',
            ...(item.oldPath ? [item.oldPath] : []),
            item.path,
          ]
        : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs, '--', item.path];
  const rawPatch = await git(repoRoot, args);
  const diffStart = item.status === 'conflicted' ? rawPatch.indexOf('diff --git ') : -1;
  const patch =
    item.status !== 'conflicted' ? rawPatch : diffStart === -1 ? '' : rawPatch.slice(diffStart);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
};

const summarizeContent = (
  ...results: FileContentResult[]
): { binary: boolean; loadState: DiffSection['loadState']; summary?: DiffSummary } => {
  const binaryResults = results.filter((result) => result.binary);
  if (binaryResults.length > 0) {
    const fingerprint = getFingerprint(
      binaryResults
        .map((result) => `${result.fingerprint || ''}\0${result.summary?.size || ''}`)
        .join('\0'),
    );

    return {
      binary: true,
      loadState: 'binary',
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
      }),
    };
  }

  const summaryResult = results.find((result) => result.loadState && result.loadState !== 'ready');
  if (summaryResult) {
    return {
      binary: false,
      loadState: summaryResult.loadState,
      summary: summaryResult.summary,
    };
  }

  return {
    binary: false,
    loadState: 'ready',
  };
};

const getWorkingTreeContents = async (
  repoRoot: string,
  item: StatusItem,
  kind: WorkingTreeSectionKind,
  options: ReadFileOptions = {},
) => {
  if (kind === 'staged') {
    const [oldFile, newFile] = await Promise.all([
      readGitFile(repoRoot, 'HEAD', item.oldPath || item.path, options),
      readIndexFile(repoRoot, item.path, options),
    ]);
    const summary = summarizeContent(oldFile, newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: oldFile.file,
    };
  }

  if (item.untracked) {
    const newFile: FileContentResult = item.summary
      ? {
          binary: false,
          loadState: item.summary.loadState,
          summary: item.summary,
        }
      : item.directory
        ? {
            binary: false,
            loadState: 'directory',
            summary: createSummary('Untracked directory is collapsed by default.', {
              canLoad: false,
            }),
          }
        : await readWorkingTreeFile(repoRoot, item.path, options);
    const summary = summarizeContent(newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: {
        cacheKey: `empty:${item.path}`,
        contents: '',
        name: item.path,
      },
    };
  }

  const [oldFile, newFile] = await Promise.all([
    readIndexFile(repoRoot, item.path, options, item.conflictStage),
    readWorkingTreeFile(repoRoot, item.path, options),
  ]);
  const summary = summarizeContent(oldFile, newFile);

  return {
    ...summary,
    newFile: newFile.file,
    oldFile: oldFile.file,
  };
};

const createSection = async (
  repoRoot: string,
  item: StatusItem,
  kind: WorkingTreeSectionKind,
  options: ReadFileOptions = {},
): Promise<DiffSection> => {
  const id = `${item.path}:${kind}`;
  const needsWorkingTreeBaseline = item.status === 'conflicted' && !item.conflictStage;

  if (options.patchOnly && !item.untracked && !needsWorkingTreeBaseline) {
    const patch = options.patch ?? (await getPatch(repoRoot, item, kind, options));

    if (patch.binary) {
      return {
        binary: true,
        id,
        kind,
        loadState: 'binary',
        patch: '',
        summary: createSummary('Binary file changed.', {
          canLoad: false,
        }),
      };
    }

    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      patch: patch.patch,
    };
  }

  const contents = await getWorkingTreeContents(repoRoot, item, kind, options);

  if (contents.loadState !== 'ready') {
    return {
      binary: contents.binary,
      id,
      kind,
      loadState: contents.loadState,
      patch: '',
      summary: contents.summary,
    };
  }

  if (item.untracked) {
    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      newFile: contents.newFile,
      oldFile: contents.oldFile,
      patch: createPatchForNewFile(item.path, contents.newFile?.contents || ''),
    };
  }

  const patch = await getPatch(repoRoot, item, kind, options);

  return {
    binary: patch.binary || contents.binary,
    id,
    kind,
    loadState: 'ready',
    newFile: contents.newFile,
    oldFile: contents.oldFile,
    patch: patch.patch,
  };
};

const createWorkingTreeChangedFile = (
  { status, path, oldPath }: Pick<ChangedFile, 'path' | 'oldPath' | 'status'>,
  sections: ChangedFile['sections'],
): ChangedFile => {
  const fingerprint = getFingerprint(
    `${status}\n${oldPath || ''}\n${sections
      .map(
        (section) =>
          `${section.loadState || 'ready'}\n${section.binary ? 'binary' : 'text'}\n${
            section.patch
          }\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${
            section.oldFile?.contents || ''
          }\n${section.newFile?.contents || ''}`,
      )
      .join('\n')}`,
  );
  return { fingerprint, oldPath, path, sections, status };
};

const normalizeStatus = (statusCode: string): GitFileStatus =>
  statusCode === 'A'
    ? 'added'
    : statusCode === 'D'
      ? 'deleted'
      : statusCode === 'R' || statusCode === 'C'
        ? 'renamed'
        : 'modified';

const gitOrEmpty = async (repoRoot: string, args: ReadonlyArray<string>) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

export {
  chunk,
  createEmptyFileContent,
  createLargeBlobResult,
  createWorkingTreeChangedFile,
  readRepositoryRoot,
  EAGER_TEXT_FILE_LIMIT,
  IMAGE_FILE_LIMIT,
  MANUAL_TEXT_FILE_LIMIT,
  MAX_UNTRACKED_INITIAL_ITEMS,
  bufferToTextFile,
  bufferToImageRevision,
  createSection,
  createSummary,
  fileSort,
  formatBytes,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getFingerprint,
  getGravatarHash,
  getImageMimeType,
  getWhitespaceDiffArgs,
  git,
  gitBufferWithInput,
  gitOrEmpty,
  normalizeStatus,
  parseStatus,
  readFileStat,
  readGitFile,
  readGitImageFile,
  readIndexImageFile,
  readWorkingTreeImageFile,
  summarizeContent,
  validateRepositoryPath,
};
