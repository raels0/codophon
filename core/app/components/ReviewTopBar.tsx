import './ReviewTopBar.css';
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/SidebarSimple';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { ReviewModeControl, type ReviewModeItem } from './ReviewModeControl.tsx';

export function ReviewTopBar<Mode extends string>({
  actions,
  context,
  mode,
  modes,
  onModeChange,
  onToggleSidebar,
  repository,
  repositoryTooltip,
  sidebarCollapsed,
  sidebarPosition = 'left',
  sourceMenu,
  toggleTitle,
}: {
  actions?: ReactNode;
  context?: ReactNode;
  mode: Mode;
  modes: ReadonlyArray<ReviewModeItem<Mode>>;
  onModeChange: (mode: Mode) => void;
  onToggleSidebar: () => void;
  repository: ReactNode;
  repositoryTooltip?: string;
  sidebarCollapsed: boolean;
  sidebarPosition?: 'left' | 'right';
  sourceMenu?: ReactNode;
  toggleTitle: string;
}) {
  const sidebarToggle = (
    <Button
      aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="review-top-bar-icon-button sidebar-toggle-button"
      onClick={onToggleSidebar}
      size="icon"
      title={toggleTitle}
      type="button"
      variant="ghost"
    >
      <SidebarSimple aria-hidden mirrored={sidebarPosition === 'right'} size={18} weight="bold" />
    </Button>
  );

  return (
    <header className="review-top-bar workspace-top-bar">
      <div className="review-top-bar-left">
        {sidebarPosition === 'left' ? sidebarToggle : null}
        {sourceMenu}
        <div className="review-top-bar-repository-slot" title={repositoryTooltip}>
          {repository}
        </div>
      </div>
      <ReviewModeControl mode={mode} modes={modes} onModeChange={onModeChange} />
      <div className="review-top-bar-right">
        {context ? <div className="review-top-bar-context">{context}</div> : null}
        {actions ? <div className="review-top-bar-actions">{actions}</div> : null}
        {sidebarPosition === 'right' ? sidebarToggle : null}
      </div>
    </header>
  );
}
