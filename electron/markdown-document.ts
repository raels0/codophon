import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, watch } from 'node:fs';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

class MarkdownDocumentConflictError extends Error {
  document: import('../core/types.ts').CodophonMarkdownDocument;

  constructor(document: import('../core/types.ts').CodophonMarkdownDocument) {
    super(`Markdown document changed on disk: ${document.path}`);
    this.document = document;
    this.name = 'MarkdownDocumentConflictError';
  }
}

const hashContent = (content: string) => createHash('sha256').update(content).digest('hex');

const isMarkdownPath = (path: string) => /\.md$/i.test(path);

const isPathWithinRoot = (root: string, filePath: string) => {
  const relativePath = relative(root, filePath);
  return (
    relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep)
  );
};

const resolveRepositoryMarkdownPath = (root: string, filePath: string) => {
  if (
    !filePath ||
    filePath.includes('\0') ||
    filePath.startsWith('/') ||
    filePath.startsWith('\\') ||
    !isMarkdownPath(filePath)
  ) {
    throw new Error('Invalid repository Markdown path.');
  }

  const repositoryRoot = realpathSync(resolve(root));
  const requestedPath = resolve(repositoryRoot, filePath);
  const relativePath = relative(repositoryRoot, requestedPath);
  if (!relativePath || !isPathWithinRoot(repositoryRoot, requestedPath)) {
    throw new Error('Markdown path escapes the repository.');
  }

  const absolutePath = realpathSync(requestedPath);
  if (!isPathWithinRoot(repositoryRoot, absolutePath)) {
    throw new Error('Markdown path escapes the repository.');
  }

  return {
    absolutePath,
    id: `repository:${relativePath.replaceAll('\\', '/')}`,
    kind: 'repository' as const,
    path: relativePath.replaceAll('\\', '/'),
  };
};

const resolveMarkdownPath = (
  request: { kind: 'repository'; path: string },
  context: { repositoryRoot: string },
) => {
  return resolveRepositoryMarkdownPath(context.repositoryRoot, request.path);
};

const readResolvedMarkdownDocument = async (resolved: {
  absolutePath: string;
  id: string;
  kind: 'repository';
  path: string;
}): Promise<import('../core/types.ts').CodophonMarkdownDocument> => {
  const [content, fileStat] = await Promise.all([
    readFile(resolved.absolutePath, 'utf8'),
    stat(resolved.absolutePath),
  ]);
  if (!fileStat.isFile()) {
    throw new Error(`Not a file: ${resolved.path}`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error('Markdown document exceeds the 2 MB limit.');
  }

  return {
    content,
    id: resolved.id,
    kind: resolved.kind,
    path: resolved.path,
    version: hashContent(content),
  };
};

const readMarkdownDocument = async (
  request: { kind: 'repository'; path: string },
  context: { repositoryRoot: string },
) => readResolvedMarkdownDocument(resolveMarkdownPath(request, context));

const writeMarkdownDocument = async (
  request: {
    baseVersion: string;
    content: string;
    kind: 'repository';
    path: string;
  },
  context: { repositoryRoot: string },
) => {
  if (Buffer.byteLength(request.content, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error('Markdown document exceeds the 2 MB limit.');
  }

  const resolved = resolveMarkdownPath(request, context);
  const current = await readResolvedMarkdownDocument(resolved);
  if (current.version !== request.baseVersion) {
    if (current.content === request.content) {
      return current;
    }
    throw new MarkdownDocumentConflictError(current);
  }
  if (current.content === request.content) {
    return current;
  }

  const temporaryPath = resolve(
    dirname(resolved.absolutePath),
    `.${basename(resolved.absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const fileMode = (await stat(resolved.absolutePath)).mode & 0o7777;
  const file = await open(temporaryPath, 'wx', fileMode);

  try {
    await file.chmod(fileMode);
    await file.writeFile(request.content, 'utf8');
    await file.sync();
    await file.close();
    await rename(temporaryPath, resolved.absolutePath);
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  return readResolvedMarkdownDocument(resolved);
};

/** Watches parent directories so atomic file replacement does not detach the watcher. */
const watchMarkdownDocument = ({
  onChange,
  onDelete,
  resolved,
}: {
  onChange: (document: import('../core/types.ts').CodophonMarkdownDocument) => void;
  onDelete?: (id: string) => void;
  resolved: { absolutePath: string; id: string; kind: 'repository'; path: string };
}) => {
  let timer: string | number | NodeJS.Timeout | null | undefined = null;
  const watcher = watch(
    dirname(resolved.absolutePath),
    { persistent: false },
    (_event, filename) => {
      if (filename && String(filename) !== basename(resolved.absolutePath)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void readResolvedMarkdownDocument(resolved).then(onChange, (error) => {
          if (error?.code === 'ENOENT') {
            onDelete?.(resolved.id);
          }
        });
      }, 30);
    },
  );

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    watcher.close();
  };
};

export {
  MarkdownDocumentConflictError,
  readMarkdownDocument,
  resolveMarkdownPath,
  watchMarkdownDocument,
  writeMarkdownDocument,
};
