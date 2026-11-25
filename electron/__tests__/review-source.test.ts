import { expect, test } from 'vite-plus/test';
import { parseRemoteUrl, parseReviewUrl } from '../review-source.ts';

test('parseReviewUrl reads canonical GitHub pull request URLs', () => {
  expect(parseReviewUrl('https://github.com/raels0/codophon/pull/1728')).toEqual({
    host: 'github.com',
    number: 1728,
    owner: 'raels0',
    projectPath: 'raels0/codophon',
    provider: 'github',
    repo: 'codophon',
    url: 'https://github.com/raels0/codophon/pull/1728',
  });
});

test('parseReviewUrl ignores GitHub tab segments, queries and fragments', () => {
  for (const value of [
    'https://github.com/raels0/codophon/pull/1728/',
    'https://github.com/raels0/codophon/pull/1728/changes#r2231',
    'https://github.com/raels0/codophon/pull/1728/files',
    'https://github.com/raels0/codophon/pull/1728/files#diff-8a1b2c',
    'https://github.com/raels0/codophon/pull/1728/commits/0f1e2d3c',
    'https://github.com/raels0/codophon/pull/1728?diff=split&w=1',
    'https://github.com/raels0/codophon/pull/1728#issuecomment-4412',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 1728,
      provider: 'github',
      url: 'https://github.com/raels0/codophon/pull/1728',
    });
  }
});

test('parseReviewUrl accepts GitHub URLs pasted without a scheme or with `www`', () => {
  for (const value of [
    'github.com/raels0/codophon/pull/1728/changes',
    'www.github.com/raels0/codophon/pull/1728',
    'https://www.github.com/raels0/codophon/pull/1728/files',
    'HTTPS://GitHub.com/raels0/codophon/pull/1728',
    '<https://github.com/raels0/codophon/pull/1728>',
    '  https://github.com/raels0/codophon/pull/1728/files  ',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      host: 'github.com',
      number: 1728,
      owner: 'raels0',
      repo: 'codophon',
      url: 'https://github.com/raels0/codophon/pull/1728',
    });
  }
});

test('parseReviewUrl strips a `.git` suffix from GitHub repositories', () => {
  expect(parseReviewUrl('https://github.com/raels0/codophon.git/pull/1728')).toMatchObject({
    projectPath: 'raels0/codophon',
    repo: 'codophon',
    url: 'https://github.com/raels0/codophon/pull/1728',
  });
});

test('parseReviewUrl rejects values that are not review URLs', () => {
  for (const value of [
    '',
    'main',
    'feature/pull/1',
    'https://github.com/raels0/codophon',
    'https://github.com/raels0/codophon/pull/0',
    'https://github.com/raels0/codophon/pull/abc',
    'https://github.com/raels0/codophon/issues/1728',
    'https://example.com/raels0/codophon/pull/1728',
    'https://dev.azure.com/org/project/_git/repo',
    'some/local/path/merge_requests/23',
  ]) {
    expect(parseReviewUrl(value)).toBe(null);
  }
});

test('parseRemoteUrl ignores remotes that are neither GitHub nor Azure DevOps', () => {
  expect(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/project.git')).toBeNull();
  expect(parseRemoteUrl('https://gitlab.example.com:8443/group/subgroup/project.git')).toBeNull();
  expect(parseRemoteUrl('git@gitlab.example.com:group/project.git')).toBeNull();
});

test('parseRemoteUrl reads scp-style and GitHub remotes', () => {
  expect(parseRemoteUrl('https://github.com/raels0/codophon.git')).toEqual({
    host: 'github.com',
    projectPath: 'raels0/codophon',
    provider: 'github',
  });
});

test('parseReviewUrl reads Azure DevOps pull request URLs', () => {
  expect(
    parseReviewUrl('https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492'),
  ).toMatchObject({
    host: 'dev.azure.com',
    number: 492,
    organization: 'contoso',
    project: 'Fabrikam',
    projectPath: 'contoso/Fabrikam/Storefront',
    provider: 'azure-devops',
    repo: 'Storefront',
    url: 'https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/492',
  });
});

test('parseReviewUrl ignores Azure DevOps tab segments, queries and fragments', () => {
  for (const value of [
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42/',
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42?_a=files',
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42?discussionId=18',
    'https://dev.azure.com/org/project/_git/repo/pullrequest/42#_a=overview',
    'dev.azure.com/org/project/_git/repo/pullrequest/42?path=/src/a.ts',
    '<https://dev.azure.com/org/project/_git/repo/pullRequest/42>',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 42,
      provider: 'azure-devops',
      url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
    });
  }
});

test('parseReviewUrl reads visualstudio.com Azure DevOps pull request URLs', () => {
  expect(
    parseReviewUrl('https://contoso.visualstudio.com/Fabrikam/_git/Widgets/pullrequest/9'),
  ).toMatchObject({
    host: 'contoso.visualstudio.com',
    number: 9,
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Widgets',
    url: 'https://contoso.visualstudio.com/Fabrikam/_git/Widgets/pullrequest/9',
  });
});

test('Azure DevOps URLs require a known cloud host and preserve encoded project names', () => {
  expect(parseReviewUrl('https://example.com/org/project/_git/repo/pullrequest/42')).toBeNull();
  expect(
    parseReviewUrl('https://dev.azure.com.evil.example/org/project/_git/repo/pullrequest/42'),
  ).toBeNull();
  expect(
    parseReviewUrl('https://dev.azure.com/org/My%20Project/_git/My%20Repo/pullrequest/42'),
  ).toMatchObject({
    project: 'My Project',
    repo: 'My Repo',
    url: 'https://dev.azure.com/org/My%20Project/_git/My%20Repo/pullrequest/42',
  });
  expect(
    parseReviewUrl(
      'https://contoso.visualstudio.com/DefaultCollection/My%20Project/_git/repo/pullrequest/42',
    ),
  ).toMatchObject({
    organization: 'contoso',
    project: 'My Project',
    url: 'https://contoso.visualstudio.com/My%20Project/_git/repo/pullrequest/42',
  });
});

test('parseRemoteUrl classifies Azure DevOps HTTPS and SSH remotes', () => {
  expect(parseRemoteUrl('https://dev.azure.com/contoso/Fabrikam/_git/Storefront')).toMatchObject({
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Storefront',
    webHost: 'dev.azure.com',
  });
  expect(parseRemoteUrl('git@ssh.dev.azure.com:v3/contoso/Fabrikam/Storefront')).toMatchObject({
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Storefront',
    webHost: 'dev.azure.com',
  });
  expect(
    parseRemoteUrl('git@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/Widgets.git'),
  ).toMatchObject({
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Widgets',
    webHost: 'contoso.visualstudio.com',
  });
  expect(
    parseRemoteUrl('vsshadmin@contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/Widgets.git'),
  ).toMatchObject({
    organization: 'contoso',
    project: 'Fabrikam',
    provider: 'azure-devops',
    repo: 'Widgets',
    webHost: 'contoso.visualstudio.com',
  });
});
