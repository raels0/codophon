// Narrative walkthrough generation and normalization trust boundary.

import { createHash } from 'node:crypto';
import type { AgentPromptId, AgentPromptOverrides } from '../core/config/types.ts';
import {
  buildAnchorDisplay,
  getSectionWalkthroughHunks,
  hunkDisplayEnd,
  hunkDisplayStart,
  isGeneratedWalkthroughFile,
  isSyntheticWalkthroughHunk,
  sumHunkLineCounts,
  type SectionHunk,
} from '../core/lib/narrative-walkthrough-diff.ts';
import type {
  ChangedFile,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  RepositoryState,
  ReviewSource,
  WalkthroughAnchor,
  WalkthroughChapter,
  WalkthroughCommit,
  WalkthroughContext,
  WalkthroughDesignOverview,
  WalkthroughHunk,
  WalkthroughHunkGroup,
  WalkthroughHunkNote,
  WalkthroughStop,
  WalkthroughSupportGroup,
} from '../core/types.ts';
import { getAgentPrompt } from './agent-prompts.ts';
import { cleanText, normalizeEnum, oneLine, truncate } from './agent-shared.ts';
import type { Agent, AgentOptions, AgentRunner } from './agent.ts';
import {
  AGENTS,
  CHANGE_TYPES,
  ICONS,
  IMPORTANCES,
  MAX_DESIGN_IMPLEMENTATION_ITEMS,
  MAX_HUNKS_PER_WALKTHROUGH_GROUP,
  MAX_WALKTHROUGH_CHAPTERS,
  MAX_WALKTHROUGH_STOPS,
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
} from './narrative-walkthrough-schema.ts';

/** Untrusted agent output. The normalizers below check every field before using it. */
// oxlint-disable-next-line no-explicit-any
type AgentJson = any;

/** Facts about the reviewed diff that Codophon supplies; the agent never sets these. */
type WalkthroughFacts = {
  agent?: unknown;
  branch?: string | null;
  context?: WalkthroughContext;
  generatedAt?: unknown;
  partialEvidence?: boolean;
  root?: string;
  source?: ReviewSource;
};

type WalkthroughIndex = ReturnType<typeof indexFiles>;

const MAX_PROSE_CHARS = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
const MAX_LARGE_TOTAL_PATCH_CHARS = 110_000;
const MAX_SMALL_SECTION_PATCH_CHARS = 8_000;
const MAX_SECTION_PATCH_CHARS = 2_500;
const MAX_LARGE_SECTION_PATCH_CHARS = 3_500;
const BASE_WALKTHROUGH_TIMEOUT_MS = 90_000;
const MAX_WALKTHROUGH_TIMEOUT_MS = 300_000;
const INCLUDED_WALKTHROUGH_FILES = 8;
const INCLUDED_WALKTHROUGH_HUNKS = 12;
const TIMEOUT_MS_PER_EXTRA_FILE = 1_000;
const TIMEOUT_MS_PER_EXTRA_HUNK = 2_000;
const LARGE_WALKTHROUGH_HUNK_THRESHOLD = 100;
const WALKTHROUGH_CACHE_KEY_VERSION = 1;

