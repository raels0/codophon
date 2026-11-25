import tls from 'node:tls';

export type CertificateTrustStatus = {
  reason?: string;
  status: 'applied' | 'empty-system' | 'failed' | 'unavailable';
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const createSystemCertificateTrust = (
  tlsImpl: Partial<Pick<typeof tls, 'getCACertificates' | 'setDefaultCACertificates'>> = tls,
) => {
  let initialized = false;

  const readCertificates = (source: 'default' | 'extra' | 'system') => {
    try {
      return {
        certificates:
          typeof tlsImpl.getCACertificates === 'function' ? tlsImpl.getCACertificates(source) : [],
        error: '',
      };
    } catch (error) {
      return { certificates: [], error: getErrorMessage(error) };
    }
  };

  return (): CertificateTrustStatus => {
    if (initialized) {
      return { status: 'applied' };
    }

    if (
      typeof tlsImpl.getCACertificates !== 'function' ||
      typeof tlsImpl.setDefaultCACertificates !== 'function'
    ) {
      return {
        reason: 'this Node/Electron runtime does not expose system certificate APIs',
        status: 'unavailable',
      };
    }

    const defaultCertificates = readCertificates('default');
    const extraCertificates = readCertificates('extra');
    const systemCertificates = readCertificates('system');
    const readError = [defaultCertificates, extraCertificates, systemCertificates].find(
      ({ error }) => error,
    )?.error;
    if (readError) {
      return { reason: readError, status: 'failed' };
    }

    if (systemCertificates.certificates.length === 0) {
      return { reason: 'the system certificate store was empty', status: 'empty-system' };
    }

    try {
      tlsImpl.setDefaultCACertificates([
        ...new Set([
          ...defaultCertificates.certificates,
          ...extraCertificates.certificates,
          ...systemCertificates.certificates,
        ]),
      ]);
    } catch (error) {
      return { reason: getErrorMessage(error), status: 'failed' };
    }

    initialized = true;
    return { status: 'applied' };
  };
};

const trustSystemCertificates = createSystemCertificateTrust();

export { createSystemCertificateTrust, trustSystemCertificates };
