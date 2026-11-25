import { readFile } from 'node:fs/promises';
import type { AgentPromptOverrides } from '../core/config/types.ts';
import type {
  CodophonLaunchOptions,
  NarrativeWalkthrough,
  NarrativeWalkthroughRequestOptions,
  NarrativeWalkthroughResult,
  RepositoryState,
  WalkthroughContext,
} from '../core/types.ts';
import type { Agent, AgentOptions } from './agent.ts';
import {
  assertWalkthroughHunkIdsResolve,
  getNarrativeWalkthroughCacheKey,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} from './narrative-walkthrough.ts';
import { mergeWalkthroughContexts } from './walkthrough-context.ts';
import { diagnoseWalkthroughMismatch } from './walkthrough-diagnosis.ts';
import { readStoredWalkthrough, writeStoredWalkthrough } from './walkthrough-store.ts';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function applyWalkthroughFile(
  path: string,
  state: RepositoryState,
  agent: Agent,
  context: WalkthroughContext | null,
): Promise<NarrativeWalkthroughResult> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `Could not read walkthrough file: ${errorMessage(error)}`,
    };
  }
  try {
    assertWalkthroughHunkIdsResolve(input, state.files);
    return {
      status: 'ready',
      walkthrough: normalizeNarrativeWalkthrough(input, state.files, {
        agent: agent.id,
        branch: state.branch,
        context: context ?? undefined,
        generatedAt: state.generatedAt,
        root: state.root,
        source: state.source,
      }),
    };
  } catch (error) {
    const diagnosis = await diagnoseWalkthroughMismatch({
      hasFiles: state.files.length > 0,
      input,
      repositoryRoot: state.root,
    }).catch(() => null);
    return {
      status: 'unavailable',
      reason:
        diagnosis || `Walkthrough file could not be applied to this diff: ${errorMessage(error)}`,
    };
  }
}

export async function loadWalkthrough({
  agent,
  agentOptions,
  initial,
  launch,
  options,
  prompts,
  customPrompt,
  readState,
}: {
  agent: Agent;
  agentOptions: AgentOptions;
  initial?: NarrativeWalkthrough;
  launch: CodophonLaunchOptions;
  options?: NarrativeWalkthroughRequestOptions;
  prompts: AgentPromptOverrides;
  customPrompt?: string;
  readState: () => Promise<RepositoryState>;
}): Promise<NarrativeWalkthroughResult> {
  try {
    const readContext = async () =>
      agent.readSessionContext(
        launch.agentSessions?.find((session) => session.agent === agent.id)?.id,
      );
    if (initial) {
      const context = await readContext().catch(() => null);
      return {
        status: 'ready',
        walkthrough: { ...initial, agent: agent.id, ...(context ? { context } : {}) },
      };
    }
    const state = await readState();
    if (launch.walkthroughFile) {
      return await applyWalkthroughFile(
        launch.walkthroughFile,
        state,
        agent,
        await readContext().catch(() => null),
      );
    }

    const context = mergeWalkthroughContexts(launch.walkthroughContext, await readContext());
    const model = resolveNarrativeWalkthroughModel(
      state,
      agent,
      agentOptions.model,
      agentOptions.reasoningEffort,
    );
    const cacheKeyFor = (modelUsed: string) =>
      getNarrativeWalkthroughCacheKey(
        state,
        agent,
        modelUsed,
        context,
        customPrompt,
        agentOptions.reasoningEffort,
        prompts,
      );
    const cacheKey = cacheKeyFor(model);
    const cached = !options?.force && readStoredWalkthrough(cacheKey);
    if (cached) {
      return {
        status: 'ready',
        walkthrough: {
          ...cached,
          ...(context ? { context } : {}),
          agent: agent.id,
          repo: { branch: state.branch, root: state.root },
          source: state.source,
        },
      };
    }

    let generatedModel = model;
    const result = await readNarrativeWalkthrough(
      state,
      agent,
      {
        ...agentOptions,
        model,
        onModelFallback: async (fallback, original) => {
          generatedModel = fallback;
          await agentOptions.onModelFallback?.(fallback, original);
        },
      },
      context,
      customPrompt,
      options?.previousWalkthrough,
      prompts,
    );
    if (result.status === 'ready') {
      try {
        const { context: _context, ...walkthrough } = result.walkthrough;
        writeStoredWalkthrough(
          generatedModel === model ? cacheKey : cacheKeyFor(generatedModel),
          walkthrough,
        );
      } catch {
        // A cache failure must not hide a generated result.
      }
    }
    return result;
  } catch (error) {
    return { reason: errorMessage(error), status: 'unavailable' };
  }
}