const cleanRich = (value: unknown, fallback: string = '') => {
  const text = typeof value === 'string' ? value : fallback;
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROSE_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_PROSE_CHARS)}…`;
};

const isCommitTitleLine = (line: string) => {
  const title = line.trim();
  return title.length > 0 && title.length <= 72 && !/[.!?]$/.test(title);
};

const stripLeadingCommitTitle = (body: string, title: string) => {
  if (!body || !title) {
    return body;
  }
  const lines = body.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex === -1 || lines[titleIndex].trim() !== title.trim()) {
    return body;
  }
  let nextIndex = titleIndex + 1;
  while (nextIndex < lines.length && !lines[nextIndex].trim()) {
    nextIndex += 1;
  }
  return [...lines.slice(0, titleIndex), ...lines.slice(nextIndex)].join('\n').trim();
};

const normalizeStringArray = (value: unknown) => {
  const strings: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = oneLine(item);
    if (text && !strings.includes(text)) {
      strings.push(text);
    }
  }
  return strings;
};

const cleanDesignText = (value: unknown) => truncate(oneLine(value), 360);

const normalizeDesignOverview = (
  input: any,
  index: ReturnType<typeof indexFiles>,
  hasStatedIntent: boolean,
  partialEvidence: boolean,
): WalkthroughDesignOverview | undefined => {
  const goal = cleanDesignText(input?.goal);
  const before = cleanDesignText(input?.before);
  const after = cleanDesignText(input?.after);
  if (!goal || !before || !after) {
    return undefined;
  }

  const implementation = [];
  const titles = new Set();
  for (const item of Array.isArray(input?.implementation) ? input.implementation : []) {
    if (implementation.length === MAX_DESIGN_IMPLEMENTATION_ITEMS) {
      break;
    }
    const title = cleanDesignText(item?.title);
    const description = cleanDesignText(item?.description);
    const hunk = index.hunkById.get(oneLine(item?.hunkId));
    if (!title || !description || !hunk || titles.has(title)) {
      continue;
    }
    implementation.push({ description, hunkId: hunk.id, title });
    titles.add(title);
  }

  const mermaid = typeof input.diagram?.mermaid === 'string' ? input.diagram.mermaid.trim() : '';
  const diagramTitle = cleanDesignText(input.diagram?.title);
  const unchanged = cleanDesignText(input.unchanged);
  return {
    after,
    before,
    ...(/^(?:flowchart|sequenceDiagram|stateDiagram-v2)\b/.test(mermaid) &&
    mermaid.length <= MAX_PROSE_CHARS &&
    diagramTitle
      ? { diagram: { mermaid, title: diagramTitle } }
      : {}),
    goal,
    goalSource: hasStatedIntent && input.goalSource === 'stated' ? 'stated' : 'inferred',
    implementation,
    ...(partialEvidence ? { partialEvidence } : {}),
    ...(unchanged ? { unchanged } : {}),
  };
};

const normalizeGeneratedAt = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return '';
};

const isLegacyV3Walkthrough = (input: any) =>
  input?.version === 3 ||
  (Array.isArray(input?.chapters) &&
    input.chapters.some((chapter: { stops: any }) =>
      (chapter?.stops || []).some((stop: { anchors: any }) => Array.isArray(stop?.anchors)),
    )) ||
  (Array.isArray(input?.support) &&
    input.support.some((item: { files: any }) => Array.isArray(item?.files)));

const defaultSideForStatus = (status: string) => {
  if (status === 'added' || status === 'untracked') {
    return 'additions';
  }

  if (status === 'deleted') {
    return 'deletions';
  }

  return 'both';
};

const indexFiles = (
  files: ReadonlyArray<ChangedFile>,
  hunkIdByAlias: ReadonlyMap<string, string> = new Map(),
) => {
  const hunkById = new Map<string, SectionHunk>();
  const generatedHunkIds = new Set<string>();
  for (const file of files) {
    for (const section of file.sections || []) {
      for (const hunk of getSectionWalkthroughHunks(file, section)) {
        hunkById.set(hunk.id, hunk);
        if (isGeneratedWalkthroughFile(file)) {
          generatedHunkIds.add(hunk.id);
        }
      }
    }
  }
  for (const [alias, hunkId] of hunkIdByAlias) {
    const hunk = hunkById.get(hunkId);
    if (hunk) {
      hunkById.set(alias, hunk);
    }
  }

  return { generatedHunkIds, hunkById };
};

const resolveHunks = (hunkIds: ReadonlyArray<string>, index: WalkthroughIndex) => {
  const hunks: Array<SectionHunk> = [];
  for (const hunkId of hunkIds) {
    const hunk = index.hunkById.get(hunkId);
    if (!hunk) {
      return null;
    }
    hunks.push(hunk);
  }
  return hunks;
};

const normalizeAnchor = (hunk: SectionHunk): WalkthroughAnchor => {
  const path = hunk.path;
  const side = defaultSideForStatus(hunk.status);
  const startLine = hunkDisplayStart(hunk);
  const endLine = hunkDisplayEnd(hunk);

  const normalized: WalkthroughAnchor = {
    display: buildAnchorDisplay(path, [hunk]),
    side,
    sectionId: hunk.sectionId,
    sectionKind: hunk.sectionKind,
  };
  if (startLine !== undefined) {
    normalized.startLine = startLine;
  }
  if (endLine !== undefined) {
    normalized.endLine = endLine;
  }

  return normalized;
};

const normalizeHunk = (hunk: SectionHunk): WalkthroughHunk => {
  const normalized: WalkthroughHunk = {
    added: hunk.added,
    anchor: normalizeAnchor(hunk),
    deleted: hunk.deleted,
    id: hunk.id,
    kind: hunk.kind,
    path: hunk.path,
    status: hunk.status,
    ...(hunk.kind === 'patch'
      ? {
          additionEnd: hunk.additionEnd,
          additionStart: hunk.additionStart,
          deletionEnd: hunk.deletionEnd,
          deletionStart: hunk.deletionStart,
        }
      : {}),
  };
  if (hunk.oldPath) {
    normalized.oldPath = hunk.oldPath;
  }
  return normalized;
};

const normalizeHunkNote = (
  note: AgentJson,
  hunkIds: ReadonlySet<string>,
  index: WalkthroughIndex,
): WalkthroughHunkNote | null => {
  const requestedHunkId = oneLine(note?.hunkId);
  const hunkId = index.hunkById.get(requestedHunkId)?.id || requestedHunkId;
  const body = cleanText(note?.body);
  if (!hunkId || !body || !hunkIds.has(hunkId)) {
    return null;
  }
  return { body, hunkId };
};

const normalizeHunkGroup = (
  item: AgentJson,
  fallbackId: string,
  index: WalkthroughIndex,
): WalkthroughHunkGroup | null => {
  const id = oneLine(item?.id) || fallbackId;
  const hunkIds = normalizeStringArray(item?.hunkIds);
  if (!id || hunkIds.length === 0 || hunkIds.length > MAX_HUNKS_PER_WALKTHROUGH_GROUP) {
    return null;
  }

  const selectedHunks = resolveHunks(hunkIds, index);
  if (!selectedHunks || selectedHunks.length !== hunkIds.length) {
    return null;
  }

  const lineCount = sumHunkLineCounts(selectedHunks);
  const selectedHunkIds = new Set(selectedHunks.map((hunk) => hunk.id));

  const normalized: WalkthroughHunkGroup = {
    added: lineCount.added,
    deleted: lineCount.deleted,
    hunkIds: selectedHunks.map((hunk) => hunk.id),
    hunks: selectedHunks.map(normalizeHunk),
    id,
  };

  const title = cleanText(item?.title);
  if (title) {
    normalized.title = title;
  }
  const summary = cleanText(item?.summary);
  if (summary) {
    normalized.summary = summary;
  }
  const changeType = normalizeEnum(item?.changeType, CHANGE_TYPES, undefined);
  if (changeType) {
    normalized.changeType = changeType;
  }
  const commitNote = cleanText(item?.commitNote);
  if (commitNote) {
    normalized.commitNote = commitNote;
  }

  const notes: Array<WalkthroughHunkNote> = [];
  const notedHunkIds = new Set<string>();
  for (const note of Array.isArray(item?.notes) ? item.notes : []) {
    const normalizedNote = normalizeHunkNote(note, selectedHunkIds, index);
    if (!normalizedNote || notedHunkIds.has(normalizedNote.hunkId)) {
      continue;
    }
    notes.push(normalizedNote);
    notedHunkIds.add(normalizedNote.hunkId);
  }
  if (notes.length > 0) {
    normalized.notes = notes;
  }

  return normalized;
};

const hunkGroupKey = (group: WalkthroughHunkGroup) => group.hunkIds.join('\n');

const normalizeChapters = (
  input: AgentJson,
  index: WalkthroughIndex,
  coveredHunkIds: Set<string>,
) => {
  const chapters: Array<WalkthroughChapter> = [];
  const chapterIds = new Set<string>();
  const itemIds = new Set<string>();
  let stopCount = 0;

  for (const chapter of Array.isArray(input?.chapters) ? input.chapters : []) {
    if (chapters.length >= MAX_WALKTHROUGH_CHAPTERS || stopCount >= MAX_WALKTHROUGH_STOPS) {
      break;
    }

    const id = oneLine(chapter?.id) || `chapter-${chapters.length + 1}`;
    if (chapterIds.has(id)) {
      continue;
    }

    const stops: Array<WalkthroughStop> = [];
    const seenStopHunkGroups = new Set<string>();
    for (const stop of Array.isArray(chapter?.stops) ? chapter.stops : []) {
      if (stopCount >= MAX_WALKTHROUGH_STOPS) {
        break;
      }

      const group = normalizeHunkGroup(stop, `${id}-stop-${stops.length + 1}`, index);
      if (!group || itemIds.has(group.id)) {
        continue;
      }

      const key = hunkGroupKey(group);
      const overlapsCoveredHunk = group.hunkIds.some((hunkId) => coveredHunkIds.has(hunkId));
      if (seenStopHunkGroups.has(key) || overlapsCoveredHunk) {
        continue;
      }

      const prose = cleanRich(stop?.prose);
      if (!prose) {
        continue;
      }

      stops.push({
        ...group,
        importance: normalizeEnum(stop?.importance, IMPORTANCES, 'normal'),
        prose,
      });
      itemIds.add(group.id);
      seenStopHunkGroups.add(key);
      stopCount += 1;
      for (const hunkId of group.hunkIds) {
        coveredHunkIds.add(hunkId);
      }
    }

    if (stops.length === 0) {
      continue;
    }

    chapterIds.add(id);
    chapters.push({
      blurb: cleanText(chapter?.blurb),
      icon: normalizeEnum(chapter?.icon, ICONS, 'path'),
      id,
      stops,
      title: cleanText(chapter?.title, 'Chapter'),
    });
  }

  return { chapters, itemIds, stopCount };
};

const normalizeAuthoredSupport = (
  input: AgentJson,
  index: WalkthroughIndex,
  coveredHunkIds: Set<string>,
  itemIds: Set<string>,
) => {
  const support: Array<WalkthroughSupportGroup> = [];
  const seenSupportHunkGroups = new Set<string>();
  for (const item of Array.isArray(input?.support) ? input.support : []) {
    const group = normalizeHunkGroup(item, `support-${support.length + 1}`, index);
    if (!group || itemIds.has(group.id)) {
      continue;
    }

    const key = hunkGroupKey(group);
    if (
      seenSupportHunkGroups.has(key) ||
      group.hunkIds.some((hunkId) => coveredHunkIds.has(hunkId))
    ) {
      continue;
    }

    const note = cleanText(item?.note);
    support.push({
      ...group,
      ...(note ? { note } : {}),
      reason: group.hunkIds.every((hunkId) => index.generatedHunkIds.has(hunkId))
        ? 'Generated files'
        : cleanText(item?.reason, 'Other changes'),
    });
    itemIds.add(group.id);
    seenSupportHunkGroups.add(key);
    for (const hunkId of group.hunkIds) {
      coveredHunkIds.add(hunkId);
    }
  }
  return support;
};

const addUnreferencedSupport = (
  support:
    | Record<string, unknown>[]
    | {
        added: number;
        deleted: number;
        hunkIds: any;
        hunks: any;
        id: string;
        reason: string;
        title: any;
      }[],
  index: { generatedHunkIds: any; hunkById: any },
  coveredHunkIds: Set<unknown>,
  itemIds: Set<unknown>,
) => {
  const groupsByPath = new Map();
  const seenHunkIds = new Set();
  for (const hunk of index.hunkById.values()) {
    if (coveredHunkIds.has(hunk.id) || seenHunkIds.has(hunk.id)) {
      continue;
    }
    seenHunkIds.add(hunk.id);
    const groups = groupsByPath.get(hunk.path) || [];
    groups.push(hunk);
    groupsByPath.set(hunk.path, groups);
  }

  for (const [path, hunks] of groupsByPath) {
    for (let start = 0; start < hunks.length; start += MAX_HUNKS_PER_WALKTHROUGH_GROUP) {
      const chunk = hunks.slice(start, start + MAX_HUNKS_PER_WALKTHROUGH_GROUP);
      const lineCount = sumHunkLineCounts(chunk);
      let counter = support.length + 1;
      let id = `support-${counter}`;
      while (itemIds.has(id)) {
        counter += 1;
        id = `support-${counter}`;
      }
      support.push({
        added: lineCount.added,
        deleted: lineCount.deleted,
        hunkIds: chunk.map((hunk: { id: any }) => hunk.id),
        hunks: chunk.map(normalizeHunk),
        id,
        reason: chunk.every((hunk: { id: any }) => index.generatedHunkIds.has(hunk.id))
          ? 'Generated files'
          : 'Other changes',
        title: path,
      });
      itemIds.add(id);
      for (const hunk of chunk) {
        coveredHunkIds.add(hunk.id);
      }
    }
  }
};

const MAX_LISTED_HUNK_IDS = 20;

const listHunkIds = (hunkIds: ReadonlyArray<string>) =>
  hunkIds.length > MAX_LISTED_HUNK_IDS
    ? `${hunkIds.slice(0, MAX_LISTED_HUNK_IDS).join(', ')}, and ${hunkIds.length - MAX_LISTED_HUNK_IDS} more`
    : hunkIds.join(', ');

/**
 * Throws when an authored walkthrough references a hunk id outside the live
 * diff. Normalization would silently drop every stop with one, so this names
 * the unresolved ids next to the diff's real ids for the author to fix.
 */
const assertWalkthroughHunkIdsResolve = (input: any, files: ReadonlyArray<ChangedFile>) => {
  const { hunkById } = indexFiles(files);
  const groups = [
    ...(Array.isArray(input?.chapters) ? input.chapters : []).flatMap((chapter: { stops: any }) =>
      Array.isArray(chapter?.stops) ? chapter.stops : [],
    ),
    ...(Array.isArray(input?.support) ? input.support : []),
  ];

  const implementation: ReadonlyArray<{ hunkId: unknown } | null> = Array.isArray(
    input?.designOverview?.implementation,
  )
    ? input.designOverview.implementation
    : [];
  const unresolvedHunkIds = [
    ...new Set(
      [
        ...groups.flatMap((group) => normalizeStringArray(group?.hunkIds)),
        ...normalizeStringArray(implementation.map((item) => item?.hunkId)),
      ].filter((hunkId) => !hunkById.has(hunkId)),
    ),
  ];
  if (unresolvedHunkIds.length > 0) {
    const validHunkIds = [...hunkById.keys()];
    throw new Error(
      `Unresolved hunk ids: ${listHunkIds(unresolvedHunkIds)}. ${
        validHunkIds.length
          ? `This diff's hunk ids: ${listHunkIds(validHunkIds)}.`
          : 'This diff has no hunks.'
      }`,
    );
  }
};

const normalizeNarrativeWalkthrough = (
  input: AgentJson,
  files: ReadonlyArray<ChangedFile>,
  facts: WalkthroughFacts = {},
  hunkIdByAlias: ReadonlyMap<string, string> = new Map(),
): NarrativeWalkthrough => {
  if (!input || typeof input !== 'object') {
    throw new Error('Narrative walkthrough is not an object.');
  }
  if (isLegacyV3Walkthrough(input)) {
    throw new Error(
      'Narrative walkthrough uses the legacy v3 anchors[] schema. Regenerate it with the v4 hunkIds[] schema for this diff.',
    );
  }

  const index = indexFiles(files, hunkIdByAlias);
  const coveredHunkIds = new Set<string>();
  const { chapters, itemIds, stopCount } = normalizeChapters(input, index, coveredHunkIds);
  if (chapters.length === 0 || stopCount === 0) {
    throw new Error('Narrative walkthrough has no chapters with resolvable stops.');
  }

  const support = normalizeAuthoredSupport(input, index, coveredHunkIds, itemIds);
  addUnreferencedSupport(support, index, coveredHunkIds, itemIds);

  const branch = typeof facts.branch === 'string' || facts.branch === null ? facts.branch : null;

  const source: ReviewSource =
    facts.source && typeof facts.source === 'object' ? facts.source : { type: 'working-tree' };
  const designOverview = normalizeDesignOverview(
    input.designOverview,
    index,
    source.type === 'pull-request' && Boolean(oneLine(source.description) || oneLine(source.title)),
    'partialEvidence' in facts && facts.partialEvidence === true,
  );

  const result: NarrativeWalkthrough = {
    agent: normalizeEnum(facts.agent, AGENTS, 'codex'),
    chapters,
    ...(designOverview ? { designOverview } : {}),
    focus: cleanText(input.focus, 'Walk through the change.'),
    generatedAt: normalizeGeneratedAt(facts.generatedAt),
    kind: 'narrative',
    repo: {
      branch,
      root: oneLine(facts.root),
    },
    source,
    support,
    title: cleanText(input.title, 'Walkthrough'),
    version: 4,
  };

  result.meta = `${stopCount} stops · ${chapters.length} chapters`;
  if (facts.context && typeof facts.context === 'object') {
    result.context = facts.context;
  }

  // A commit composer only makes sense for a live staging set — never a past
  // commit, branch, or pull request. For working trees, always expose the
  // composer even when the agent did not draft a message, so the reviewer can
  // complete the whole workflow in Codophon.
  if (result.source.type === 'working-tree') {
    const commit: WalkthroughCommit = {};
    const inputCommit = input.commit && typeof input.commit === 'object' ? input.commit : {};
    const rawBody = cleanRich(inputCommit.body);
    let title = cleanText(inputCommit.title);
    if (!title && rawBody) {
      const firstLine = rawBody
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim();
      if (firstLine && isCommitTitleLine(firstLine)) {
        title = firstLine;
      }
    }
    if (title) {
      commit.title = title;
    }
    const body = stripLeadingCommitTitle(rawBody, title);
    if (body) {
      commit.body = body;
    }
    result.commit = commit;
  }

  return result;
};

const buildPatchExcerpt = (patch: string, maxLength: number) => {
  if (patch.length <= maxLength) {
    return patch;
  }
  const gap = '\n…\n';
  const half = Math.floor((maxLength - gap.length) / 2);
  const headEnd = patch.lastIndexOf('\n', half);
  const tailStart = patch.indexOf('\n', patch.length - half);
  if (headEnd > 0 && tailStart !== -1 && tailStart < patch.trimEnd().length) {
    return `${patch.slice(0, headEnd)}${gap}${patch.slice(tailStart + 1)}`;
  }
  return maxLength <= 1 ? patch.slice(0, maxLength) : `${patch.slice(0, maxLength - 1)}…`;
};

const formatPromptLineRange = (start: number, end: number) =>
  start === end ? `${start}` : `${start}-${end}`;

const buildPromptHunkInput = (hunk: SectionHunk, id: string, patch: string = '') => {
  if (hunk.kind === 'synthetic') {
    return {
      added: hunk.added,
      deleted: hunk.deleted,
      id,
      kind: 'synthetic',
      summary: hunk.summary,
    };
  }

  return {
    added: hunk.added,
    deleted: hunk.deleted,
    header: hunk.header,
    id,
    kind: 'patch',
    newLines: formatPromptLineRange(hunk.additionStart, hunk.additionEnd),
    oldLines: formatPromptLineRange(hunk.deletionStart, hunk.deletionEnd),
    patch,
  };
};

const getPromptPatchBudgets = (fileCount: number) =>
  fileCount > 32
    ? {
        section: MAX_LARGE_SECTION_PATCH_CHARS,
        total: MAX_LARGE_TOTAL_PATCH_CHARS,
      }
    : fileCount > 8
      ? {
          section: MAX_SECTION_PATCH_CHARS,
          total: MAX_TOTAL_PATCH_CHARS,
        }
      : {
          section: MAX_SMALL_SECTION_PATCH_CHARS,
          total: MAX_TOTAL_PATCH_CHARS,
        };

const buildPromptSource = (source: RepositoryState['source']) => {
  if (source.type !== 'pull-request') {
    return source;
  }

  return {
    ...(typeof source.description === 'string'
      ? { description: truncate(source.description, MAX_PROSE_CHARS) }
      : {}),
    ...(source.baseSha ? { baseSha: source.baseSha } : {}),
    ...(source.headSha ? { headSha: source.headSha } : {}),
    ...(source.host ? { host: source.host } : {}),
    ...(source.number != null ? { number: source.number } : {}),
    ...(source.owner ? { owner: source.owner } : {}),
    ...(source.projectPath ? { projectPath: source.projectPath } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.repo ? { repo: source.repo } : {}),
    ...(source.title ? { title: source.title } : {}),
    type: source.type,
    url: source.url,
  };
};

const buildPromptInput = (state: RepositoryState) => {
  const patchBudget = getPromptPatchBudgets(state.files.length);
  const hunkIdByAlias = new Map();
  let nextHunkAlias = 1;
  let remainingPatchBudget = patchBudget.total;
  let remainingTextSections = state.files.reduce(
    (count, file) =>
      count +
      (isGeneratedWalkthroughFile(file)
        ? 0
        : file.sections.filter((section) => section.patch && !section.binary).length),
    0,
  );
  let partialEvidence = false;

  const input = {
    branch: state.branch,
    files: state.files.map((file) => {
      const generated = isGeneratedWalkthroughFile(file);
      return {
        ...(generated
          ? {
              generated: true,
              generatedReason:
                'Generated-like file; Codophon exposes each changed section as one synthetic hunk.',
            }
          : {}),
        oldPath: file.oldPath,
        path: file.path,
        sections: file.sections.map((section) => {
          const sectionHunks = getSectionWalkthroughHunks(file, section);
          if (
            !generated &&
            (section.loadState === 'deferred' ||
              section.loadState === 'error' ||
              section.loadState === 'too-large')
          ) {
            partialEvidence = true;
          }
          // Reserve a share for later files instead of spending the whole digest on the first ones.
          let remainingSectionPatchBudget = 0;
          if (!generated && section.patch && !section.binary) {
            remainingSectionPatchBudget = Math.min(
              patchBudget.section,
              Math.floor(remainingPatchBudget / remainingTextSections),
            );
            remainingTextSections -= 1;
          }
          const hunks = sectionHunks.map((hunk, index) => {
            const alias = `h${nextHunkAlias}`;
            nextHunkAlias += 1;
            hunkIdByAlias.set(alias, hunk.id);
            const fairPatchBudget = Math.floor(
              remainingSectionPatchBudget / (sectionHunks.length - index),
            );
            const patch = !isSyntheticWalkthroughHunk(hunk) && 'patch' in hunk ? hunk.patch : '';
            const patchExcerpt = buildPatchExcerpt(patch, fairPatchBudget);
            if (patchExcerpt.length < patch.length) {
              partialEvidence = true;
            }
            remainingSectionPatchBudget -= patchExcerpt.length;
            remainingPatchBudget -= patchExcerpt.length;
            return buildPromptHunkInput(hunk, alias, patchExcerpt);
          });

          return {
            binary: section.binary,
            hunks,
            id: section.id,
            kind: section.kind,
            loadState: section.loadState,
            summary: section.summary?.reason,
          };
        }),
        status: file.status,
      };
    }),
    root: state.root,
    source: buildPromptSource(state.source),
  };

  return { hunkIdByAlias, input, partialEvidence };
};

const buildWalkthroughContextInput = (context: any, agentLabel: string) =>
  context
    ? `${agentLabel} conversation context:
