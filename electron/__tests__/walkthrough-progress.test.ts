import { expect, test, vi } from 'vite-plus/test';
import { createWalkthroughProgressReporter } from '../walkthrough-progress.ts';

test('forwards repeated real progress events while the request is current', () => {
  let destroyed = false;
  let current = true;
  const send = vi.fn();
  const reportProgress = createWalkthroughProgressReporter(
    {
      isDestroyed: () => destroyed,
      send,
    },
    () => current,
  );

  reportProgress('response-received');
  reportProgress('response-received');

  expect(send.mock.calls).toEqual([
    ['codophon:walkthroughProgress', { phase: 'response-received' }],
    ['codophon:walkthroughProgress', { phase: 'response-received' }],
  ]);

  destroyed = true;
  reportProgress('agent-generation');
  expect(send).toHaveBeenCalledTimes(2);

  destroyed = false;
  current = false;
  reportProgress('agent-generation');
  expect(send).toHaveBeenCalledTimes(2);
});
