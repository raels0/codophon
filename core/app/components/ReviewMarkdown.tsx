import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { preloadMarkdownEditor } from './LazyMarkdownEditor.tsx';
import { MarkdownDiffView } from './MarkdownDiffView.tsx';
import type { MarkdownDocumentEditorHandle } from './MarkdownDocumentEditor.tsx';

let markdownPreviewModule: Promise<typeof import('./MarkdownPreviewDocument.tsx')> | undefined;
const loadMarkdownPreview = () =>
  (markdownPreviewModule ??= import('./MarkdownPreviewDocument.tsx'));
export const preloadReviewMarkdown = () =>
  Promise.all([loadMarkdownPreview(), preloadMarkdownEditor()]);
const PreviewDocument = lazy(loadMarkdownPreview);
export function ReadOnlyMarkdown(props: ComponentProps<typeof PreviewDocument>) {
  return (
    <Suspense fallback={<div className="codophon-readonly-markdown-loading">Loading…</div>}>
      <PreviewDocument {...props} />
    </Suspense>
  );
}
const RepositoryMarkdownEditor = lazy(async () => ({
  default: (await import('./MarkdownDocumentEditor.tsx')).RepositoryMarkdownEditor,
}));

export function MarkdownPreview({
  cacheKey,
  contents,
  editing,
  heightCache,
  itemId,
  oldContents,
  onEditorRef,
  onLayoutReady,
  onViewSource,
  path,
  sectionId,
}: {
  cacheKey: string;
  contents: string;
  editing: boolean;
  heightCache: Map<string, number>;
  itemId: string;
  oldContents?: string;
  onEditorRef: (sectionId: string, editor: MarkdownDocumentEditorHandle | null) => void;
  onLayoutReady: (sectionId: string) => void;
  onViewSource: (lineNumber: number, side: 'additions' | 'deletions') => void;
  path: string;
  sectionId: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const measure = useCallback(
    (reportedHeight?: number) => {
      const content = contentRef.current;
      if (
        !content?.isConnected ||
        content.querySelector(
          '.codophon-markdown-editor-message:not(.error), .codophon-readonly-markdown-loading',
        )
      ) {
        return;
      }
      // Measure the unconstrained content, so edits and width changes can shrink
      // the document as well as grow it. Child reports also cover lazy editors.
      const height = content.getBoundingClientRect().height || reportedHeight;
      if (height == null || height <= 0) {
        return;
      }
      setReady(true);
      if (heightCache.get(cacheKey) !== height) {
        heightCache.set(cacheKey, height);
        onLayoutReady(sectionId);
      }
    },
    [cacheKey, heightCache, onLayoutReady, sectionId],
  );

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [measure]);

  return (
    // Keep the last document height while a recycled editor reloads. Measuring
    // its small loading placeholder would move every following item upward.
    <div
      data-codophon-markdown-item={itemId}
      style={{ minHeight: ready ? undefined : heightCache.get(cacheKey) }}
    >
      <div className={`codophon-markdown-preview${editing ? ' editable' : ''}`} ref={contentRef}>
        <Suspense fallback={<div className="codophon-markdown-editor-message">Loading…</div>}>
          {editing ? (
            <RepositoryMarkdownEditor
              onHeightChange={measure}
              path={path}
              ref={(editor) => onEditorRef(sectionId, editor)}
            />
          ) : oldContents != null ? (
            <MarkdownDiffView
              newContents={contents}
              oldContents={oldContents}
              onViewSource={onViewSource}
              path={path}
            />
          ) : (
            <ReadOnlyMarkdown
              ariaLabel={`Preview ${path}`}
              className="codophon-markdown-preview-editor"
              onHeightChange={measure}
              value={contents}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
