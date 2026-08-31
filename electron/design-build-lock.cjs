const path = require("node:path");
const { open, readFile, unlink } = require("node:fs/promises");

/**
 * Stops two builds sharing one workspace.
 *
 * A design build keeps its workspace — and Xcode's DerivedData inside it — in a
 * directory named after the project, so a second export of the same project is
 * incremental rather than a full rebuild. That is worth having, and it means
 * the directory is shared state.
 *
 * The single-instance lock does not cover this. Crank also runs as an MCP
 * runtime from a copy of itself in a temporary directory, so an agent can scan
 * while someone is using the app — a second process, with the same user data
 * directory and therefore the same workspace. Both starting a build of one
 * project is not hypothetical; it is what happens the first time an agent is
 * asked to scan something while the window is already scanning it.
 *
 * Xcode notices, and says: `unable to attach DB: database is locked. Possibly
 * there are two concurrent builds running in the same filesystem location.`
 * That is accurate and reaches the person as a wall of build log with no
 * indication that the answer is "something else is already doing this".
 *
 * So the workspace is claimed before the build starts. A claim that cannot be
 * made is reported in a sentence, rather than left for xcodebuild to discover
 * several seconds later.
 */

const LOCK_FILE = ".crank-build.lock";

/** A build that has been running this long is hung, not working. */
const STALE_AFTER_MS = 45 * 60 * 1000;

const lockPath = (workspaceRoot) => path.join(workspaceRoot, LOCK_FILE);

/**
 * Whether the process that wrote a lock is still alive.
 *
 * Signal 0 tests for existence without delivering anything. `EPERM` means the
 * process exists and belongs to someone else, which still counts as alive —
 * treating it as gone would let two builds run after all.
 */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLock(workspaceRoot) {
  const raw = await readFile(lockPath(workspaceRoot), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return {
      pid: Number.isInteger(value.pid) ? value.pid : null,
      startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
      label: typeof value.label === "string" ? value.label.slice(0, 120) : ""
    };
  } catch {
    // A lock nobody can read is a lock nobody can release. Treated as stale so
    // a corrupt file cannot wedge a project permanently.
    return { pid: null, startedAt: 0, label: "" };
  }
}

/**
 * Claims `workspaceRoot` for this process, or throws saying who holds it.
 *
 * Returns a release function. Call it in a `finally`: a lock left behind by a
 * build that threw would block the next one, and the pid check only clears it
 * once the process itself is gone.
 */
async function claimWorkspace(workspaceRoot, { label = "a scan", now = Date.now, pid = process.pid } = {}) {
  const file = lockPath(workspaceRoot);
  const contents = JSON.stringify({ pid, startedAt: now(), label });

  const write = async () => {
    // "wx" fails rather than truncating, which is what makes this a claim and
    // not just a note that a build happened.
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  };

  try {
    await write();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const held = await readLock(workspaceRoot);
    const alive = held !== null && processIsAlive(held.pid);
    const fresh = held !== null && now() - held.startedAt < STALE_AFTER_MS;
    if (alive && fresh) {
      throw new Error(
        `This project is already being built by ${held.label || "another Crank"}`
        + ` (process ${held.pid}). Two builds cannot share one workspace — wait for that one to finish.`
      );
    }
    // Whoever held it is gone, or has been at it long enough to be stuck.
    await unlink(file).catch(() => null);
    await write();
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const held = await readLock(workspaceRoot);
    // Only remove our own: a lock taken over as stale belongs to someone else
    // now, and deleting it would put two builds back in the same directory.
    if (held?.pid === pid) await unlink(file).catch(() => null);
  };
}

module.exports = { STALE_AFTER_MS, claimWorkspace, processIsAlive };
