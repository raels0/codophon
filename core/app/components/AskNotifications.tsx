import './ReviewDialogs.css';
import { ArrowUpRightIcon as ArrowUpRight } from '@phosphor-icons/react/ArrowUpRight';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/WarningCircle';
import { useEffect, useState } from 'react';
import type { AskNotification } from '../hooks/useAppReviewComments.ts';

function AskNotice({
  notification,
  onDismiss,
  onNavigate,
}: {
  notification: AskNotification;
  onDismiss: (id: string) => void;
  onNavigate: (notification: AskNotification) => void;
}) {
  const { filePath, id, lineNumber, question, status } = notification;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) {
      return;
    }
    const timeout = setTimeout(() => onDismiss(id), 8000);
    return () => clearTimeout(timeout);
  }, [focused, hovered, id, onDismiss]);

  const location = `${filePath}${lineNumber == null ? '' : `:${lineNumber}`}`;
  const preview = question.trim().replaceAll(/\s+/g, ' ');
  const Icon = status === 'ready' ? CheckCircle : WarningCircle;
  return (
    <button
      className="ask-notice"
      data-status={status}
      onBlur={() => setFocused(false)}
      onClick={() => {
        onNavigate(notification);
        onDismiss(id);
      }}
      onFocus={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`Jump to ${location}`}
      type="button"
    >
      <Icon aria-hidden="true" size={16} />
      <span className="ask-notice-content">
        <span className="ask-notice-heading">
          <strong>{status === 'ready' ? 'Ask reply ready' : 'Ask failed'}</strong>
          <span>{location}</span>
        </span>
        <span className="ask-notice-question">
          {preview.length > 100 ? `${preview.slice(0, 100)}…` : preview}
        </span>
      </span>
      <ArrowUpRight aria-hidden="true" className="ask-notice-jump" size={14} />
    </button>
  );
}

export function AskNotifications({
  notifications,
  onDismiss,
  onNavigate,
}: {
  notifications: ReadonlyArray<AskNotification>;
  onDismiss: (id: string) => void;
  onNavigate: (notification: AskNotification) => void;
}) {
  return (
    <div aria-atomic="false" aria-relevant="additions" className="ask-notifications" role="status">
      {notifications.map((notification) => (
        <AskNotice
          key={notification.id}
          notification={notification}
          onDismiss={onDismiss}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
