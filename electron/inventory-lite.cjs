const { REFERENCE } = require("./snapshot-store.cjs");

/**
 * Takes the captured markup out of a scan, and leaves behind what the window
 * actually reads from it.
 *
 * A scan of a large app is mostly documents: 272MB of markup in a 293MB file,
 * and every byte of it was parsed, copied across to the window and held there
 * to open a project. The window uses the markup for exactly two things — the
 * links the flow view draws, and the one page someone opens — and the first of
 * those is a few hundred bytes once it has been read.
 *
 * So the links are read once, here, and the document itself becomes a
 * reference to a file. Opening a page fetches that page's document, which is
 * the only moment it was ever wanted.
 */

/** How much markup is scanned for links. Beyond this a page is a document. */
const MAX_LINK_SCAN = 8_000_000;

/**
 * The links a captured page holds, read without a DOM.
 *
 * The window used to parse the whole document to find them, per page, every
 * time the flow view opened. What it wants is each anchor's target and its
 * words, and a regex reads that from markup the browser has already
 * normalised — this is not parsing HTML in general, it is reading back
 * something Chromium serialised.
 */
function linksIn(html) {
  if (typeof html !== "string" || html.length === 0) return [];
  const source = html.length > MAX_LINK_SCAN ? html.slice(0, MAX_LINK_SCAN) : html;
  const found = [];
  const anchors = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]{0,4000}?)<\/a>/gi;
  let match;
  while ((match = anchors.exec(source)) !== null) {
    const label = match[2].replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    found.push({ href: match[1], label: label.slice(0, 200) });
    if (found.length >= 2000) break;
  }
  return found;
}

/** A snapshot with its document put away, and what was read from it kept. */
async function liftSnapshot(snapshot, store) {
  if (!snapshot || typeof snapshot !== "object") return snapshot ?? null;
  if (typeof snapshot.html !== "string") return snapshot;
  const { html, ...rest } = snapshot;
  return {
    ...rest,
    bytes: rest.bytes ?? html.length,
    links: rest.links ?? linksIn(html),
    ref: store ? await store.put(html) : null
  };
}

const isReference = (value) => typeof value === "string" && REFERENCE.test(value);

/**
 * Every page and every variant of one, with `map` applied to its snapshot.
 * Written once because a variant is a page wearing a different look, and the
 * two have drifted apart before.
 */
async function overSnapshots(inventory, map) {
  if (!inventory?.pages) return inventory;
  const pages = [];
  for (const page of inventory.pages) {
    const variants = [];
    for (const variant of page?.variants ?? []) {
      variants.push({ ...variant, snapshot: await map(variant?.snapshot) });
    }
    pages.push({
      ...page,
      snapshot: await map(page?.snapshot),
      ...(page?.variants ? { variants } : {})
    });
  }
  return { ...inventory, pages };
}

/** The scan as it is stored and handed to the window: no documents in it. */
async function lighten(inventory, store) {
  return overSnapshots(inventory, (snapshot) => liftSnapshot(snapshot, store));
}

/**
 * The scan with its documents back, for the things that write them out — the
 * handoff file above all. Reads only what is referenced, and says nothing when
 * a file has gone rather than failing the export.
 */
async function withSnapshots(inventory, store) {
  return overSnapshots(inventory, async (snapshot) => {
    if (!snapshot || !isReference(snapshot.ref)) return snapshot ?? null;
    const html = await store.read(snapshot.ref);
    return html === null ? snapshot : { ...snapshot, html };
  });
}

/** Every snapshot reference in a scan, so a sweep keeps what is still used. */
function snapshotReferencesIn(value, found = new Set()) {
  if (isReference(value)) found.add(value);
  else if (Array.isArray(value)) for (const item of value) snapshotReferencesIn(item, found);
  else if (value && typeof value === "object") for (const inner of Object.values(value)) snapshotReferencesIn(inner, found);
  return found;
}

module.exports = { lighten, liftSnapshot, linksIn, snapshotReferencesIn, withSnapshots };
