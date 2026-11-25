import { expect, test, vi } from 'vite-plus/test';
import { createSystemCertificateTrust } from '../system-certificates.ts';

type FakeTls = Parameters<typeof createSystemCertificateTrust>[0];

const loadTrustSystemCertificates = (tlsImpl: FakeTls) => ({
  restore: () => {},
  trustSystemCertificates: createSystemCertificateTrust(tlsImpl),
});

test('merges default, extra, and system certificates once', { concurrent: false }, () => {
  const setDefaultCACertificates = vi.fn();
  const { restore, trustSystemCertificates } = loadTrustSystemCertificates({
    getCACertificates: (source) => {
      if (source === 'default') {
        return ['default-ca', 'shared-ca'];
      }
      if (source === 'extra') {
        return ['extra-ca', 'shared-ca'];
      }
      if (source === 'system') {
        return ['system-ca', 'extra-ca'];
      }
      return [];
    },
    setDefaultCACertificates,
  });
  using _cleanup = {
    [Symbol.dispose]() {
      restore();
    },
  };

  expect(trustSystemCertificates()).toEqual({ status: 'applied' });
  expect(trustSystemCertificates()).toEqual({ status: 'applied' });
  expect(setDefaultCACertificates).toHaveBeenCalledOnce();
  expect(setDefaultCACertificates).toHaveBeenCalledWith([
    'default-ca',
    'shared-ca',
    'extra-ca',
    'system-ca',
  ]);
});

test(
  'does not mark certificate trust as initialized after a failed apply',
  { concurrent: false },
  () => {
    const setDefaultCACertificates = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('keychain busy');
      })
      .mockImplementationOnce(() => {});
    const { restore, trustSystemCertificates } = loadTrustSystemCertificates({
      getCACertificates: (source) => (source === 'system' ? ['system-ca'] : []),
      setDefaultCACertificates,
    });
    using _cleanup = {
      [Symbol.dispose]() {
        restore();
      },
    };

    expect(trustSystemCertificates()).toEqual({ reason: 'keychain busy', status: 'failed' });
    expect(trustSystemCertificates()).toEqual({ status: 'applied' });
    expect(setDefaultCACertificates).toHaveBeenCalledTimes(2);
  },
);

test('reports unavailable and empty system certificate stores', { concurrent: false }, () => {
  const unavailable = loadTrustSystemCertificates({});
  using _unavailableCleanup = {
    [Symbol.dispose]() {
      unavailable.restore();
    },
  };
  expect(unavailable.trustSystemCertificates()).toEqual({
    reason: 'this Node/Electron runtime does not expose system certificate APIs',
    status: 'unavailable',
  });

  const empty = loadTrustSystemCertificates({
    getCACertificates: () => [],
    setDefaultCACertificates: vi.fn(),
  });
  using _emptyCleanup = {
    [Symbol.dispose]() {
      empty.restore();
    },
  };
  expect(empty.trustSystemCertificates()).toEqual({
    reason: 'the system certificate store was empty',
    status: 'empty-system',
  });
});
