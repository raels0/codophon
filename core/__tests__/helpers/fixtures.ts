import type { ChangedFile, RepositoryState } from '../../types.ts';

type ChangedFileOptions = {
  fingerprint?: string;
  kind?: ChangedFile['sections'][number]['kind'];
  patch?: string;
  status?: ChangedFile['status'];
};

export const createChangedFile = (
  path: string,
  {
    fingerprint = `${path}:1`,
    kind = 'unstaged',
    patch,
    status = 'modified',
  }: ChangedFileOptions = {},
) =>
  ({
    fingerprint,
    path,
    sections: [
      {
        binary: false,
        id: `${path}:${kind}`,
        kind,
        patch: patch ?? `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      },
    ],
    status,
  }) satisfies ChangedFile;

type SectionFixture = Omit<ChangedFile['sections'][number], 'binary'> & { binary?: boolean };
type FileFixture = Omit<ChangedFile, 'fingerprint' | 'sections'> & {
  fingerprint?: string;
  sections: ReadonlyArray<SectionFixture>;
};

/** Changed files for tests; fingerprints and `binary: false` are filled in when omitted. */
export const changedFiles = (files: ReadonlyArray<FileFixture>): Array<ChangedFile> =>
  files.map((file) => ({
    ...file,
    fingerprint: file.fingerprint ?? `${file.path}:1`,
    sections: file.sections.map((section) => ({ binary: false, ...section })),
  }));

/** A repository snapshot for tests: a clean working tree at /repo unless overridden. */
export const repositoryState = (
  state: Partial<Omit<RepositoryState, 'files'>> & { files: ReadonlyArray<FileFixture> },
): RepositoryState => ({
  branch: 'main',
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
  ...state,
  files: changedFiles(state.files),
});
