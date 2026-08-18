/**
 * Keeps a project's server up for as long as something is looking at it.
 *
 * Scanning starts a server, does its work and stops it, which is right for a
 * scan and wrong for a preview: a preview is someone reading a page, and it
 * ends when they close it, not when a job returns. Rather than a second way of
 * starting projects — dev script, foreign command, static files, Electron
 * renderer, each with its own failures — the run is expressed as a job that
 * simply does not finish until it is released.
 *
 * So there is one answer to "how is this project served", and preview and scan
 * cannot drift into disagreeing about it.
 */
function holdServer(root, { onStatus, run }) {
  let release = () => {};
  let settled = false;
  const held = new Promise((resolve) => { release = resolve; });

  const ready = new Promise((resolve, reject) => {
    run(root, { allowWorkspaceRoot: true, onStatus }, async (origin) => {
      settled = true;
      resolve(origin);
      await held;
      return { ok: true, pages: [] };
    }).then(
      (outcome) => {
        // A failure before the job ever ran is the only way this rejects: once
        // the job has the origin, the caller has what it asked for.
        if (!settled) reject(new Error(outcome?.message ?? "This project could not be served."));
      },
      (cause) => { if (!settled) reject(cause); }
    );
  });

  return { ready, release: () => release() };
}

module.exports = { holdServer };
