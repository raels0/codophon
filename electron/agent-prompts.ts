import type { AgentPromptId, AgentPromptOverrides } from '../core/config/types.ts';

const agentPrompts: Array<import('../core/config/types.ts').AgentPromptModule> = [
  { id: 'walkthrough', label: 'Additional walkthrough guidance', text: '' },
  {
    id: 'walkthroughSummary',
    label: 'Walkthrough summary',
    text: `Write the walkthrough title, focus, and chapter blurbs for a reviewer who knows the product but not this subsystem. Name the change and explain what to verify. Summarize behavior, not a list of files. Use the highest-leverage review path and group hunks that explain the same idea. Prefer conceptual chapters over chapters organized by file.`,
  },
  {
    id: 'walkthroughDesign',
    label: 'Walkthrough design overview',
    text: `Give a one-minute orientation: state what the PR is trying to achieve, explain what happened before, and describe what the implementation does now. Explain the main mechanisms in the order they happen or build on each other: which component does what, what triggers it, and what result it produces. Mention important fallbacks or retained behavior when they help explain the change.
- If a diagram helps, scope it to one changed flow. Use sequenceDiagram for handoffs, flowchart for routing, or stateDiagram-v2 for lifecycle changes. Label the old/new paths or show the fallback if it matters. Skip diagrams for mechanical changes or when a sentence is clearer.
- Describe the implementation as written. Save review questions, recommendations, and judgments for the review stops.`,
  },
  {
    id: 'walkthroughTitles',
    label: 'Walkthrough chapter and stop titles',
    text: `Chapter titles appear in the compact top bar. Name the feature, flow, or review topic that ties the stops together, e.g. "Draft recovery" or "Retry limits" instead of "Runtime" or "Implementation".
- Write each stop title after drafting its prose. Name the specific thing that changes and what changes about it: a behavior, rule, or outcome. Include the trigger or scope if the title would be ambiguous without it. Never use a filename or path as a stop title.
- Read the titles on their own, as if scanning the sidebar without the prose. Use enough words to be clear. Prefer "Set retry attempt and time limits" to "Bound follow-up work", or "Reject expired invite links" to "Tighten validation". If the diff only defines settings, say "Set" or "Configure"; don't claim enforcement the diff doesn't show.`,
  },
  {
    id: 'walkthroughStops',
    label: 'Walkthrough stop explanations',
    text: `Write for a developer who knows the product but not this subsystem. In the first sentence, say what the reviewer is checking and name the feature or flow, not a chain of classes. Explain any unavoidable project term by what it does the first time you use it.
- Put concrete inputs and expected results before code pointers. Say what happens on the normal path and what changes when a setting is enabled, input is invalid, or recovery fails, if those cases matter here. For independent switches, explain what each controls and what happens when only one is on. Keep the actual behavior precise: say which implementation runs, what it receives, or what isn't created when the distinction matters.
- Use exact identifiers for settings the reviewer must change and code they need to find. Otherwise prefer the role ("loads the templates") to the class name. End with one useful starting point; add a second pointer only when needed to verify the result. Do not list every helper, field, or exception the call passes through. If an excerpt cuts off the deciding code, pose a concrete question at that point rather than describing the excerpt or claiming an outcome.
- Use short sentences with one main idea each, not Markdown headings, lists, or tables. Example: "Check which sender handles invoice email. Selecting the invoice template opts the message in. If the new sender is off, the existing sender still gets that template and the new sender is never created. If both switches are on, the new sender handles the same message. Start at \`SelectInvoiceSender\`."`,
  },
  {
    id: 'walkthroughRevision',
    label: 'Walkthrough regeneration',
    text: `Keep accurate review ideas and preserve clear, still-accurate prose. Rewrite titles that do not make sense on their own, even if the underlying code and prose have not changed. Apply the title and stop-writing rules above. Add new review ideas and remove ideas whose code is gone.`,
  },
  {
    id: 'commitMessage',
    label: 'Commit message drafting and rewrite',
    text: `Write a subject in the imperative mood, under 72 characters, and a body of one to three short paragraphs. Describe the change as a whole and why it is made. Do not enumerate files or write a bullet list. Avoid hedging; state what the change does.`,
  },
  {
    id: 'ask',
    label: 'Ask response',
    text: `Answer the reviewer's question. The selected file and lines tell you where the question started; they do not limit which parts of the review you should consider. Look at related changes in other files before drawing a conclusion.

For a follow-up question, use the earlier conversation to understand references such as "that" or "your suggestion." Answer the latest question without starting over. Earlier answers are not proof: check the relevant code again when needed, and correct an earlier answer if the code does not support it.

Explain your reasoning in plain English. Cite file paths and line numbers when they support the answer. Be concise, but take the space needed to explain a cross-file change clearly. Only suggest wording for a review comment if asked.`,
  },
];

const MAX_AGENT_PROMPT_LENGTH = 16_000;

const normalizeAgentPrompts = (value: unknown): AgentPromptOverrides => {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(
    agentPrompts.flatMap(({ id, text }) => {
      const override = Object.hasOwn(raw, id) && typeof raw[id] === 'string' ? raw[id].trim() : '';
      return override && override !== text && override.length <= MAX_AGENT_PROMPT_LENGTH
        ? [[id, override]]
        : [];
    }),
  );
};

const getAgentPrompt = (id: AgentPromptId, overrides?: AgentPromptOverrides) =>
  overrides?.[id] ?? agentPrompts.find((prompt) => prompt.id === id)?.text ?? '';

export { MAX_AGENT_PROMPT_LENGTH, agentPrompts, getAgentPrompt, normalizeAgentPrompts };