${JSON.stringify(context, null, 2)}

Use this context as orientation for reviewer intent, implementation rationale, validation, and known risks.
Treat the repository change digest as the source of truth for what changed.
If the context and digest conflict, trust the digest.
`
    : '';

const buildCustomPromptInput = (customPrompt: unknown) => {
  const prompt = typeof customPrompt === 'string' ? customPrompt.trim() : '';

  return prompt
    ? `Custom walkthrough instructions:
${prompt}

Use these instructions to customize language, tone, and review detail. If they conflict with the JSON schema, repository digest, hunk ids, or review-order constraints above, keep Codophon's constraints and the digest as the source of truth.
`
    : '';
};

/**
 * Summarize the walkthrough being replaced without carrying stale hunk ids or
 * anchors into the next request.
 */
const buildPreviousWalkthroughInput = (
  previousWalkthrough: unknown,
  prompts: Partial<Record<AgentPromptId, string>> | undefined,
) => {
  if (!previousWalkthrough || typeof previousWalkthrough !== 'object') {
    return '';
  }

  const walkthrough = previousWalkthrough as any;
  const chapters = (Array.isArray(walkthrough.chapters) ? walkthrough.chapters : [])
    .map((chapter: { blurb: unknown; stops: any; title: unknown }) => ({
      blurb: oneLine(chapter?.blurb),
      stops: (Array.isArray(chapter?.stops) ? chapter.stops : []).map(
        (stop: { prose: unknown; title: unknown }) => ({
          prose: truncate(cleanText(stop?.prose), MAX_PROSE_CHARS),
          title: oneLine(stop?.title),
        }),
      ),
      title: oneLine(chapter?.title),
    }))
    .filter(
      (chapter: { title: any; stops: string | any[] }) => chapter.title || chapter.stops.length > 0,
    );
  if (chapters.length === 0) {
    return '';
  }

  const commit =
    walkthrough.commit && typeof walkthrough.commit === 'object'
      ? {
          body: truncate(cleanText(walkthrough.commit.body), MAX_PROSE_CHARS),
          title: oneLine(walkthrough.commit.title),
        }
      : undefined;
  const summary = {
    chapters,
    ...(commit?.body || commit?.title ? { commit } : {}),
    focus: oneLine(walkthrough.focus),
    title: oneLine(walkthrough.title),
  };

  return `Previous walkthrough to update:
