import { basename } from 'node:path';
import { parseReviewUrl } from './review-source.ts';

export type WindowRepositoryState = Pick<
  import('../core/types.ts').RepositoryState,
  'root' | 'source'
>;
export type WindowTitleTarget = { isDestroyed: () => boolean; setTitle: (title: string) => void };

const getWindowSourceTitle = (source: import('../core/types.ts').ReviewSource) =>
  source.type === 'working-tree'
    ? null
    : source.type === 'pull-request'
      ? String(source.number ?? parseReviewUrl(source.url)?.number ?? 'PR')
      : source.type === 'commit'
        ? source.ref.slice(0, 7)
        : source.type === 'range'
          ? `${source.base}${source.symmetric ? '...' : '..'}${source.head}`
          : source.ref;

const getCodophonWindowTitle = (title: string) => `${title} · Codophon`;

const getRepositoryWindowTitle = (state: WindowRepositoryState) => {
  // Use the resolved source so aliases such as HEAD and a PR URL become the view the user opened.
  const sourceTitle = getWindowSourceTitle(state.source);
  return getCodophonWindowTitle(`${basename(state.root)}${sourceTitle ? `/${sourceTitle}` : ''}`);
};

const restoreRepositoryWindowTitleAfterLoad = async (
  target: WindowTitleTarget,
  initialRepositoryState: Promise<WindowRepositoryState> | null | undefined,
) => {
  if (!initialRepositoryState) {
    return;
  }
  const state = await initialRepositoryState;
  if (!target.isDestroyed()) {
    target.setTitle(getRepositoryWindowTitle(state));
  }
};

export { getRepositoryWindowTitle, restoreRepositoryWindowTitleAfterLoad };
