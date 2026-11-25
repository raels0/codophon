import { execFileSync } from 'node:child_process';

export type ReviewProvider = 'github' | 'azure-devops';

// Reviews are usually pasted straight from a browser, so anything after the review number is a tab
// (`/files`, `/changes`, `/diffs`), a query, or an anchor, and none of it identifies the review.
const gitHubPullRequestPattern = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/;
const azureDevOpsPullRequestPattern =
  /^\/(.+?)\/_git\/([^/]+)\/pullrequests?\/([1-9]\d*)(?:\/.*)?$/i;
const azureDevOpsGitRemotePattern = /^(.+)\/_git\/([^/]+)$/i;
const azureDevOpsSshRemotePattern = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/i;
const markdownAutolinkPattern = /^<(.+)>$/;
const schemePattern = /^[A-Za-z][A-Za-z\d+.-]*:/;
// A scheme-less paste only counts as a URL when it starts with something host-shaped, so relative
// paths and refs are never mistaken for links.
const hostPrefixPattern = /^[^/\s:@]+\.[^/\s:@]+(?::\d+)?\//;

const stripGitSuffix = (value: string) => value.replace(/\.git$/i, '');

const decodePathSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const isGitHubHost = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'github.com' || normalized === 'www.github.com';
};

const isAzureDevOpsSshHost = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'ssh.dev.azure.com' || normalized === 'vs-ssh.visualstudio.com';
};

const isAzureDevOpsWebHost = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'dev.azure.com' ||
    normalized === 'www.dev.azure.com' ||
    normalized.endsWith('.visualstudio.com')
  );
};

const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

const formatAzureDevOpsUrl = (
  webHost: string,
  organization: string,
  project: string,
  repo: string,
  number?: number,
) => {
  const encodedProject = encodePath(project);
  const encodedRepo = encodeURIComponent(repo);
  const suffix = number == null ? '' : `/pullrequest/${number}`;
  if (webHost.endsWith('.visualstudio.com')) {
    return `https://${webHost}/${encodedProject}/_git/${encodedRepo}${suffix}`;
  }
  return `https://${webHost}/${encodePath(organization)}/${encodedProject}/_git/${encodedRepo}${suffix}`;
};

const parseAzureDevOpsRemote = (
  hostname: string,
  projectPath: string,
): {
  apiBase: string;
  host: string;
  organization: string;
  organizationUrl: string;
  project: string;
  projectPath: string;
  provider: 'azure-devops';
  repo: string;
  webHost: string;
} | null => {
  const host = hostname.toLowerCase();
  const path = stripGitSuffix(projectPath).replace(/^\/+/, '');
  let organization;
  let project;
  let repo;
  if (isAzureDevOpsSshHost(host)) {
    const match = path.match(azureDevOpsSshRemotePattern);
    if (!match) {
      return null;
    }
    [organization, project, repo] = match.slice(1).map(decodePathSegment);
  } else {
    const match = isAzureDevOpsWebHost(host) ? path.match(azureDevOpsGitRemotePattern) : null;
    if (!match) {
      return null;
    }
    const prefix = match[1].split('/').map(decodePathSegment);
    repo = decodePathSegment(match[2]);
    if (host.endsWith('.visualstudio.com')) {
      organization = host.slice(0, -'.visualstudio.com'.length);
      if (prefix[0]?.toLowerCase() === 'defaultcollection') {
        prefix.shift();
      }
      if (prefix.length > 1) {
        return null;
      }
      project = prefix[0] || repo;
    } else {
      if (prefix.length > 2) {
        return null;
      }
      organization = prefix[0];
      project = prefix[1] || repo;
    }
  }
  if (!organization || !project || !repo) {
    return null;
  }
  const webHost = host.endsWith('.visualstudio.com')
    ? `${organization}.visualstudio.com`
    : 'dev.azure.com';
  const organizationUrl =
    webHost === 'dev.azure.com'
      ? `https://${webHost}/${encodeURIComponent(organization)}`
      : `https://${webHost}`;
  return {
    apiBase: `${organizationUrl}/${encodeURIComponent(project)}`,
    host,
    organization,
    organizationUrl,
    project,
    projectPath: `${organization}/${project}/${repo}`,
    provider: 'azure-devops' as const,
    repo,
    webHost,
  };
};

const toReviewUrl = (value: string) => {
  const trimmed = value.trim();
  const unwrapped = trimmed.match(markdownAutolinkPattern)?.[1] ?? trimmed;
  const candidate = schemePattern.test(unwrapped)
    ? unwrapped
    : hostPrefixPattern.test(unwrapped)
      ? `https://${unwrapped}`
      : null;
  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
};

