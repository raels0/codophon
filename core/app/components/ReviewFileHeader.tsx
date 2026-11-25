import './ReviewFileHeader.css';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/PencilSimple';
import { type CodeViewItem } from '@pierre/diffs';
import { Copy as LucideCopy } from 'lucide-react';
import { useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { getShortcutLabel } from '../../config/keymap.ts';
import type { CodophonKeymap } from '../../config/types.ts';
import type {
  CodeViewItemMetadata,
  ReviewAnnotationMetadata,
  ReviewIdentity,
} from '../../lib/app-types.ts';
import { sectionLabel } from '../../lib/code-view-options.ts';
import { shouldLoadDiffSectionContents } from '../../lib/diff.ts';
import { isGeneratedWalkthroughFile } from '../../lib/narrative-walkthrough-diff.ts';
import type { ChangedFile, DiffSection } from '../../types.ts';
import { useCodeEditing } from '../hooks/useCodeEditing.ts';
import { Button } from './Button.tsx';
import { DiffLineCountBadge } from './DiffLineCountBadge.tsx';
import { useCopiedState } from './useCopiedState.ts';

function CopyFilePathButton({ path }: { path: string }) {
  const [copied, markCopied] = useCopiedState(1600);

  const handleClick = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        return;
      }
      markCopied();
    },
    [markCopied, path],
  );

  return (
    <button
      aria-label={copied ? 'Path copied' : 'Copy file path'}
      className={`codophon-copy-path-button${copied ? ' copied' : ''}`}
      onClick={(event) => void handleClick(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
      title={copied ? 'Path copied' : 'Copy file path'}
      type="button"
    >
      {copied ? (
        <Check aria-hidden className="codophon-copy-path-icon check" size={16} weight="bold" />
      ) : (
        <LucideCopy aria-hidden className="codophon-copy-path-icon" size={16} strokeWidth={2.25} />
      )}
    </button>
  );
}

export function FileEditButton({
  disabled,
  isBusy,
  item,
  keymap,
  meta,
  onEdit,
  onPrepare,
}: {
  disabled: boolean;
  isBusy: boolean;
  item: CodeViewItem<ReviewAnnotationMetadata>;
  keymap: CodophonKeymap;
  meta: CodeViewItemMetadata;
  onEdit: () => void;
  onPrepare?: ReturnType<typeof useCodeEditing>['prepareEdit'];
}) {
  const shortcut = getShortcutLabel(keymap, 'editFile');
  const prepare = () => {
    void onPrepare?.(item, meta).catch(() => {});
  };

  return (
    <Button
      aria-keyshortcuts={shortcut}
      aria-label={`Edit ${meta.file.path}`}
      className="codophon-edit-button"
      disabled={disabled || isBusy}
      onClick={onEdit}
      onFocus={prepare}
      onPointerEnter={prepare}
      title={`Edit this file in place (${shortcut}). Changes save to disk as you type.`}
      type="button"
    >
      <PencilSimple aria-hidden size={14} weight="bold" />
      Edit
    </Button>
  );
}

export function CodeViewHeader({
  canCreateFileComment,
  editActions,
  isEditing = false,
  isSectionLoading,
  meta,
  onCreateFileComment,
  onLoadSection,
  onOpenFile,
  onToggleCollapsed,
  onToggleMarkdownPreview,
  onToggleViewed,
}: {
  canCreateFileComment: boolean;
  editActions?: ReactNode;
  isEditing?: boolean;
  isSectionLoading: boolean;
  meta: CodeViewItemMetadata;
  onCreateFileComment: () => void;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onOpenFile?: (file: ChangedFile) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean, reviewKey: string) => void;
  onToggleMarkdownPreview: (file: ChangedFile, section: DiffSection) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => void;
}) {
  const {
    canRenderMarkdown,
    file,
    isCollapsed,
    isMarkdownPreview,
    isSelected,
    isViewed,
    lineCount,
    reviewIdentity,
    section,
    sectionCount,
    walkthroughNote,
  } = meta;
  const canOpenFile = file.status !== 'deleted';
  const canLoadSection = shouldLoadDiffSectionContents(section);
  const directoryEnd = file.path.lastIndexOf('/') + 1;

  return (
    <div
      className={`codophon-file-header${walkthroughNote ? ' with-note' : ''}${
        isCollapsed ? ' collapsed' : ''
      }${isSelected ? ' selected' : ''}${isViewed ? ' viewed' : ''}`}
    >
      <div
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
        className="codophon-header-toggle"
        onClick={() => onToggleCollapsed(file, isCollapsed, reviewIdentity.key)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapsed(file, isCollapsed, reviewIdentity.key);
          }
        }}
        role="button"
        tabIndex={0}
        title={isCollapsed ? 'Expand' : 'Collapse'}
      >
        <span className="codophon-chevron-box">
          <CaretDown
            aria-hidden
            className={isCollapsed ? 'codophon-chevron collapsed' : 'codophon-chevron'}
            size={16}
            weight="bold"
          />
        </span>
        <span className="codophon-file-heading">
          <span className="codophon-file-path-row">
            <span className="codophon-file-path" title={file.path}>
              {directoryEnd > 0 ? (
                <span className="codophon-file-directory">{file.path.slice(0, directoryEnd)}</span>
              ) : null}
              <span className="codophon-file-name">{file.path.slice(directoryEnd)}</span>
            </span>
            <CopyFilePathButton path={file.path} />
            {onOpenFile ? (
              <button
                aria-label={`Open ${file.path} in editor`}
                className="codophon-open-file-button"
                disabled={!canOpenFile}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenFile(file);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                  }
                }}
                title={canOpenFile ? 'Open file in editor' : 'Deleted files cannot be opened'}
                type="button"
              >
                <ArrowSquareOut aria-hidden size={16} weight="bold" />
              </button>
            ) : null}
          </span>
          {file.oldPath ? <span className="codophon-file-old-path">{file.oldPath}</span> : null}
          {walkthroughNote ? (
            <span className="codophon-file-note">{walkthroughNote.reason}</span>
          ) : null}
        </span>
      </div>
      <div className="codophon-file-details">
        <DiffLineCountBadge lineCount={lineCount} />
        {sectionCount > 1 ? (
          <span className={`codophon-section-badge ${section.kind}`}>
            {sectionLabel[section.kind]}
          </span>
        ) : null}
        {isGeneratedWalkthroughFile(file) ? (
          <span className="codophon-generated-badge" title="Generated file">
            Generated
          </span>
        ) : null}
        {canCreateFileComment ? (
          <Button
            className="codophon-file-comment-button"
            onClick={onCreateFileComment}
            title="Comment on file"
            type="button"
          >
            <ChatCircle
              aria-hidden
              className="codophon-file-comment-icon"
              size={14}
              weight="bold"
            />
            Comment
          </Button>
        ) : null}
        {canRenderMarkdown ? (
          <Button
            aria-pressed={isMarkdownPreview}
            className={`codophon-markdown-button${isMarkdownPreview ? ' active' : ''}`}
            disabled={isEditing && !isMarkdownPreview}
            onClick={() => onToggleMarkdownPreview(file, section)}
            title={isMarkdownPreview ? 'View as Diff' : 'View as Markdown'}
            type="button"
          >
            {isMarkdownPreview ? 'View as Diff' : 'View as Markdown'}
          </Button>
        ) : null}
        {editActions}
        {canLoadSection ? (
          <Button
            className="codophon-load-button"
            disabled={isSectionLoading}
            onClick={() => onLoadSection(file, section)}
            title={isSectionLoading ? 'Loading file contents' : 'Load file contents'}
            type="button"
            variant="outline"
          >
            {isSectionLoading ? 'Loading...' : 'Load'}
          </Button>
        ) : null}
        <Button
          aria-pressed={isViewed}
          className={`codophon-viewed-button${isViewed ? ' active' : ''}`}
          onClick={() => onToggleViewed(file, isViewed, reviewIdentity)}
          type="button"
          variant="outline"
        >
          <span aria-hidden className="codophon-viewed-checkbox">
            {isViewed ? <Check className="codophon-viewed-check" size={10} weight="bold" /> : null}
          </span>
          Viewed
        </Button>
      </div>
    </div>
  );
}
