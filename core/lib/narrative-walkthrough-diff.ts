import type { DiffSection, GitFileStatus } from '../types.ts';
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const GENERATED_DIRECTORY_NAMES = new Set(['__generated__', '__snapshots__']);

const GENERATED_BASENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
]);

const GENERATED_EXTENSIONS = [
  '.d.ts.map',
  '.g.dart',
  '.generated.cjs',
  '.generated.css',
  '.generated.js',
  '.generated.jsx',
  '.generated.mjs',
  '.generated.ts',
  '.generated.tsx',
  '.pb.go',
  '.pb.gw.go',
  '.snap',
  '.snapshot',
];

const GENERATED_SUFFIXES = [
  '-generated.js',
  '-generated.ts',
  '-generated.tsx',
  '.min.cjs',
  '.min.css',
  '.min.js',
  '.min.mjs',
  '.pb.cc',
  '.pb.h',
  '.pb.rb',
  '_generated.go',
  '_generated.rs',
  '_pb2.py',
  '_pb2_grpc.py',
];

const getPathParts = (path: string) => path.replaceAll('\\', '/').split('/').filter(Boolean);

const isGeneratedWalkthroughPath = (path: string) => {
  const parts = getPathParts(path).map((part) => part.toLowerCase());
  const basename = parts.at(-1) || '';
  if (!basename) {
    return false;
  }

  return (
    parts.some((part) => GENERATED_DIRECTORY_NAMES.has(part)) ||
    GENERATED_BASENAMES.has(basename) ||
    GENERATED_EXTENSIONS.some((extension) => basename.endsWith(extension)) ||
    GENERATED_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
    (basename.endsWith('.map') && !basename.endsWith('.importmap'))
  );
};

const isGeneratedWalkthroughFile = (file: { generated?: boolean; path: string }) =>
  file.generated ?? isGeneratedWalkthroughPath(file.path);

const getGeneratedWalkthroughSummary = (path: string) => {
  const parts = getPathParts(path).map((part) => part.toLowerCase());
  const basename = parts.at(-1) || '';
  if (GENERATED_BASENAMES.has(basename)) {
    return 'Lockfile collapsed into one generated-file review unit.';
  }
  if (
    parts.includes('__snapshots__') ||
    basename.endsWith('.snap') ||
    basename.endsWith('.snapshot')
  ) {
    return 'Snapshot collapsed into one generated-file review unit.';
  }
  return 'Generated file collapsed into one review unit.';
};

const parseHunkHeader = (line: string) => {
  const match = HUNK_HEADER.exec(line);
  if (!match) {
    return null;
  }

  const deletionStart = Number(match[1]);
  const deletionCount = Number(match[2] ?? 1);
  const additionStart = Number(match[3]);
  const additionCount = Number(match[4] ?? 1);

  return {
    additionCount,
    additionEnd: additionStart + Math.max(0, additionCount - 1),
    additionStart,
    deletionCount,
    deletionEnd: deletionStart + Math.max(0, deletionCount - 1),
    deletionStart,
  };
};

const extractPatchHunks = (patch: string) => {
  const lines = typeof patch === 'string' ? patch.split('\n') : [];
  const hunks = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index] ?? '';
    const parsed = parseHunkHeader(header);
    if (!parsed) {
      index += 1;
      continue;
    }

    const hunkStart = index;
    let additions = 0;
    let deletions = 0;
    index += 1;
    while (index < lines.length && !parseHunkHeader(lines[index] ?? '')) {
      const line = lines[index] ?? '';
      if (line.startsWith('+')) {
        additions += 1;
      } else if (line.startsWith('-')) {
        deletions += 1;
      }
      index += 1;
    }

    hunks.push({
      ...parsed,
      added: additions,
      deleted: deletions,
      header,
      patch: lines.slice(hunkStart, index).join('\n'),
    });
  }

  return hunks;
};

type HunkLocation = {
  id: string;
  index: number;
  oldPath?: string;
  path: string;
  sectionId: string;
  sectionKind: DiffSection['kind'];
  status: GitFileStatus;
};

/** The smallest reviewable unit of a diff: a textual patch hunk, or one stand-in per section. */
export type SectionHunk =
  | (ReturnType<typeof extractPatchHunks>[number] & HunkLocation & { kind: 'patch' })
  | (HunkLocation & { added: number; deleted: number; kind: 'synthetic'; summary?: string });

const sumHunkLineCounts = (hunks: ReadonlyArray<{ added: number; deleted: number }>) =>
  hunks.reduce(
    (totals, hunk) => ({
      added: totals.added + hunk.added,
      deleted: totals.deleted + hunk.deleted,
    }),
    { added: 0, deleted: 0 },
  );

const isSyntheticWalkthroughHunk = (hunk: { kind?: string } | null | undefined) =>
  hunk?.kind === 'synthetic';

const hunkDisplayStart = (hunk: SectionHunk) => {
  if (hunk.kind === 'synthetic') {
    return undefined;
  }

  return hunk.added > 0 ? hunk.additionStart : hunk.deletionStart;
};

const hunkDisplayEnd = (hunk: SectionHunk) => {
  if (hunk.kind === 'synthetic') {
    return undefined;
  }

  return hunk.added > 0 ? hunk.additionEnd : hunk.deletionEnd;
};

const buildAnchorDisplay = (path: string, hunks: ReadonlyArray<SectionHunk>) => {
  if (hunks.length === 0) {
    return path;
  }
  const first = hunks[0];
  const last = hunks.at(-1);
  if (!first || !last) {
    return path;
  }
  if (isSyntheticWalkthroughHunk(first)) {
    return path;
  }
  const startLine = hunkDisplayStart(first);
  const endLine = hunkDisplayEnd(last);
  return startLine && endLine && endLine !== startLine
    ? `${path}:${startLine}-${endLine}`
    : `${path}:${startLine || 1}`;
};

