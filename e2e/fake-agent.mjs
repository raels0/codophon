#!/usr/bin/env node
// Stands in for the Claude Code CLI in end-to-end tests. It records each call to
// $FAKE_AGENT_LOG and answers from the request's JSON schema, so Walkthrough and Ask run their
// real pipelines without a model or network.
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.0.0 (Claude Code)\n');
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const schema = JSON.parse(args[args.indexOf('--json-schema') + 1] ?? '{}');
appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ args, prompt })}\n`);

const answer = schema.properties?.chapters
  ? {
      chapters: [
        {
          blurb: 'Adds subtraction next to addition.',
          icon: 'wrench',
          id: 'c1',
          stops: [
            {
              hunkIds: [...prompt.matchAll(/"id":"(h\d+)"/g)].map((match) => match[1]),
              id: 's1',
              importance: 'normal',
              prose: 'The new sub helper mirrors add.',
              title: 'A sub helper',
            },
          ],
          title: 'Math helpers',
        },
      ],
      commit: { body: 'Adds sub next to add.', title: 'Add subtraction helper' },
      designOverview: {
        after: 'Callers can subtract.',
        before: 'Only addition existed.',
        diagram: { mermaid: 'flowchart LR\n  Review --> Merge', title: 'Review flow' },
        goal: 'Support subtraction.',
        goalSource: 'inferred',
        implementation: [...prompt.matchAll(/"id":"(h\d+)"/g)].slice(0, 1).map((match) => ({
          description: 'Adds sub.',
          hunkId: match[1],
          title: 'sub',
        })),
      },
      focus: 'math helpers',
      kind: 'feature',
      title: 'Add subtraction',
      version: 1,
    }
  : schema.properties?.reply
    ? {
        reply: prompt.includes('What about Infinity?')
          ? 'Infinity minus Infinity is NaN too.'
          : 'Yes: NaN propagates through subtraction.',
        requests: [],
        version: 1,
      }
    : {};

const envelope = { is_error: false, result: '', structured_output: answer, type: 'result' };
process.stdout.write(`${JSON.stringify(envelope)}\n`);
