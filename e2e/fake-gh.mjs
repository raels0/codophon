#!/usr/bin/env node
// Stands in for `gh api` in end-to-end tests. Serves the pull request in $FAKE_GH_STATE and
// records every call (with any stdin body) to $FAKE_GH_LOG.
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('gh version 2.80.0\n');
  process.exit(0);
}
const input = args.includes('--input') ? readFileSync(0, 'utf8') : '';
const fields = Object.fromEntries(
  args.flatMap((arg, index) =>
    ['-f', '-F', '--field', '--raw-field'].includes(args[index - 1])
      ? [arg.split(/=(.*)/s).slice(0, 2)]
      : [],
  ),
);
const valueFlags = [
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '-X',
  '--method',
  '--input',
  '-H',
  '--header',
  '--jq',
  '-q',
];
const methodFlag = args.findIndex((arg) => arg === '-X' || arg === '--method');
const method = methodFlag === -1 ? 'GET' : args[methodFlag + 1].toUpperCase();
const endpoint =
  args.find(
    (arg, index) => index > 0 && !arg.startsWith('-') && !valueFlags.includes(args[index - 1]),
  ) ?? '';
appendFileSync(
  process.env.FAKE_GH_LOG,
  `${JSON.stringify({ args, endpoint, fields, input, method })}\n`,
);

const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const pages = (value) => (args.includes('--slurp') ? [value] : value);
const reply = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};
const path = endpoint.split('?')[0];

if (endpoint === 'graphql') {
  const query = fields.query ?? JSON.parse(input || '{}').query ?? '';
  if (query.includes('viewerViewedState')) {
    reply({
      data: {
        repository: {
          pullRequest: {
            files: { nodes: [], pageInfo: { hasNextPage: false } },
            headRefOid: state.pullRequest.head.sha,
          },
        },
      },
    });
  }
  if (query.includes('reviewThreads')) {
    reply({
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
        },
      },
    });
  }
  reply({ data: {} });
}
if (method === 'POST' && path.endsWith('/reviews')) {
  reply({ id: 900, state: JSON.parse(input || '{}').event });
}
if (method === 'POST' && path.endsWith('/comments')) {
  reply({
    ...JSON.parse(input || '{}'),
    html_url: 'https://github.com/x',
    id: 901,
    user: { login: 'ada' },
  });
}
if (path.endsWith('/files')) {
  reply(pages(state.files));
}
if (path.endsWith('/comments')) {
  reply(pages(state.comments));
}
if (path.endsWith('/reviews')) {
  reply(pages([]));
}
if (path.endsWith('/commits')) {
  reply(pages(state.commits ?? []));
}
if (/\/pulls\/\d+$/.test(path)) {
  reply(state.pullRequest);
}
process.stderr.write(`fake gh: no route for ${method} ${endpoint}\n`);
process.exit(1);