${JSON.stringify(summary)}

Re-author it for the current digest. Re-anchor every stop to the current digest's hunk aliases; never reuse ids or anchors from the previous walkthrough. Return the complete updated walkthrough.
${getAgentPrompt('walkthroughRevision', prompts)}
`;
};

const getWalkthroughSize = (state: RepositoryState) => ({
  fileCount: state.files.length,
  hunkCount: state.files.reduce(
    (total, file) =>
      total +
      (file.sections || []).reduce(
        (sectionTotal, section) => sectionTotal + getSectionWalkthroughHunks(file, section).length,
        0,
      ),
    0,
  ),
});

/**
 * Use the compatibility model for large default-Codex walkthroughs. Explicit
 * model or effort selections and non-Codex backends keep their configured model.
 */
const resolveNarrativeWalkthroughModel = (
  state: RepositoryState,
  agent: Pick<Agent, 'id' | 'defaultModel' | 'fallbackModel' | 'normalizeModel'>,
  model: unknown,
  reasoningEffort?: string,
) => {
  const normalizedModel = agent.normalizeModel(model);
  return agent.id === 'codex' &&
    normalizedModel === agent.defaultModel &&
    !reasoningEffort?.trim() &&
    getWalkthroughSize(state).hunkCount >= LARGE_WALKTHROUGH_HUNK_THRESHOLD
    ? agent.fallbackModel
    : normalizedModel;
};

/**
 * Small walkthroughs retain the normal agent timeout. Larger digests get more
 * time for hunk classification and structured output, capped at five minutes.
 */
const getNarrativeWalkthroughTimeoutMs = (
  state: RepositoryState,
  minimumMs: number = BASE_WALKTHROUGH_TIMEOUT_MS,
) => {
  const { fileCount, hunkCount } = getWalkthroughSize(state);
  const estimatedMs =
    BASE_WALKTHROUGH_TIMEOUT_MS +
    Math.max(0, fileCount - INCLUDED_WALKTHROUGH_FILES) * TIMEOUT_MS_PER_EXTRA_FILE +
    Math.max(0, hunkCount - INCLUDED_WALKTHROUGH_HUNKS) * TIMEOUT_MS_PER_EXTRA_HUNK;

  return Math.min(MAX_WALKTHROUGH_TIMEOUT_MS, Math.max(minimumMs, estimatedMs));
};

const buildWalkthroughSizingGuidance = (state: RepositoryState) => {
  const { fileCount, hunkCount } = getWalkthroughSize(state);
  const focusedSmallChange = hunkCount <= 12 || (fileCount <= 4 && hunkCount <= 16);
  const stopInstruction =
    hunkCount <= 4
      ? 'Use at most 2 main-path stops'
      : focusedSmallChange
        ? 'Use at most 3 main-path stops'
        : fileCount <= 8 && hunkCount <= 32
          ? 'Use at most 5 main-path stops'
          : fileCount <= 16
            ? 'Aim for 5-9 main-path stops'
            : 'Aim for 6-9 main-path stops';
  const chapterInstruction =
    fileCount <= 2
      ? 'Use 1 story chapter'
      : focusedSmallChange
        ? 'Use at most 2 story chapters'
        : fileCount <= 8 && hunkCount <= 32
          ? 'Use at most 3 story chapters'
          : `Use 2-${MAX_WALKTHROUGH_CHAPTERS} story chapters`;
  return `Coverage contract:
