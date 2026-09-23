/** Couple the background product runtime to its own HTTP listener lifecycle.
 * Closing a listener must not leave a headless Core projecting stale UI.
 * This never discovers or terminates another process.
 */
export function attachHttpRuntimeLifecycle(httpServer, closeRuntime, { onError = () => {} } = {}) {
  if (!httpServer?.once || typeof closeRuntime !== 'function') throw new Error('HTTP server and runtime cleanup are required');
  let closing;
  const stop = () => {
    closing ??= Promise.resolve().then(closeRuntime).catch((error) => { onError(error); });
    return closing;
  };
  httpServer.once('close', stop);
  httpServer.once('error', (error) => { onError(error); void stop(); });
  return { close: stop };
}
