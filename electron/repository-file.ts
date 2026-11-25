import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const hashContent = (content: string) => createHash('sha256').update(content).digest('hex');

const isWithinRoot = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

const resolveRepositoryFile = async (repositoryRoot: string, path: string) => {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository file path.');
  }
  const root = await realpath(repositoryRoot);
  const requestedPath = resolve(root, path);
  const absolutePath = await realpath(requestedPath);
  if (!isWithinRoot(root, requestedPath) || !isWithinRoot(root, absolutePath)) {
    throw new Error('File path escapes the repository.');
  }
  // Git metadata must never be editable through the code surface.
  if (
    relative(root, requestedPath).split(sep).includes('.git') ||
    relative(root, absolutePath).split(sep).includes('.git')
  ) {
    throw new Error('Git metadata cannot be edited.');
  }
  return { absolutePath, path, root };
};

const readResolvedFile = async (resolved: { absolutePath: string; path: string; root: string }) => {
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error('Only regular files can be edited.');
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 2 MB editing limit.');
  }
  const bytes = await readFile(resolved.absolutePath);
  const content = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
    throw new Error('Only UTF-8 text files can be edited.');
  }
  return { content, path: resolved.path, root: resolved.root, version: hashContent(content) };
};

const readRepositoryFile = async (repositoryRoot: string, path: string) =>
  readResolvedFile(await resolveRepositoryFile(repositoryRoot, path));

const writeRepositoryFile = async (
  repositoryRoot: string,
  request: import('../core/types.ts').SaveRepositoryFileRequest,
): Promise<import('../core/types.ts').SaveRepositoryFileResult> => {
  if (
    typeof request.content !== 'string' ||
    request.content.includes('\0') ||
    Buffer.byteLength(request.content, 'utf8') > MAX_FILE_BYTES
  ) {
    throw new Error('File must be UTF-8 text within the 2 MB editing limit.');
  }
  const resolved = await resolveRepositoryFile(repositoryRoot, request.path);
  if (request.root !== resolved.root) {
    throw new Error('The edited file belongs to a different repository.');
  }
  const current = await readResolvedFile(resolved);
  if (current.content === request.content) {
    return { document: current, status: 'saved' };
  }
  if (current.version !== request.baseVersion) {
    return { document: current, status: 'conflict' };
  }
  const temporaryPath = resolve(
    dirname(resolved.absolutePath),
    `.${basename(resolved.absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const mode = (await stat(resolved.absolutePath)).mode & 0o7777;
  const file = await open(temporaryPath, 'wx', mode);
  try {
    await file.chmod(mode);
    await file.writeFile(request.content, 'utf8');
    await file.sync();
    await file.close();
    // Check again after preparing the replacement, including symlink retargets.
    const latestResolved = await resolveRepositoryFile(repositoryRoot, request.path);
    const latest = await readResolvedFile(latestResolved);
    if (
      latestResolved.absolutePath !== resolved.absolutePath ||
      latest.version !== current.version
    ) {
      await unlink(temporaryPath);
      return { document: latest, status: 'conflict' };
    }
    await rename(temporaryPath, resolved.absolutePath);
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { document: await readResolvedFile(resolved), status: 'saved' };
};

export { readRepositoryFile, resolveRepositoryFile, writeRepositoryFile };
