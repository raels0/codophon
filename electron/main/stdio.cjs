// @ts-check

/** @param {NodeJS.ErrnoException} error */
const handleStdioError = (error) => {
  // The launcher can close its log pipes while the desktop app is still running.
  if (error.code !== 'EPIPE') {
    throw error;
  }
};

process.stdout.on('error', handleStdioError);
process.stderr.on('error', handleStdioError);
