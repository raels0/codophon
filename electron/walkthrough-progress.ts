/**
 * Keep repeated phases because agent deltas are real activity events. The
 * renderer decides whether an event changes the visible stage.
 */
const createWalkthroughProgressReporter = (
  webContents: Pick<Electron.WebContents, 'isDestroyed' | 'send'>,
  isCurrent: () => boolean = () => true,
) => {
  return (phase: import('../core/types.ts').WalkthroughProgressPhase) => {
    if (webContents.isDestroyed() || !isCurrent()) {
      return;
    }

    const progress: import('../core/types.ts').WalkthroughProgressEvent = { phase };
    webContents.send('codophon:walkthroughProgress', progress);
  };
};

export { createWalkthroughProgressReporter };
