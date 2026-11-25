import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  encodeLaunchRequest,
  getInitialRepositoryPath,
  readLaunch,
} from '../main/launch-request.ts';

test('a CLI launch request reaches the app intact, wherever Electron puts it in argv', () => {
  const argument = encodeLaunchRequest({
    agentBackend: 'claude',
    claudeSessionId: 'session',
    repositoryPath: '/repos/widget',
    source: {
      type: 'pull-request',
      url: 'https://dev.azure.com/acme/web/_git/widget/pullrequest/7',
    },
    walkthrough: true,
  });

  expect(readLaunch(['/Applications/Codophon', '--inspect', argument], '/elsewhere')).toEqual({
    launchOptions: {
      agentBackend: 'claude',
      claudeSessionId: 'session',
      repositoryPathProvided: true,
      source: {
        provider: 'azure-devops',
        type: 'pull-request',
        url: 'https://dev.azure.com/acme/web/_git/widget/pullrequest/7',
      },
      walkthrough: true,
    },
    repositoryPath: '/repos/widget',
  });
});

test('a bare launch opens the working directory and ignores unknown agents', () => {
  expect(readLaunch(['/Applications/Codophon'], '/home/me')).toEqual({
    launchOptions: { repositoryPathProvided: false, walkthrough: false },
    repositoryPath: '/home/me',
  });
  expect(
    readLaunch([encodeLaunchRequest({ agentBackend: 'pi' as never })]).launchOptions,
  ).not.toHaveProperty('agentBackend');
  expect(readLaunch(['--launch=not-base64-json'], '/home/me').repositoryPath).toBe('/home/me');
});

test('only a bare launch reopens the last repository', async () => {
  const last = await mkdtemp(join(tmpdir(), 'codophon-last-repo-'));
  try {
    await writeFile(join(last, 'README.md'), '');
    const bare = readLaunch([], '/cwd');
    expect(getInitialRepositoryPath('/cwd', bare.launchOptions, last)).toBe(last);
    expect(getInitialRepositoryPath('/cwd', bare.launchOptions, join(last, 'gone'))).toBe('/cwd');

    const named = readLaunch([encodeLaunchRequest({ repositoryPath: '/named' })]);
    expect(getInitialRepositoryPath('/named', named.launchOptions, last)).toBe('/named');
  } finally {
    await rm(last, { force: true, recursive: true });
  }
});
