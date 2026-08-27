const path = require("node:path");
const { createHash } = require("node:crypto");
const { mkdir, writeFile, readFile, readdir, rm, access } = require("node:fs/promises");

/**
 * Keeps each captured page's markup in a file of its own.
 *
 * The markup is by far the heaviest thing a scan holds — 272MB of one 293MB
 * scan, five megabytes a page — and almost nothing needs it. The gallery draws
 * thumbnails, the flow view needs the links, and a send builds from the layer
 * tree; only opening one page, or writing a handoff file, wants the document
 * itself. Kept inline, all of it was read, parsed and copied into the window
 * every time a project was opened, which is what made opening one take
 * seconds.
 *
 * Addressed by content, like the image store next to it: two scans of an
 * unchanged page write one file, and a rescan writes nothing new.
 */

const REFERENCE = /^crank-snapshot:\/\/([a-f0-9]{40})\.html$/;

function createSnapshotStore(directory) {
  const root = path.join(directory, "snapshots");
  const fileFor = (reference) => {
    const match = REFERENCE.exec(String(reference ?? ""));
    return match ? path.join(root, `${match[1]}.html`) : null;
  };

  return {
    root,

    /** Writes the markup if it is new, and returns the reference to it. */
    async put(html) {
      if (typeof html !== "string" || html === "") return null;
      const hash = createHash("sha1").update(html).digest("hex");
      const target = path.join(root, `${hash}.html`);
      if (!(await access(target).then(() => true).catch(() => false))) {
        await mkdir(root, { recursive: true });
        await writeFile(target, html);
      }
      return `crank-snapshot://${hash}.html`;
    },

    /** The markup behind a reference, or null when it is gone. */
    async read(reference) {
      const file = fileFor(reference);
      if (!file) return null;
      return readFile(file, "utf8").catch(() => null);
    },

    /**
     * Removes markup no scan points at any more. Called with the full set of
     * live references, never with a partial one: a snapshot cannot be
     * recovered, only recaptured.
     */
    async collect(referenced) {
      let removed = 0;
      const files = await readdir(root).catch(() => []);
      for (const name of files) {
        if (!/^[a-f0-9]{40}\.html$/.test(name)) continue;
        if (referenced.has(`crank-snapshot://${name}`)) continue;
        await rm(path.join(root, name), { force: true });
        removed += 1;
      }
      return { removed };
    }
  };
}

module.exports = { REFERENCE, createSnapshotStore };
