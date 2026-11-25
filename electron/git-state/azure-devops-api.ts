import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { findExecutableOnPath, isExecutableFile } from '../agent-shared.ts';
import { getCommandEnvironment } from '../login-shell-environment.ts';

export type AzureIdentity = {
  id: string;
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
  url?: string;
  _links?: { web?: { href?: string } };
};

export type AzureCommitReference = { commitId: string };

export type AzurePullRequest = {
  createdBy: AzureIdentity;
  description?: string;
  forkSource?: { repository?: { remoteUrl?: string } };
  isDraft?: boolean;
  lastMergeSourceCommit?: AzureCommitReference;
  lastMergeTargetCommit?: AzureCommitReference;
  reviewers?: Array<AzureIdentity & { vote?: number }>;
  status?: string;
  title?: string;
};

export type AzurePosition = { line: number; offset: number };

export type AzureThreadContext = {
  filePath: string;
  leftFileStart?: AzurePosition;
  leftFileEnd?: AzurePosition;
  rightFileStart?: AzurePosition;
  rightFileEnd?: AzurePosition;
};

export type AzureComment = {
  id: number;
  author: AzureIdentity;
  commentType?: string | number;
  content?: string;
  isDeleted?: boolean;
  publishedDate?: string;
  lastContentUpdatedDate?: string;
};

export type AzureThread = {
  id: number;
  status: string | number;
  isDeleted?: boolean;
  comments?: Array<AzureComment>;
  threadContext?: AzureThreadContext;
};

export type AzurePullRequestReference = Extract<
  NonNullable<ReturnType<typeof import('../review-source.ts').parseReviewUrl>>,
  { provider: 'azure-devops' }
>;

const execFileAsync = promisify(execFile);
const AZURE_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API_VERSION = '7.1';
const AZ_NOT_FOUND_CODE = 'AZ_NOT_FOUND';

const missingAzureCli = (detail: string = '') =>
  Object.assign(
    new Error(
      `Azure DevOps support requires the Azure CLI. Install it, run \`az login\`, and ensure \`az --version\` works. Use CODOPHON_AZ_PATH for a non-PATH installation. ${detail}`.trim(),
    ),
    { code: AZ_NOT_FOUND_CODE },
  );

const getAzCommand = () => {
  const override = process.env.CODOPHON_AZ_PATH?.trim();
  if (override) {
    if (!isExecutableFile(override)) {
      throw missingAzureCli(`CODOPHON_AZ_PATH is not executable: ${override}`);
    }
    return override;
  }
  const command =
    (process.platform === 'win32'
      ? ['az.exe', 'az.cmd', 'az.bat'].map(findExecutableOnPath).find(Boolean)
      : findExecutableOnPath('az')) ||
    [join(homedir(), '.local', 'bin', 'az'), '/opt/homebrew/bin/az', '/usr/local/bin/az'].find(
      isExecutableFile,
    );
  if (!command) {
    throw missingAzureCli();
  }
  return command;
};

const getAzCommandTransport = (command: string, platform: string = process.platform) => {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args: [] };
  }
  // The MSI's az.cmd wraps Python. Invoke that interpreter directly, never a shell.
  const python = join(dirname(command), '..', 'python.exe');
  if (!isExecutableFile(python)) {
    throw missingAzureCli('The Azure CLI installation is missing its bundled python.exe.');
  }
  return { command: python, args: ['-m', 'azure.cli'] };
};

/**
 * Keep authentication, Windows launch rules, and request serialization out of the Git layer.
 */
const createAzureDevOpsClient = (repoRoot: string, pullRequest: AzurePullRequestReference) => {
  const endpoint = `${pullRequest.apiBase}/_apis/git/repositories/${encodeURIComponent(pullRequest.repo)}/pullRequests/${pullRequest.number}`;

  const request = async <T>(uri: string, method = 'GET', body?: unknown): Promise<T> => {
    const transport = getAzCommandTransport(getAzCommand());
    const directory = body == null ? null : await fs.mkdtemp(join(tmpdir(), 'codophon-az-'));
    try {
      const bodyPath = directory ? join(directory, 'body.json') : null;
      if (bodyPath) {
        await fs.writeFile(bodyPath, JSON.stringify(body), { mode: 0o600 });
      }
      const { stdout } = await execFileAsync(
        transport.command,
        [
          ...transport.args,
          'rest',
          '--method',
          method,
          '--uri',
          uri,
          '--resource',
          AZURE_RESOURCE,
          '--output',
          'json',
          '--only-show-errors',
          ...(bodyPath
            ? ['--headers', 'Content-Type=application/json', '--body', `@${bodyPath}`]
            : []),
        ],
        {
          cwd: repoRoot,
          env: { ...(await getCommandEnvironment()), PYTHONIOENCODING: 'utf-8' },
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
        },
      );
      if (!stdout.trim()) {
        throw new Error(`Azure DevOps returned an empty response to ${method}.`);
      }
      return JSON.parse(stdout);
    } finally {
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  };

  const url = (suffix: string = '', query: string = '') =>
    `${endpoint}${suffix}?api-version=${API_VERSION}${query ? `&${query}` : ''}`;

  const collection = async <T>(suffix: string, query?: string): Promise<Array<T>> => {
    const payload: { value: Array<T> } = await request(url(suffix, query));
    if (!Array.isArray(payload?.value)) {
      throw new Error(`Azure DevOps did not return ${suffix.slice(1)} for this pull request.`);
    }
    return payload.value;
  };

  const authenticatedUserId = async () => {
    const connection: { authenticatedUser: AzureIdentity } = await request(
      `${pullRequest.organizationUrl}/_apis/connectionData?api-version=${API_VERSION}`,
    );
    const id = connection?.authenticatedUser?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error('Azure DevOps did not return the signed-in user.');
    }
    return id;
  };

  return {
    authenticatedUserId,

    metadata: async (): Promise<AzurePullRequest> => {
      const metadata: AzurePullRequest = await request(url());
      if (!metadata || typeof metadata !== 'object') {
        throw new Error('Azure DevOps did not return pull request metadata.');
      }
      return metadata;
    },

    threads: (): Promise<Array<AzureThread>> => collection('/threads'),

    createThread: (body: unknown): Promise<AzureThread> => request(url('/threads'), 'POST', body),

    reply: (threadId: string, content: string): Promise<AzureComment> =>
      request(url(`/threads/${encodeURIComponent(threadId)}/comments`), 'POST', {
        commentType: 1,
        content,
        parentCommentId: 1,
      }),

    vote: async (vote: number) => {
      const id = await authenticatedUserId();
      await request(url(`/reviewers/${encodeURIComponent(id)}`), 'PUT', { id, vote });
    },
  };
};

export { AZ_NOT_FOUND_CODE, createAzureDevOpsClient, getAzCommand, getAzCommandTransport };
