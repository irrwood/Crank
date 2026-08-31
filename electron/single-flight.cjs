/**
 * One run per key, shared by everyone who asks for it while it is running.
 *
 * Some work is not worth doing twice at once, and doing it twice is not merely
 * wasteful but wrong: scanning a project starts it, drives it, and for an Xcode
 * project builds into a workspace of its own, so a second run of the same scan
 * shares a DerivedData with the first and both fail. Two callers asking for the
 * same project do not want two scans; they want the one that is already
 * happening.
 *
 * Deliberately not a cache. The entry is dropped the moment the run settles, so
 * asking again afterwards runs it again — a scan is how you find out what
 * changed, and returning a remembered answer would defeat it.
 */
function createSingleFlight() {
  const running = new Map();

  return {
    /** Runs `work`, or hands back the run already going for this key. */
    run(key, work) {
      const existing = running.get(key);
      if (existing) return existing;
      // Started before it is recorded, so a `work` that throws synchronously
      // cannot leave an entry nobody will ever clear.
      let started;
      try {
        started = Promise.resolve(work());
      } catch (error) {
        return Promise.reject(error);
      }
      const tracked = started.finally(() => {
        // Only if it is still ours: a run that settled and was replaced by a
        // later one must not have the later one deleted out from under it.
        if (running.get(key) === tracked) running.delete(key);
      });
      running.set(key, tracked);
      return tracked;
    },

    /** Whether something is running under this key. */
    has(key) {
      return running.has(key);
    },

    get size() {
      return running.size;
    }
  };
}

module.exports = { createSingleFlight };
