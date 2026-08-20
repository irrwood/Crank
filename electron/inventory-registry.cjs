const path = require("node:path");
const { createHash } = require("node:crypto");
const { readFile, writeFile, mkdir, readdir, rm } = require("node:fs/promises");
const { createAssetStore, externalise, referencesIn } = require("./asset-store.cjs");

/**
 * Remembers what has been scanned, and keeps the result.
 *
 * Dragging a folder in every time is the obvious cost, but the larger one is
 * the scan itself: a real project takes minutes and produces tens of
 * megabytes. Keeping the inventory means reopening a project is instant and
 * rescanning is a deliberate act rather than the price of looking.
 */

const targetSchemaKeys = ["id", "kind", "target", "name", "addedAt", "lastScannedAt", "pageCount", "parent", "icon"];

function targetId(kind, target) {
  return createHash("sha256").update(`${kind}:${target}`).digest("hex").slice(0, 16);
}

function nameFor(kind, target) {
  if (kind === "folder") return path.basename(target.replace(/[/\\]+$/, "")) || target;
  // An app reached through its debugging port is named after what it serves,
  // and marked, because a plain scan of the same address is a different scan:
  // that one gets the interface without the data behind it.
  const attached = String(target).startsWith("attached:");
  const address = attached ? String(target).slice("attached:".length) : target;
  try {
    const url = new URL(address);
    const shown = url.host + (url.pathname === "/" ? "" : url.pathname);
    return attached ? `${shown} · attached` : shown;
  } catch {
    return target;
  }
}

/**
 * Nests the packages of a workspace under the workspace itself.
 *
 * Grouping by the folder a project happens to sit in is not a relationship:
 * everything under ~/Documents would become one "Documents" project, which
 * says only where files were saved. A package belongs to a workspace because
 * the user dropped that workspace and picked the package out of it, and that
 * is what is recorded.
 */
function groupTargets(targets) {
  const byPath = new Map(targets.map((entry) => [entry.target, entry]));
  const children = new Map();

  for (const entry of targets) {
    if (!entry.parent) continue;
    if (!children.has(entry.parent)) children.set(entry.parent, []);
    children.get(entry.parent).push(entry);
  }

  const claimed = new Set();
  const groups = [];
  for (const [parent, members] of children) {
    for (const member of members) claimed.add(member.id);
    // The workspace may itself have been scanned; if so it keeps its own row
    // inside the group rather than being duplicated outside it.
    const root = byPath.get(parent);
    if (root) claimed.add(root.id);
    groups.push({
      kind: "group",
      id: targetId("group", parent),
      name: nameFor("folder", parent),
      target: parent,
      root: root ?? null,
      children: members.sort((a, b) => a.name.localeCompare(b.name))
    });
  }

  const loose = targets.filter((entry) => !claimed.has(entry.id));
  return [...groups.sort((a, b) => a.name.localeCompare(b.name)),
    ...loose.sort((a, b) => a.name.localeCompare(b.name))];
}

/**
 * Reads a scan saved under an earlier name for the same thing.
 *
 * The captured layer tree was called figmaTree, which said it belonged to one
 * output when it is the browser's own shape and the only representation the
 * app draws from. Renaming it would otherwise have made every scan already on
 * disk look as though it had captured no layers at all.
 */
/**
 * Reads a scan taken by an older version, in the terms this one uses.
 *
 * Renaming or dropping a field cannot mean discarding what is already on disk:
 * someone with a folder scanned last week would open it to nothing.
 */
function carryOldNames(inventory) {
  if (!inventory?.pages) return inventory;
  const carry = (look) => {
    if (!look) return look;
    const { figmaTree, ...rest } = look;
    return "figmaTree" in look && !("layerTree" in look) ? { ...rest, layerTree: figmaTree } : look;
  };
  // A re-skinned page — dark, or another language — carries a whole capture of
  // its own, so it has the same weight to shed.
  const carryPage = (page) => (page?.variants
    ? { ...carry(page), variants: page.variants.map(carry) }
    : carry(page));
  return { ...inventory, pages: inventory.pages.map(carryPage) };
}

