const path = require("node:path");
const { createHash } = require("node:crypto");
const { mkdir, writeFile, readFile, access, readdir, rm } = require("node:fs/promises");

/**
 * Keeps every captured image once, under the hash of its own bytes.
 *
 * A scan used to carry each image inline, in every page that showed it, in two
 * different encodings — once in the layer tree and once in the markup. On a real
 * portfolio that was 280MB of the same 342 pictures, one of them repeated 46
 * times, in a 338MB file the app had to parse to open the project.
 *
 * Addressing by content makes the duplication impossible rather than merely
 * smaller: the same bytes are the same file, whichever page or scan they came
 * from, and a rescan of an unchanged project writes nothing new.
 */

// A trailing slash is tolerated because Electron normalises a privileged
// scheme the way it normalises http, so what the window asks for comes back as
// "crank-asset://<hash>.webp/" even though nothing wrote it that way.
const REFERENCE = /^crank-asset:\/\/([a-f0-9]{40})(?:\.(\w+))?\/?$/;

const MIME_BY_EXTENSION = { gif: "image/gif", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp" };

/** What a reference should be served as, from the extension it carries. */
function mimeFor(reference) {
  const match = REFERENCE.exec(String(reference ?? ""));
  return MIME_BY_EXTENSION[match?.[2]] ?? "application/octet-stream";
}

function extensionFor(mime) {
  const found = Object.entries(MIME_BY_EXTENSION).find(([, known]) => known === String(mime).toLowerCase());
  return found ? found[0] : "bin";
}

function parseDataUrl(value) {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/is.exec(String(value ?? ""));
  if (!match) return null;
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

function createAssetStore(directory) {
  const root = path.join(directory, "assets");
  const filenameFor = (hash, extension) => `${hash}.${extension}`;

  return {
    root,

    /** Writes the bytes if they are new, and returns the reference to them. */
    async put(dataUrl) {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) return null;
      const hash = createHash("sha1").update(parsed.bytes).digest("hex");
      const extension = extensionFor(parsed.mime);
      const name = filenameFor(hash, extension);
      const target = path.join(root, name);
      if (!(await access(target).then(() => true).catch(() => false))) {
        await mkdir(root, { recursive: true });
        await writeFile(target, parsed.bytes);
      }
      return `crank-asset://${hash}.${extension}`;
    },

    /** The bytes behind a reference, for whatever needs them inline again. */
    async read(reference) {
      const match = REFERENCE.exec(String(reference ?? ""));
      if (!match) return null;
      const [, hash, extension] = match;
      try {
        return await readFile(path.join(root, filenameFor(hash, extension ?? "bin")));
      } catch {
        return null;
      }
    },

    async dataUrl(reference) {
      const bytes = await this.read(reference);
      return bytes ? `data:${mimeFor(reference)};base64,${bytes.toString("base64")}` : null;
    },

    /**
     * Drops what nothing points at any more.
     *
     * Assets outlive the scan that introduced them because another project may
     * share them, so nothing can be deleted when a page is — only when no scan
     * on the machine still refers to it.
     */
    async collect(referenced) {
      const keep = new Set([...referenced].map((reference) => {
        const match = REFERENCE.exec(String(reference));
        return match ? filenameFor(match[1], match[2] ?? "bin") : null;
      }).filter(Boolean));
      let removed = 0;
      let files = [];
      try {
        files = await readdir(root);
      } catch {
        return { removed: 0 };
      }
      for (const file of files) {
        if (keep.has(file)) continue;
        await rm(path.join(root, file), { force: true });
        removed += 1;
      }
      return { removed };
    }
  };
}

/**
 * A data URL embedded in a longer string — inside captured markup, that is.
 *
 * A page's own document carries its pictures inlined, in `src`, in `srcset` and
 * in `url(...)` inside a stylesheet, and on one real portfolio those were 127MB
 * of the 145MB of markup. They are the same pictures the layer tree holds, so
 * they belong in the same store rather than in a second copy.
 */
const EMBEDDED = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

async function replaceEmbedded(text, replace) {
  const found = [...new Set(text.match(EMBEDDED) ?? [])];
  if (found.length === 0) return text;
  let out = text;
  for (const dataUrl of found) {
    const reference = await replace(dataUrl);
    if (reference) out = out.split(dataUrl).join(reference);
  }
  return out;
}

/** Every data URL in a scan, replaced by a reference to the stored bytes. */
async function externalise(value, store) {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return (await store.put(value)) ?? value;
    return value.includes("data:image/") ? replaceEmbedded(value, (found) => store.put(found)) : value;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => externalise(item, store)));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = await externalise(inner, store);
    return out;
  }
  return value;
}

/**
 * The reverse: every reference resolved back to the bytes it stands for.
 *
 * What leaves the app has to be self-contained — the Figma plugin and an
 * exported handoff page both run somewhere this store does not exist.
 */
const EMBEDDED_REFERENCE = /crank-asset:\/\/[a-f0-9]{40}(?:\.\w+)?/gi;

async function internalise(value, store) {
  if (typeof value === "string") {
    if (REFERENCE.test(value)) return (await store.dataUrl(value)) ?? value;
    if (!value.includes("crank-asset://")) return value;
    const found = [...new Set(value.match(EMBEDDED_REFERENCE) ?? [])];
    let out = value;
    for (const reference of found) {
      const dataUrl = await store.dataUrl(reference);
      if (dataUrl) out = out.split(reference).join(dataUrl);
    }
    return out;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => internalise(item, store)));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = await internalise(inner, store);
    return out;
  }
  return value;
}

/** Every reference in a scan, collected so nothing live is swept away. */
function referencesIn(value, found = new Set()) {
  if (typeof value === "string") {
    if (REFERENCE.test(value)) found.add(value);
    else for (const embedded of value.match(EMBEDDED_REFERENCE) ?? []) found.add(embedded);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) referencesIn(inner, found);
  }
  return found;
}

module.exports = { REFERENCE, createAssetStore, externalise, internalise, mimeFor, parseDataUrl, referencesIn };