const fileHasRenameMetadata = (file: { oldPath?: string; path: string; status?: string }) =>
  file.status === 'renamed' && file.oldPath != null && file.oldPath !== file.path;

const shouldCreateSyntheticHunk = (
  file: { oldPath?: string; path: string; status?: string },
  section: { binary?: boolean; loadState?: string; patch?: string; summary?: { reason?: string } },
) => {
  if (section.binary) {
    return true;
  }
  if (section.loadState != null && section.loadState !== 'ready') {
    return true;
  }
  if (fileHasRenameMetadata(file)) {
    return true;
  }

  return typeof section.patch === 'string' && section.patch.trim().length > 0;
};

const createSyntheticSectionHunk = (
  file: { generated?: boolean; oldPath?: string; path: string; status: GitFileStatus },
  section: {
    binary?: boolean;
    id: string;
    kind: DiffSection['kind'];
    loadState?: string;
    patch?: string;
    summary?: { reason?: string };
  },
  lineCount = { added: 0, deleted: 0 },
): SectionHunk => ({
  added: lineCount.added,
  deleted: lineCount.deleted,
  id: `${section.id}:h1`,
  index: 1,
  kind: 'synthetic' as const,
  oldPath: file.oldPath,
  path: file.path,
  sectionId: section.id,
  sectionKind: section.kind,
  status: file.status,
  summary:
    section.summary?.reason ??
    (isGeneratedWalkthroughFile(file) ? getGeneratedWalkthroughSummary(file.path) : undefined),
});

/**
 * Codophon's walkthrough hunk ids identify the smallest reviewable diff unit.
 * Most are textual patch hunks; non-text or metadata-only sections get one
 * synthetic hunk so walkthroughs remain hunk-based for every visible change.
 */
const getSectionWalkthroughHunks = (
  file: { generated?: boolean; oldPath?: string; path: string; status: GitFileStatus },
  section: {
    binary?: boolean;
    id: string;
    kind: DiffSection['kind'];
    loadState?: string;
    patch?: string;
    summary?: { reason?: string };
  },
): Array<SectionHunk> => {
  const patchHunks = extractPatchHunks(section.patch || '');
  if (patchHunks.length > 0 && isGeneratedWalkthroughFile(file)) {
    return [createSyntheticSectionHunk(file, section, sumHunkLineCounts(patchHunks))];
  }

  if (patchHunks.length > 0) {
    return patchHunks.map((hunk, index) => ({
      ...hunk,
      id: `${section.id}:h${index + 1}`,
      index: index + 1,
      kind: 'patch' as const,
      oldPath: file.oldPath,
      path: file.path,
      sectionId: section.id,
      sectionKind: section.kind,
      status: file.status,
    }));
  }

  return shouldCreateSyntheticHunk(file, section)
    ? [createSyntheticSectionHunk(file, section)]
    : [];
};

/** Read the source-order hunk ordinal from a section-scoped id. */
const getHunkOrdinal = (sectionId: string, hunkId: string) => {
  const prefix = `${sectionId}:h`;
  if (!hunkId.startsWith(prefix)) {
    return null;
  }
  const ordinal = Number(hunkId.slice(prefix.length));
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null;
};

const filterPatchToHunkIds = (patch: string, sectionId: string, hunkIds: ReadonlyArray<string>) => {
  if (typeof patch !== 'string' || patch.trim().length === 0 || hunkIds.length === 0) {
    return null;
  }

  const patchLines = patch.split('\n');
  const headerLines = [];
  const hunkLinesByOrdinal = new Map();
  let index = 0;
  let foundHunk = false;
  let ordinal = 0;

  while (index < patchLines.length) {
    const parsedHeader = parseHunkHeader(patchLines[index] ?? '');
    if (parsedHeader) {
      foundHunk = true;
      ordinal += 1;
      const hunkStart = index;
      index += 1;
      while (index < patchLines.length && !parseHunkHeader(patchLines[index] ?? '')) {
        index += 1;
      }
      hunkLinesByOrdinal.set(ordinal, patchLines.slice(hunkStart, index));
      continue;
    }

    if (!foundHunk) {
      headerLines.push(patchLines[index] ?? '');
    }
    index += 1;
  }

  if (!foundHunk) {
    return null;
  }

  const selectedHunkLines = [];
  for (const hunkId of hunkIds) {
    const ordinal = getHunkOrdinal(sectionId, hunkId);
    if (ordinal == null) {
      return null;
    }
    const lines = hunkLinesByOrdinal.get(ordinal);
    if (!lines) {
      return null;
    }
    selectedHunkLines.push(...lines);
  }

  if (selectedHunkLines.length === 0) {
    return null;
  }

  const focused = [...headerLines, ...selectedHunkLines].join('\n');
  return patch.endsWith('\n') && !focused.endsWith('\n') ? `${focused}\n` : focused;
};

export {
  buildAnchorDisplay,
  extractPatchHunks,
  filterPatchToHunkIds,
  getHunkOrdinal,
  getSectionWalkthroughHunks,
  HUNK_HEADER,
  hunkDisplayEnd,
  hunkDisplayStart,
  isGeneratedWalkthroughFile,
  isGeneratedWalkthroughPath,
  isSyntheticWalkthroughHunk,
  parseHunkHeader,
  sumHunkLineCounts,
};