- The digest has ${fileCount} files and ${hunkCount} reviewable hunks. Put the highest-leverage review path in chapters[]; Codophon preserves everything else as support.
- Digest hunk ids are compact request-local aliases like h1 and h2. Return those aliases exactly; Codophon maps them back to stable live-diff ids.
- Use each hunk's own bounded patch excerpt to associate its alias with its exact change. An empty excerpt or an ellipsis means code was omitted.
- Define chapters[] in display order. Inside each chapter, define stops[] in display order.
- Use stable item ids like s1, s2, ... for main stops. Do not invent hunk ids.
- Default to one review idea per stop. Include multiple hunkIds when the hunks implement the same idea, especially in small diffs.

Grouping contract:
- ${stopInstruction}; this is a ceiling, not a target. Use fewer whenever they still preserve distinct state transitions, submission paths, or runtime contracts. Never exceed ${MAX_WALKTHROUGH_STOPS}.
- ${chapterInstruction}. A chapter is a conceptual group, not a file. For one- or two-file diffs, prefer one chapter unless there are clearly separate review phases.
- A stop may contain at most ${MAX_HUNKS_PER_WALKTHROUGH_GROUP} hunkIds. Use multiple hunkIds when the prose needs those hunks read together to understand one invariant, behavior, or repeated pattern.
- A Git hunk boundary is not a walkthrough boundary. Group hunks that only make sense together, and never create a stop whose explanation depends primarily on code assigned to another stop.
- Generated-like files have "generated": true and one synthetic hunk per changed section. Never split them; main-path them only when they explain behavior, like snapshots proving output.
- For 1-4 total hunks, usually write 1-2 stops. Similar same-file hunks should usually be one stop with multiple hunkIds, not separate chapters or stops.
- Split distant same-file hunks into separate consecutive stops when they deserve separate prose. Do not make a chapter-sized stop.
- Do not group a whole large file into one stop when its hunks implement distinct workflows, state transitions, or submission paths.
- Put hunkIds in the exact display order you want Codophon to render. Out-of-line and cross-file order is allowed when it improves reviewer comprehension.
- Do not provide added/deleted counts, status, oldPath, section ids, display labels, path, repo, source, generatedAt, agent, or meta; Codophon computes those.
- Leave secondary, mechanical, docs-only, generated, styling, fixture, and repeated-pattern hunks out of chapters[]. Codophon automatically places every unreferenced hunk in support.
- For working-tree sources, include commit.title and commit.body by default unless there are no commit-worthy files. Put the subject line in commit.title, not as the first line of commit.body.
`;
};

const buildNarrativeWalkthroughRequest = (
  state: RepositoryState,
  context?: WalkthroughContext | null,
  agentLabel = 'Codex',
  customPrompt?: unknown,
  previousWalkthrough?: NarrativeWalkthrough,
  prompts?: AgentPromptOverrides,
) => {
  const { hunkIdByAlias, input, partialEvidence } = buildPromptInput(state);
  return {
    hunkIdByAlias,
    partialEvidence,
    prompt: `You are authoring Codophon's narrative walkthrough JSON.

