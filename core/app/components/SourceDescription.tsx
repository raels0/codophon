import './SourceDescription.css';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { sanitizeMarkdownImages } from '../../lib/markdown.tsx';
import type { CommitMetadata, ReviewAuthor, ReviewSource } from '../../types.ts';
import { Avatar } from './Avatar.tsx';
import { ReadOnlyMarkdown } from './ReviewMarkdown.tsx';

const getPullRequestDescriptionLabel = (source: Extract<ReviewSource, { type: 'pull-request' }>) =>
  source.provider === 'github' || source.provider === 'azure-devops'
    ? 'PR description'
    : 'Description';
type SourceDescriptionAuthor = {
  avatarUrl?: string;
  displayName: string;
  title?: string;
};
const getPullRequestDescriptionAuthor = (author: ReviewAuthor): SourceDescriptionAuthor => ({
  avatarUrl: author.avatarUrl,
  displayName: author.name || `@${author.login}`,
  title: `@${author.login}`,
});
const getCommitDescriptionAuthor = (author: CommitMetadata['author']): SourceDescriptionAuthor => ({
  avatarUrl: author.gravatarUrl,
  displayName: author.name || author.email || 'Unknown author',
  title: author.email || undefined,
});
const htmlCommentPattern = /<!--[\s\S]*?-->/g;
const stripHtmlComments = (value: string) => value.replaceAll(htmlCommentPattern, '');

// The PR description is a file-style card matching commit details: the title lives in the
// card header and the description is the collapsible body.
function SourceDescriptionHeader({
  actions,
  canCollapse,
  isCollapsed,
  label,
  onToggleCollapsed,
  title,
}: {
  actions?: ReactNode;
  canCollapse: boolean;
  isCollapsed: boolean;
  label: string;
  onToggleCollapsed: () => void;
  title: string;
}) {
  const heading = (
    <span className="codophon-file-heading">
      <span className="codophon-file-path-row">
        <span className={`codophon-file-path${title ? ' source-description-title' : ''}`}>
          {title || label}
        </span>
      </span>
    </span>
  );

  return (
    <div
      className={`codophon-file-header codophon-source-description-header${
        isCollapsed ? ' collapsed' : ''
      }`}
    >
      {canCollapse ? (
        <button
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? 'Expand description' : 'Collapse description'}
          className="codophon-header-toggle"
          onClick={onToggleCollapsed}
          title={isCollapsed ? 'Expand' : 'Collapse'}
          type="button"
        >
          <span className="codophon-chevron-box">
            <CaretDown
              aria-hidden
              className={isCollapsed ? 'codophon-chevron collapsed' : 'codophon-chevron'}
              size={16}
              weight="bold"
            />
          </span>
          {heading}
        </button>
      ) : (
        <div className="codophon-header-toggle codophon-header-toggle-static">{heading}</div>
      )}
      {actions}
    </div>
  );
}

