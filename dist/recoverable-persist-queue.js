/**
 * Serialize state writes without letting one rejected write poison every later
 * save. The failed caller still receives the original rejection; the next
 * enqueue waits for that attempt to settle, then is allowed to persist a fresh
 * snapshot. This helper never retries a side effect and never swallows the
 * current write's error.
 */
export function enqueueRecoverablePersist(owner, writer) {
  if (!owner || typeof writer !== 'function') {
    throw new Error('Recoverable persistence requires an owner and writer.');
  }
  const previous = Promise.resolve(owner.persistQueue).catch(() => undefined);
  const current = previous.then(writer);
  owner.persistQueue = current.then(
    (value) => {
      if (owner.lastPersistError) {
        owner.persistRecoveryCount = Number(owner.persistRecoveryCount || 0) + 1;
      }
      owner.lastPersistError = null;
      return value;
    },
    (error) => {
      owner.lastPersistError = error instanceof Error ? error.message : String(error);
      owner.persistFailureCount = Number(owner.persistFailureCount || 0) + 1;
      throw error;
    },
  );
  return owner.persistQueue;
}
