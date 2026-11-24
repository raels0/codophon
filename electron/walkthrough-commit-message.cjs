// @ts-check

const { getAgentPrompt } = require('./agent-prompts.cjs');

// Ask the connected agent to rewrite a walkthrough's commit message for the
// reviewer's CURRENT file selection. The walkthrough ships a pre-drafted body
// describing the whole change; when the reviewer drops files from the staging
// set, that prose no longer matches what is being committed, so this asks the
// agent (running in the repo root, with real diff access) to revise it.

const { parseJSONMessage, truncate } = require('./agent-shared.cjs');

const MAX_OTHER_FILES = 60;

/**
 * @typedef {import('../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').WalkthroughCommitMessageRequest} WalkthroughCommitMessageRequest
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

const commitMessageSchema = {
  additionalProperties: false,
  properties: {
    body: { type: 'string' },
    subject: { type: 'string' },
    version: { const: 1, type: 'number' },
  },
  required: ['version', 'subject', 'body'],
  type: 'object',
};

/** @param {ChangedFile} file */
const getFileDigest = (file) => ({
  oldPath: file.oldPath,
  path: file.path,
  status: file.status,
  summaries: file.sections
    .map((section) => section.summary?.reason)
    .filter((summary) => typeof summary === 'string' && summary.trim()),
});

/** @param {RepositoryState} state @param {Partial<WalkthroughCommitMessageRequest> | null | undefined} request */
const buildCommitMessageInput = (state, request) => {
  const paths = new Set(Array.isArray(request?.paths) ? request.paths.map(String) : []);
  return {
    currentMessage: {
      body: typeof request?.body === 'string' ? request.body : '',
      subject: typeof request?.subject === 'string' ? request.subject : '',
    },
    droppedFiles: state.files
      .filter((file) => !paths.has(file.path))
      .slice(0, MAX_OTHER_FILES)
      .map(getFileDigest),
    root: state.root,
    selectedFiles: state.files.filter((file) => paths.has(file.path)).map(getFileDigest),
    source: state.source,
  };
};

/** @param {RepositoryState} state @param {Partial<WalkthroughCommitMessageRequest> | null | undefined} request @param {string} [agentLabel] @param {import('../core/config/types.ts').AgentPromptOverrides} [prompts] */
const buildCommitMessagePrompt = (
  state,
  request,
  agentLabel = 'Codex',
  prompts,
) => `You are ${agentLabel} inside Codophon, helping a reviewer write a git commit message.

The reviewer is committing only a SUBSET of the working tree — the files listed under "selectedFiles" below. They started from a drafted commit message that described the whole change, then narrowed the selection, so the message may now over- or under-describe what is actually being committed.

Rewrite the message so it describes exactly the change represented by the selected files.

Your job:
- Read the real diff for the selected files in ${state.root} — run \`git diff -- <paths>\` and \`git diff --staged -- <paths>\` for the selectedFiles paths. Use what you read, not just the digest.
- Return an updated \`subject\` and \`body\`.
- Do not mention or describe any file under "droppedFiles" — they are NOT in this commit.
- Do not invent changes, requirements, or files outside the selected set.

Commit message writing guidance:
${getAgentPrompt('commitMessage', prompts)}

Repository change digest:
${JSON.stringify(buildCommitMessageInput(state, request), null, 2)}
`;

/** @param {unknown} value @param {string} [fallback] */
const cleanText = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\n{3,}/g, '\n\n').trim();

/** @param {unknown} input */
const normalizeCommitMessageReply = (input) => {
  const object =
    input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  return {
    body: cleanText(object.body),
    subject: cleanText(object.subject).split('\n')[0],
  };
};

/**
 * @param {RepositoryState} state
 * @param {WalkthroughCommitMessageRequest} request
 * @param {Agent} agent
 * @param {AgentOptions} agentOptions
 * @param {import('../core/config/types.ts').AgentPromptOverrides} [prompts]
 */
const readCommitMessageReply = async (state, request, agent, agentOptions, prompts) => {
  try {
    const response = await agent.run(
      state.root,
      buildCommitMessagePrompt(state, request, agent.label, prompts),
      commitMessageSchema,
      'walkthrough-commit-message.json',
      `${agent.label} commit-message rewrite timed out.`,
      agentOptions,
    );
    const { body, subject } = normalizeCommitMessageReply(parseJSONMessage(response));
    if (!subject && !body) {
      return {
        reason: `${agent.label} could not produce a commit message.`,
        status: 'unavailable',
      };
    }
    return { body, status: 'ready', subject };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

module.exports = { readCommitMessageReply };