function SourceDescriptionBody({
  ariaLabel = 'Preview source description',
  author,
  description,
}: {
  ariaLabel?: string;
  author?: SourceDescriptionAuthor;
  description: string;
}) {
  const sanitizedDescription = useMemo(
    () => sanitizeMarkdownImages(stripHtmlComments(description)),
    [description],
  );

  return (
    <div
      className={`source-description-comment review-comment${
        author ? '' : ' source-description-comment-anonymous'
      }`}
    >
      {author ? <Avatar name={author.displayName} size="medium" url={author.avatarUrl} /> : null}
      <div className="review-comment-body source-description-body">
        {author ? (
          <div
            className={`review-comment-header read-only source-description-author-header${
              sanitizedDescription ? '' : ' without-description'
            }`}
          >
            <strong title={author.title}>{author.displayName}</strong>
          </div>
        ) : null}
        {sanitizedDescription ? (
          <div className="codophon-markdown-preview source-description-markdown">
            <ReadOnlyMarkdown
              ariaLabel={ariaLabel}
              className="codophon-markdown-preview-editor source-description-markdown-editor"
              density="compact"
              value={sanitizedDescription}
              variant="embedded"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function getSourceDescription(
  source: ReviewSource,
  commitMetadata: CommitMetadata | null,
  showSourceDescription: boolean,
) {
  const commitMessageMetadata = source.type === 'commit' ? commitMetadata : null;
  const shouldShowCommitMessage = commitMessageMetadata != null;
  const shouldShowSourceDescription = showSourceDescription && source.type === 'pull-request';
  const sourceDescription = shouldShowCommitMessage
    ? commitMessageMetadata.body.trim()
    : shouldShowSourceDescription
      ? (source.description?.trim() ?? '')
      : '';
  const sourceDescriptionHasBody = sourceDescription.length > 0;
  const sourceDescriptionHasContent = sourceDescriptionHasBody || shouldShowCommitMessage;
  const sourceAuthor = shouldShowCommitMessage
    ? getCommitDescriptionAuthor(commitMessageMetadata.author)
    : shouldShowSourceDescription && source.author
      ? getPullRequestDescriptionAuthor(source.author)
      : undefined;
  const sourceTitle = shouldShowCommitMessage
    ? commitMessageMetadata.subject.trim() || commitMessageMetadata.shortRef
    : shouldShowSourceDescription
      ? (source.title?.trim() ?? '')
      : '';
  const sourceDescriptionItemId =
    shouldShowCommitMessage && source.type === 'commit'
      ? `commit-message:${source.ref}`
      : shouldShowSourceDescription && (sourceDescription || sourceTitle)
        ? `source-description:${source.provider ?? ''}:${source.url}`
        : null;
  const sourceDescriptionLabel = shouldShowCommitMessage
    ? 'Commit'
    : source.type === 'pull-request'
      ? getPullRequestDescriptionLabel(source)
      : '';
  const sourceDescriptionAriaLabel = shouldShowCommitMessage
    ? 'Preview commit message'
    : 'Preview source description';
  return sourceDescriptionItemId
    ? {
        sourceAuthor,
        sourceDescription,
        sourceDescriptionAriaLabel,
        sourceDescriptionHasContent,
        sourceDescriptionItemId,
        sourceDescriptionLabel,
        sourceTitle,
      }
    : null;
}
export function SourceDescription({
  actions: sourceDescriptionActions,
  details,
  footer: sourceDescriptionFooter,
}: {
  actions?: ReactNode;
  details: NonNullable<ReturnType<typeof getSourceDescription>>;
  footer?: ReactNode;
}) {
  const {
    sourceAuthor,
    sourceDescription,
    sourceDescriptionAriaLabel,
    sourceDescriptionHasContent,
    sourceDescriptionItemId,
    sourceDescriptionLabel,
    sourceTitle,
  } = details;
  const [collapsedSourceDescriptionItemId, setCollapsedSourceDescriptionItemId] = useState<
    string | null
  >(null);
  const sourceDescriptionCollapsed =
    !sourceDescriptionHasContent || collapsedSourceDescriptionItemId === sourceDescriptionItemId;
  const toggleSourceDescriptionCollapsed = useCallback(() => {
    setCollapsedSourceDescriptionItemId((current) =>
      current === sourceDescriptionItemId ? null : sourceDescriptionItemId,
    );
  }, [sourceDescriptionItemId]);
  return (
    <div className="codophon-source-description-panel codophon-code-view-source-description">
      <SourceDescriptionHeader
        actions={sourceDescriptionActions}
        canCollapse={sourceDescription.length > 0}
        isCollapsed={sourceDescriptionCollapsed}
        label={sourceDescriptionLabel}
        onToggleCollapsed={toggleSourceDescriptionCollapsed}
        title={sourceTitle}
      />
      {!sourceDescriptionCollapsed && sourceDescriptionHasContent ? (
        <div className="codophon-source-description-panel-body">
          <SourceDescriptionBody
            ariaLabel={sourceDescriptionAriaLabel}
            author={sourceAuthor}
            description={sourceDescription}
          />
          {sourceDescriptionFooter ? (
            <div className="codophon-source-description-footer">{sourceDescriptionFooter}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
