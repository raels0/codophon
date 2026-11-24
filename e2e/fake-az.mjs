#!/usr/bin/env node
// Stands in for `az rest` in end-to-end tests. Serves the pull request described by
// $FAKE_AZ_STATE and records every call (with its body) to $FAKE_AZ_LOG.
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const uri = option('--uri');
const method = (option('--method') || 'GET').toUpperCase();
const rawBody = option('--body');
const body = rawBody.startsWith('@') ? readFileSync(rawBody.slice(1), 'utf8') : rawBody;
appendFileSync(process.env.FAKE_AZ_LOG, `${JSON.stringify({ body, method, uri })}\n`);

const state = JSON.parse(readFileSync(process.env.FAKE_AZ_STATE, 'utf8'));
const me = { displayName: 'Ada', id: 'user-1', uniqueName: 'ada@example.com' };
const path = new URL(uri).pathname;
const reply = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};

if (path.endsWith('/connectionData')) {
  reply({ authenticatedUser: me });
}
if (method === 'PUT' && path.includes('/reviewers/')) {
  reply({ id: me.id, vote: JSON.parse(body).vote });
}
if (method === 'POST' && /\/threads\/\d+\/comments$/.test(path)) {
  reply({
    author: me,
    commentType: 1,
    content: JSON.parse(body).content,
    id: 2,
    publishedDate: '2026-01-02T00:00:00Z',
  });
}
if (method === 'POST' && path.endsWith('/threads')) {
  const thread = JSON.parse(body);
  reply({ ...thread, comments: [{ ...thread.comments[0], author: me, id: 1 }], id: 99 });
}
if (path.endsWith('/threads')) {
  reply({ value: state.threads });
}
if (/\/pullRequests\/\d+$/.test(path)) {
  reply(state.pullRequest);
}
process.stderr.write(`fake az: no route for ${method} ${uri}\n`);
process.exit(1);