Return JSON only. Do not inspect the repository or run shell commands; use only the optional conversation context and repository digest below.
Keep the walkthrough self-contained. Do not include external citations, URLs, images, or clickable diagram links; use local diff hunk IDs for evidence.
If source.description is present, treat it as author-written PR/MR intent and orientation, not proof of behavior. The changed files, patches, and hunk data remain the source of truth for what changed.

${buildWalkthroughSizingGuidance(state)}

Walkthrough summary:
${getAgentPrompt('walkthroughSummary', prompts)}

Design overview contract (for pull requests with a substantive behavior or design change):
- Use goalSource "stated" only if the PR title or description states the goal; otherwise use "inferred". Use before for old behavior, after for new behavior, and unchanged for important retained behavior.
- Include at most one diagram with a short title and raw Mermaid (no Markdown fence) with at most 7 meaningful nodes or participants. Do not depict unverified behavior as fact.
- Give up to ${MAX_DESIGN_IMPLEMENTATION_ITEMS} implementation entries, each with a short title, a description of the mechanism, and a hunkId from the current digest showing where it is implemented. Do not add review findings, alternatives, or questions to the overview.
- Use plain text for all fields except the Mermaid source. Return null for designOverview outside a pull request, or if there is no substantive design change or not enough visible evidence.
${partialEvidence ? '- Some patch text was omitted. Be explicit about uncertainty and do not assume what happens in missing code.\n' : ''}
Design overview writing guidance:
${getAgentPrompt('walkthroughDesign', prompts)}

