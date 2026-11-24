import { lazy, Suspense } from 'react';
import type { WalkthroughDesignOverview } from '../../../types.ts';

const MermaidDiagramBlock = lazy(() =>
  import('../MermaidCodeBlock.tsx').then(({ MermaidDiagramBlock }) => ({
    default: MermaidDiagramBlock,
  })),
);

export function DesignOverview({
  canOpenEvidence,
  onOpenEvidence,
  overview,
}: {
  canOpenEvidence: (hunkId: string) => boolean;
  onOpenEvidence: (hunkId: string) => void;
  overview: WalkthroughDesignOverview;
}) {
  return (
    <section aria-label="Design overview" className="wt-design-overview">
      <h2 className="wt-stage-title">Design overview</h2>
      <dl className="wt-design-behavior">
        <dt>{overview.goalSource === 'stated' ? 'Stated goal' : 'Inferred goal'}</dt>
        <dd>{overview.goal}</dd>
        <dt>Before</dt>
        <dd>{overview.before}</dd>
        <dt>After</dt>
        <dd>{overview.after}</dd>
        {overview.unchanged ? (
          <>
            <dt>Unchanged</dt>
            <dd>{overview.unchanged}</dd>
          </>
        ) : null}
      </dl>
      {overview.partialEvidence ? (
        <p className="wt-design-evidence-note">
          This overview is based on the available portions of the diff.
        </p>
      ) : null}
      {overview.diagram ? (
        <figure className="wt-design-diagram">
          <figcaption>{overview.diagram.title}</figcaption>
          <Suspense fallback={<p role="status">Loading diagram…</p>}>
            <MermaidDiagramBlock code={overview.diagram.mermaid} />
          </Suspense>
        </figure>
      ) : null}
      {overview.implementation.length > 0 ? (
        <>
          <h3>How it works</h3>
          <ol className="wt-design-implementation">
            {overview.implementation.map(({ description, hunkId, title }) => (
              <li key={title}>
                <strong>{title}</strong>
                <p>{description}</p>
                {canOpenEvidence(hunkId) ? (
                  <button
                    className="wt-design-link"
                    onClick={() => onOpenEvidence(hunkId)}
                    type="button"
                  >
                    View implementation
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