function createInventoryRegistry(directory) {
  const listPath = path.join(directory, "inventory-targets.json");
  // Pictures are written once under the hash of their bytes and referred to
  // from the scan, rather than inlined into it wherever they appear.
  const assets = createAssetStore(directory);
  const cachePath = (id) => path.join(directory, "inventories", `${id}.json`);

  const read = async () => {
    try {
      const parsed = JSON.parse(await readFile(listPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry) => entry && typeof entry.target === "string" && ["folder", "url"].includes(entry.kind))
        .map((entry) => Object.fromEntries(targetSchemaKeys.map((key) => [key, entry[key] ?? null])));
    } catch {
      // A corrupt or missing list must not look like "you have no projects" in
      // a way that silently loses them, so it is left on disk untouched.
      return [];
    }
  };

  const write = async (targets) => {
    await mkdir(directory, { recursive: true });
    await writeFile(listPath, `${JSON.stringify(targets, null, 2)}\n`);
  };

  return {
    list: read,
    grouped: async () => groupTargets(await read()),

    async remember(kind, target, { pageCount = null, scannedAt = null, parent = null, icon = null } = {}) {
      const targets = await read();
      const id = targetId(kind, target);
      const existing = targets.find((entry) => entry.id === id);
      const now = new Date().toISOString();
      if (existing) {
        existing.lastScannedAt = scannedAt ?? existing.lastScannedAt;
        existing.pageCount = pageCount ?? existing.pageCount;
        existing.parent = parent ?? existing.parent;
        existing.icon = icon ?? existing.icon;
      } else {
        targets.push({
          id, kind, target,
          name: nameFor(kind, target),
          addedAt: now,
          lastScannedAt: scannedAt,
          pageCount,
          parent,
          icon
        });
      }
      await write(targets);
      return targets.find((entry) => entry.id === id);
    },

    async forget(id) {
      const targets = await read();
      await write(targets.filter((entry) => entry.id !== id));
      await rm(cachePath(id), { force: true });
      await rm(path.join(directory, "baselines", `${id}.json`), { force: true });
      await rm(path.join(directory, "dropped", `${id}.json`), { force: true });
      await rm(path.join(directory, "kept", `${id}.json`), { force: true });
    },

    /**
     * Pages the user does not want in this project's inventory.
     *
     * Dropping one has to outlast the scan that found it, or the next scan
     * hands it straight back. Kept by page identity, which is the address and
     * the clicks that reach it — a 404 page stays dropped even after its
     * wording changes, which a content-derived id could never manage.
     */
    async drop(id, pageId) {
      // Dropping is the opposite decision to keeping, so it replaces it rather
      // than sitting beside it — otherwise a page restored and then dropped is
      // crawled out of the threshold on every scan only to be discarded again.
      const kept = await this.kept(id);
      if (kept.includes(pageId)) {
        await writeFile(path.join(directory, "kept", `${id}.json`), JSON.stringify(kept.filter((entry) => entry !== pageId)));
      }
      const current = await this.dropped(id);
      if (current.includes(pageId)) return current;
      const next = [...current, pageId];
      await mkdir(path.join(directory, "dropped"), { recursive: true });
      await writeFile(path.join(directory, "dropped", `${id}.json`), JSON.stringify(next));
      return next;
    },

    /**
     * Pages the crawl judged too small, that the user wants anyway.
     *
     * The threshold is a judgement, and a tab that swaps one number really is a
     * page to whoever is documenting it. Kept by the same identity dropping
     * uses — the address and the clicks that reach it — and for the same
     * reason: a scan applies the threshold every time, so the exception has to
     * be applied every time too, or restoring a page lasts until the next scan.
     */
    async keep(id, pageId) {
      const current = await this.kept(id);
      if (current.includes(pageId)) return current;
      const next = [...current, pageId];
      await mkdir(path.join(directory, "kept"), { recursive: true });
      await writeFile(path.join(directory, "kept", `${id}.json`), JSON.stringify(next));
      return next;
    },

    async kept(id) {
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, "kept", `${id}.json`), "utf8"));
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
      } catch {
        return [];
      }
    },

    async dropped(id) {
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, "dropped", `${id}.json`), "utf8"));
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
      } catch {
        return [];
      }
    },

    assets,

    async saveInventory(kind, target, inventory, { parent = null } = {}) {
      const id = targetId(kind, target);
      await mkdir(path.join(directory, "inventories"), { recursive: true });
      const lifted = await externalise(inventory, assets);
      await writeFile(cachePath(id), JSON.stringify(lifted));
      await this.remember(kind, target, {
        pageCount: inventory?.pages?.length ?? null,
        scannedAt: new Date().toISOString(),
        parent,
        // Kept on the entry, not only inside the inventory, so the list can
        // draw it without loading a scan that runs to tens of megabytes.
        icon: lifted?.icon ?? null
      });
      return id;
    },

    /**
     * Replaces the kept inventory without claiming the project was scanned.
     *
     * Recapturing one page updates what a reopened project shows, but it is not
     * a scan, and moving "last scanned" for it would overstate how fresh the
     * rest of the inventory is.
     */
    async updateInventory(id, inventory) {
      await mkdir(path.join(directory, "inventories"), { recursive: true });
      await writeFile(cachePath(id), JSON.stringify(await externalise(inventory, assets)));
      return id;
    },

    /**
     * Stores what was sent to Figma, per page.
     *
     * The pull direction compares three things: what was agreed at push time,
     * what the code says now, and what Figma says now. Without the first, a
     * later pull cannot tell a designer's edit from a developer's and has to
     * refuse. Recording it at push is what keeps that door open.
     */
    async saveFigmaBaseline(kind, target, baselines, { fileKey = null } = {}) {
      const id = targetId(kind, target);
      await mkdir(path.join(directory, "baselines"), { recursive: true });
      await writeFile(
        path.join(directory, "baselines", `${id}.json`),
        // The frames outlive the baseline they were drawn from: a page pushed
        // again belongs in the frame it already has, whether or not this push
        // arrives.
        JSON.stringify({
          pushedAt: new Date().toISOString(),
          fileKey,
          frames: (await this.loadFigmaBaseline(id))?.frames ?? {},
          screens: baselines
        })
      );
      return id;
    },

    /**
     * Replaces the sent baseline with what Figma reports it now holds, and
     * records which frame each page became.
     *
     * Figma rounds sizes and substitutes fonts, so a page that arrived intact
     * still differs from the payload that produced it. Comparing a later pull
     * against what was sent would report that round trip as a designer's edit.
     * The frames are what a second push reuses instead of drawing the page
     * again beside the first.
     */
    async recordFigmaPush(id, { frames = {}, screens = {} } = {}) {
      const current = (await this.loadFigmaBaseline(id)) ?? { pushedAt: null, fileKey: null, screens: {} };
      await mkdir(path.join(directory, "baselines"), { recursive: true });
      await writeFile(
        path.join(directory, "baselines", `${id}.json`),
        JSON.stringify({
          ...current,
          pushedAt: new Date().toISOString(),
          frames: { ...(current.frames ?? {}), ...frames },
          screens: { ...current.screens, ...screens }
        })
      );
      return id;
    },

    async loadFigmaBaseline(id) {
      try {
        return JSON.parse(await readFile(path.join(directory, "baselines", `${id}.json`), "utf8"));
      } catch {
        return null;
      }
    },

    async loadInventory(id) {
      let text;
      try {
        text = await readFile(cachePath(id), "utf8");
      } catch {
        return null;
      }
      let inventory;
      try {
        inventory = carryOldNames(JSON.parse(text));
      } catch {
        return null;
      }
      // Scans taken before pictures were stored separately carry them inline,
      // many times over. Opening one is the moment its images are in hand, so
      // it is also the moment to lift them out — once, not on every open.
      if (!text.includes("data:image/")) return inventory;
      const lifted = await externalise(inventory, assets);
      await writeFile(cachePath(id), JSON.stringify(lifted)).catch(() => null);
      return lifted;
    },

    /**
     * Removes stored pictures that no scan on this machine points at any more.
     *
     * Run at startup rather than after a save, because what makes a picture
     * unreferenced is usually a *different* project being forgotten, and asking
     * every scan on disk what it still uses is not work to do mid-scan.
     */
    async sweepAssets() {
      const referenced = new Set();
      let unread = 0;

      // Every scan on disk, not every scan in the list. An inventory whose list
      // entry has gone — a half-finished forget, a hand-edited file — still
      // holds pictures, and reading the list alone would call them unreferenced
      // and delete them.
      let files = [];
      try {
        files = (await readdir(path.join(directory, "inventories"))).filter((name) => name.endsWith(".json"));
      } catch {
        return { removed: 0, skipped: false };
      }
      for (const file of files) {
        const stored = await this.loadInventory(file.slice(0, -".json".length));
        if (stored) referencesIn(stored, referenced);
        else unread += 1;
      }
      for (const entry of await read()) referencesIn(entry, referenced);

      // A scan that could not be read is not a scan with no pictures in it.
      // Deleting on that assumption destroys the images of every project whose
      // file is corrupt, too large to parse, or simply new in a shape this
      // version does not know — and there is no getting them back.
      if (unread > 0) return { removed: 0, skipped: true, unread };
      return { ...await assets.collect(referenced), skipped: false };
    }
  };
}

module.exports = { createInventoryRegistry, groupTargets, nameFor, targetId };