How to title chapters and stops:
Keep chapter titles at most 16 characters.
${getAgentPrompt('walkthroughTitles', prompts)}

How to write each stop:
${getAgentPrompt('walkthroughStops', prompts)}
${state.source.type === 'working-tree' ? `\nCommit message writing guidance:\n${getAgentPrompt('commitMessage', prompts)}\n` : ''}

${buildWalkthroughContextInput(context, agentLabel)}
${buildCustomPromptInput(customPrompt)}
${buildPreviousWalkthroughInput(previousWalkthrough, prompts)}
Repository change digest:
${JSON.stringify(input)}
`,
  };
};

const buildNarrativeWalkthroughPrompt = (
  state: RepositoryState,
  context?: WalkthroughContext | null,
  agentLabel = 'Codex',
  customPrompt?: unknown,
  previousWalkthrough?: NarrativeWalkthrough,
  prompts?: AgentPromptOverrides,
) =>
  buildNarrativeWalkthroughRequest(
    state,
    context,
    agentLabel,
    customPrompt,
    previousWalkthrough,
    prompts,
  ).prompt;

/**
 * Cache identity for the exact model input. The previous walkthrough is
 * intentionally excluded: forced regeneration replaces the cached result for
 * the current diff rather than creating a second cache lineage.
 */
const getNarrativeWalkthroughCacheKey = (
  state: RepositoryState,
  agent: Pick<Agent, 'id' | 'label' | 'normalizeModel'>,
  model: unknown,
  context?: WalkthroughContext | null,
  customPrompt?: unknown,
  reasoningEffort?: string,
  prompts?: import('../core/config/types.ts').AgentPromptOverrides,
) => {
  const prompt = buildNarrativeWalkthroughPrompt(
    state,
    context,
    agent.label,
    customPrompt,
    undefined,
    prompts,
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        agent: agent.id,
        diff: state.files.map((file) => ({
          fingerprint: file.fingerprint,
          oldPath: file.oldPath,
          path: file.path,
          status: file.status,
          sections: file.sections.map((section) => ({
            hunkIds: getSectionWalkthroughHunks(file, section).map((hunk) => hunk.id),
            id: section.id,
            kind: section.kind,
          })),
        })),
        model: agent.normalizeModel(model),
        ...(agent.id === 'codex' && reasoningEffort?.trim()
          ? { reasoningEffort: reasoningEffort.trim() }
          : {}),
        prompt,
        revisionGuidance: getAgentPrompt('walkthroughRevision', prompts),
        responseSchema: narrativeWalkthroughResponseSchema,
        version: WALKTHROUGH_CACHE_KEY_VERSION,
      }),
    )
    .digest('hex');
};

const readNarrativeWalkthrough = async (
  state: RepositoryState,
  agent: AgentRunner,
  agentOptions: AgentOptions,
  context?: WalkthroughContext | null,
  customPrompt?: unknown,
  previousWalkthrough?: NarrativeWalkthrough,
  prompts?: AgentPromptOverrides,
): Promise<NarrativeWalkthroughResult> => {
  try {
    const timeoutMs = getNarrativeWalkthroughTimeoutMs(state, agent.defaultTimeoutMs);
    const { fileCount, hunkCount } = getWalkthroughSize(state);
    const { hunkIdByAlias, partialEvidence, prompt } = buildNarrativeWalkthroughRequest(
      state,
      context,
      agent.label,
      customPrompt,
      previousWalkthrough,
      prompts,
    );
    agentOptions?.onProgress?.('agent-generation');
    const response = await agent.run(
      state.root,
      prompt,
      narrativeWalkthroughResponseSchema,
      'walkthrough.json',
      `${agent.label} walkthrough timed out after ${Math.ceil(timeoutMs / 1_000)} seconds while processing ${fileCount} files and ${hunkCount} reviewable hunks.`,
      {
        ...agentOptions,
        timeoutMs,
      },
    );
    agentOptions?.onProgress?.('response-received');
    const walkthrough = normalizeNarrativeWalkthrough(
      response,
      state.files,
      {
        agent: agent.id,
        branch: state.branch,
        generatedAt: state.generatedAt,
        partialEvidence,
        root: state.root,
        source: state.source,
      },
      hunkIdByAlias,
    );
    if (context && !walkthrough.context) {
      walkthrough.context = context;
    }

    return {
      status: 'ready',
      walkthrough,
    };
  } catch (error) {
    if (agent.isNotFoundError(error)) {
      return {
        code: agent.notFoundCode,
        reason: error instanceof Error ? error.message : String(error),
        status: 'unavailable',
      };
    }

    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

export {
  assertWalkthroughHunkIdsResolve,
  buildNarrativeWalkthroughPrompt,
  getNarrativeWalkthroughCacheKey,
  narrativeWalkthroughSchema,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
};
