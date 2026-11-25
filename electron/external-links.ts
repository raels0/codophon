/**
 * Electron's default window-open behavior spawns an in-app child window with
 * its own cookie-less session, so target="_blank" links such as the pull
 * request badge land on GitHub unauthenticated (a 404 for private
 * repositories). Deny every in-app window and hand openable links to the
 * operating system's default browser instead; navigation away from the
 * renderer gets the same treatment so the app window never leaves the app.
 */
const attachExternalLinkHandling = (
  webContents: Pick<import('electron').WebContents, 'getURL' | 'on' | 'setWindowOpenHandler'>,
  openExternal: (url: string) => Promise<void>,
) => {
  // shell.openExternal rejects when the operating system cannot open the url;
  // an unhandled rejection in the main process is all that would come of it.
  const openSafely = (url: string) => {
    void openExternal(url).catch(() => {});
  };
  webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenableExternally(url)) {
      openSafely(url);
    }
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isInAppNavigation(url, webContents.getURL())) {
      return;
    }
    event.preventDefault();
    if (isOpenableExternally(url)) {
      openSafely(url);
    }
  });
};

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

const isOpenableExternally = (url: string) => {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/**
 * In-app navigation is a reload of the current url or, for the dev server,
 * another url on the renderer's own origin. Everything else (including other
 * file: urls) stays blocked so the window cannot be steered off the app.
 */
const isInAppNavigation = (target: string, current: string) => {
  try {
    const targetUrl = new URL(target);
    const currentUrl = new URL(current);
    return (
      targetUrl.href === currentUrl.href ||
      (EXTERNAL_PROTOCOLS.has(targetUrl.protocol) &&
        EXTERNAL_PROTOCOLS.has(currentUrl.protocol) &&
        targetUrl.origin === currentUrl.origin)
    );
  } catch {
    return false;
  }
};

export { attachExternalLinkHandling };
