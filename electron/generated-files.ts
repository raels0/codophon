import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGeneratedWalkthroughPath } from '../core/lib/narrative-walkthrough-diff.ts';
import { gitBufferWithInput } from './git-state/common.ts';

const GENERATED_ATTRIBUTES = ['linguist-generated', 'gitlab-generated'];

const isGeneratedAttributeValue = (value: string) =>
  value !== 'unspecified' && value !== 'unset' && value !== 'false';

const isNotGeneratedAttributeValue = (value: string) => value === 'unset' || value === 'false';

const getGeneratedAttributeSource = (source: import('../core/types.ts').ReviewSource) =>
  source.type === 'commit'
    ? source.ref
    : source.type === 'range'
      ? source.head
      : source.type === 'branch-diff'
        ? source.headRef
        : source.type === 'pull-request'
          ? source.headSha
          : // `branch-working-tree` includes live uncommitted files, so the generated
            // attribute state must be computed live (like `working-tree`) rather than
            // pinned to a fixed ref.
            undefined;

const parseGeneratedAttributeStates = (output: Buffer) => {
  const fields = output.toString('utf8').split('\0');
  const generatedStates = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index];
    const value = fields[index + 2];
    if (path && isGeneratedAttributeValue(value)) {
      generatedStates.set(path, true);
    } else if (path && isNotGeneratedAttributeValue(value) && generatedStates.get(path) !== true) {
      generatedStates.set(path, false);
    }
  }
  return generatedStates;
};

const checkGeneratedAttributeStates = async (
  repoRoot: string,
  paths: ReadonlyArray<string>,
  options: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) =>
  parseGeneratedAttributeStates(
    await gitBufferWithInput(
      repoRoot,
      ['check-attr', ...options, '-z', '--stdin', ...GENERATED_ATTRIBUTES],
      Buffer.from(`${paths.join('\0')}\0`),
      { env },
    ),
  );

/**
 * Git before 2.40 cannot use `git check-attr --source`. Populate a temporary,
 * isolated index from the reviewed tree and ask the older `--cached` mode to
 * resolve attributes from that index instead.
 */
const readGeneratedAttributeStatesFromTree = async (
  repoRoot: string,
  paths: ReadonlyArray<string>,
  source: string,
) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codophon-generated-files-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryDirectory, 'index'),
  };

  try {
    await gitBufferWithInput(repoRoot, ['read-tree', source], Buffer.alloc(0), { env });
    return await checkGeneratedAttributeStates(repoRoot, paths, ['--cached'], env);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

const readGeneratedAttributeStates = async (
  repoRoot: string,
  paths: ReadonlyArray<string>,
  source: string | undefined,
) => {
  if (paths.length === 0) {
    return new Map();
  }

  try {
    return await checkGeneratedAttributeStates(repoRoot, paths, source ? ['--source', source] : []);
  } catch {
    if (source) {
      try {
        // Git before 2.40 rejects `--source`; use its historical-tree fallback.
        return await readGeneratedAttributeStatesFromTree(repoRoot, paths, source);
      } catch {
        // Ignore invalid or unavailable historical sources.
      }
    }
    return new Map();
  }
};

const applyGeneratedAttributeStates = <
  State extends Pick<import('../core/types.ts').RepositoryState, 'files'>,
>(
  state: State,
  generatedAttributeStates: ReadonlyMap<string, boolean>,
): State => ({
  ...state,
  files: state.files.map((file) => {
    const attributeState = generatedAttributeStates.get(file.path);
    if (attributeState != null) {
      return file.generated === attributeState ? file : { ...file, generated: attributeState };
    }
    if (file.generated != null) {
      return file;
    }
    return isGeneratedWalkthroughPath(file.path) ? { ...file, generated: true } : file;
  }),
});

const annotateGeneratedFiles = async <
  State extends Pick<import('../core/types.ts').RepositoryState, 'files' | 'root' | 'source'>,
>(
  state: State,
): Promise<State> =>
  applyGeneratedAttributeStates(
    state,
    await readGeneratedAttributeStates(
      state.root,
      state.files.map((file) => file.path),
      getGeneratedAttributeSource(state.source),
    ),
  );

export { annotateGeneratedFiles, applyGeneratedAttributeStates, readGeneratedAttributeStates };
