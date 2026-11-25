import { HISTORY_PAGE_SIZE } from '../../lib/app-constants.ts';
import { getHistorySource, getRefreshSource } from '../../lib/source.ts';
import type { HistoryEntry, ReviewSource } from '../../types.ts';
import { SnapshotStore } from './snapshot-store.ts';

type HistorySnapshot = {
  entries: ReadonlyArray<HistoryEntry>;
  hasMore: boolean;
  limit: number;
  loading: boolean;
  source: ReviewSource | null;
};

export class HistoryStore extends SnapshotStore<HistorySnapshot> {
  constructor() {
    super({ entries: [], hasMore: true, limit: HISTORY_PAGE_SIZE, loading: false, source: null });
  }

  private request = 0;
  invalidate = () => {
    this.request++;
    if (this.getSnapshot().loading) {
      this.publish({ loading: false });
    }
  };
  selectSource(source: ReviewSource) {
    const scope = getHistorySource(source);
    if (scope) {
      this.publish({ source: scope });
    }
  }
  private async load(limit: number, source: ReviewSource | null) {
    const request = ++this.request;
    this.publish({ loading: true });
    try {
      const { entries } = await window.codophon.getRepositoryHistory(limit, source ?? undefined);
      if (request === this.request) {
        this.publish({ entries, hasMore: entries.length >= limit, limit });
      }
    } catch {
      if (request === this.request) {
        this.publish({ hasMore: false });
      }
    } finally {
      if (request === this.request) {
        this.publish({ loading: false });
      }
    }
  }
  start(source: ReviewSource | null) {
    this.publish({ source });
    void this.load(HISTORY_PAGE_SIZE, source);
  }
  loadMore = () => {
    const { hasMore, limit, loading, source } = this.getSnapshot();
    if (!loading && hasMore) {
      void this.load(limit + HISTORY_PAGE_SIZE, source);
    }
  };
  // Refresh repository and history as one transaction. A failing history fetch
  // leaves the previously accepted diff and history together.
  async prepareRefresh(source: ReviewSource) {
    this.invalidate();
    const current = this.getSnapshot();
    const scope =
      source.type === 'pull-request'
        ? source
        : current.source
          ? getRefreshSource(current.source)
          : undefined;
    const { entries } = await window.codophon.getRepositoryHistory(current.limit, scope);
    return () => {
      this.invalidate();
      this.publish({
        entries,
        hasMore: entries.length >= current.limit,
        limit: current.limit,
        source: getHistorySource(source) ?? current.source,
      });
    };
  }
}