const parseReviewUrl = (value: string) => {
  const url = toReviewUrl(value);
  if (!url) {
    return null;
  }

  const github = isGitHubHost(url.hostname) ? url.pathname.match(gitHubPullRequestPattern) : null;
  const repo = github ? stripGitSuffix(github[2]) : '';
  if (github && repo) {
    return {
      host: 'github.com',
      number: Number(github[3]),
      owner: github[1],
      projectPath: `${github[1]}/${repo}`,
      provider: 'github' as const,
      repo,
      url: `https://github.com/${github[1]}/${repo}/pull/${github[3]}`,
    };
  }

  const azurePath = url.pathname.match(azureDevOpsPullRequestPattern);
  const azureRemote =
    azurePath && isAzureDevOpsWebHost(url.hostname)
      ? parseAzureDevOpsRemote(url.hostname, `${azurePath[1]}/_git/${azurePath[2]}`)
      : null;
  if (azurePath && azureRemote) {
    const number = Number(azurePath[3]);
    return {
      ...azureRemote,
      host: azureRemote.webHost,
      number,
      url: formatAzureDevOpsUrl(
        azureRemote.webHost,
        azureRemote.organization,
        azureRemote.project,
        azureRemote.repo,
        number,
      ),
    };
  }

  return null;
};

const parseRemoteUrl = (value: string) => {
  const trimmed = value.trim();
  const scp = trimmed.match(/^(?:[^@/\s]+@)*([^@/\s:]+):(.+)$/);
  if (scp && !trimmed.includes('://') && !/^[A-Za-z]:/.test(trimmed)) {
    const host = scp[1].toLowerCase();
    const projectPath = scp[2].replaceAll(/^\/+|\.git$/gi, '');
    if (!projectPath) {
      return null;
    }
    const azure = parseAzureDevOpsRemote(host, projectPath);
    if (azure) {
      return azure;
    }
    return isGitHubHost(host) ? { host, projectPath, provider: 'github' as const } : null;
  }

  try {
    const url = new URL(trimmed);
    const host = (url.protocol === 'ssh:' ? url.hostname : url.host).toLowerCase();
    const projectPath = url.pathname.replaceAll(/^\/+|\.git$/gi, '');
    if (!projectPath) {
      return null;
    }
    const azure = parseAzureDevOpsRemote(url.hostname, projectPath);
    if (azure) {
      return azure;
    }
    return isGitHubHost(url.hostname) ? { host, projectPath, provider: 'github' as const } : null;
  } catch {
    return null;
  }
};

const readReviewRemotes = (repositoryPath: string) => {
  const root = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const raw = execFileSync('git', ['-C', root, 'remote', '-v'], { encoding: 'utf8' });
  const remotes = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseRemoteUrl(match[2]) : null;
    if (match && remote) {
      remotes.push({ direction: match[3], name: match[1], ...remote });
    }
  }
  return remotes;
};

const remotePriority = (remote: { direction: string; name: string }) =>
  remote.name === 'origin'
    ? remote.direction === 'fetch'
      ? 0
      : 1
    : remote.direction === 'fetch'
      ? 2
      : 3;

/**
 * `codophon pr` is GitHub-first, but Azure DevOps also calls them pull requests.
 * Prefer a GitHub remote when both exist; otherwise use the Azure remote.
 */
const remoteMatchesProvider = (
  provider: ReviewProvider | undefined,
  remote: { provider: ReviewProvider },
) =>
  !provider ||
  remote.provider === provider ||
  (provider === 'github' && remote.provider === 'azure-devops');

const providerPriority = (
  provider: ReviewProvider | undefined,
  left: { provider: ReviewProvider },
  right: { provider: ReviewProvider },
) => {
  if (provider !== 'github') {
    return 0;
  }
  return (left.provider === 'github' ? 0 : 1) - (right.provider === 'github' ? 0 : 1);
};

const resolveReviewUrl = (repositoryPath: string, number: number, provider?: ReviewProvider) => {
  let remotes;
  try {
    remotes = readReviewRemotes(repositoryPath);
  } catch {
    throw new Error(
      `Could not resolve review #${number}. Run codophon inside a Git repository or pass a full pull request URL.`,
    );
  }

  const remote = remotes
    .filter((candidate) => remoteMatchesProvider(provider, candidate))
    .sort(
      (left, right) =>
        providerPriority(provider, left, right) || remotePriority(left) - remotePriority(right),
    )[0];
  if (!remote) {
    throw new Error(
      `Could not resolve ${
        provider === 'azure-devops' ? 'Azure DevOps PR' : provider === 'github' ? 'PR' : 'review'
      } #${number} from this repository's remotes.`,
    );
  }

  if (remote.provider === 'github') {
    return `https://github.com/${remote.projectPath}/pull/${number}`;
  }
  return formatAzureDevOpsUrl(
    remote.webHost,
    remote.organization,
    remote.project,
    remote.repo,
    number,
  );
};

export { parseRemoteUrl, parseReviewUrl, readReviewRemotes, resolveReviewUrl };
