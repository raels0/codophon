const DEFAULT_COPY_PENDING_COMMENTS_TIMEOUT_MS = 2000;

export type PendingCommentsWebContents = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, requestId: number) => void;
};
export type PendingCommentsBrowserWindow = {
  isDestroyed: () => boolean;
  webContents: PendingCommentsWebContents;
};
export type PendingCommentsIpcEvent = {
  sender: {
    id: number;
  };
};
export type PendingCommentsRequest = {
  resolve: (markdown: string) => void;
  webContentsId: number;
};

const createPendingCommentsClipboardController = ({
  clipboard,
  timeoutMs = DEFAULT_COPY_PENDING_COMMENTS_TIMEOUT_MS,
}: {
  clipboard: {
    writeText: (text: string) => void;
  };
  timeoutMs?: number;
}) => {
  let nextRequestId = 0;

  const pendingRequests: Map<number, PendingCommentsRequest> = new Map();

  const handleCopyPendingCommentsResult = (
    event: PendingCommentsIpcEvent,
    requestId: number,
    markdown: unknown,
  ) => {
    const pending = pendingRequests.get(requestId);
    if (!pending || pending.webContentsId !== event.sender.id) {
      return;
    }

    pendingRequests.delete(requestId);
    pending.resolve(typeof markdown === 'string' ? markdown : '');
  };

  const requestPendingCommentsMarkdown = (browserWindow: PendingCommentsBrowserWindow) =>
    new Promise((resolve) => {
      if (browserWindow.isDestroyed() || browserWindow.webContents.isDestroyed()) {
        resolve('');
        return;
      }

      const requestId = ++nextRequestId;
      const webContentsId = browserWindow.webContents.id;
      const timeout = setTimeout(() => {
        if (pendingRequests.delete(requestId)) {
          resolve('');
        }
      }, timeoutMs);

      pendingRequests.set(requestId, {
        resolve: (markdown) => {
          clearTimeout(timeout);
          resolve(markdown);
        },
        webContentsId,
      });

      browserWindow.webContents.send('codophon:copyPendingCommentsRequest', requestId);
    });

  const copyPendingCommentsToClipboard = async (
    browserWindows: ReadonlyArray<PendingCommentsBrowserWindow>,
  ) => {
    const markdownBlocks = (
      await Promise.all(browserWindows.map((window) => requestPendingCommentsMarkdown(window)))
    ).filter(Boolean);

    if (markdownBlocks.length) {
      clipboard.writeText(markdownBlocks.join('\n\n'));
    }
  };

  return {
    copyPendingCommentsToClipboard,
    handleCopyPendingCommentsResult,
    requestPendingCommentsMarkdown,
  };
};

export { createPendingCommentsClipboardController };
