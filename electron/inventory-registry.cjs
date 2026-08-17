const path = require("node:path");
const { createHash } = require("node:crypto");
const { readFile, writeFile, mkdir, rm } = require("node:fs/promises");

/**
 * Remembers what has been scanned, and keeps the result.
 *
 * Dragging a folder in every time is the obvious cost, but the larger one is
 * the scan itself: a real project takes minutes and produces tens of
 * megabytes. Keeping the inventory means reopening a project is instant and
 * rescanning is a deliberate act rather than the price of looking.
 */

const targetSchemaKeys = ["id", "kind", "target", "name", "addedAt", "lastScannedAt", "pageCount", "parent"];

function targetId(kind, target) {
  return createHash("sha256").update(`${kind}:${target}`).digest("hex").slice(0, 16);
}

function nameFor(kind, target) {
  if (kind === "folder") return path.basename(target.replace(/[/\\]+$/, "")) || target;
  try {
    const url = new URL(target);
    return url.host + (url.pathname === "/" ? "" : url.pathname);
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

function createInventoryRegistry(directory) {
  const listPath = path.join(directory, "inventory-targets.json");
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

    async remember(kind, target, { pageCount = null, scannedAt = null, parent = null } = {}) {
      const targets = await read();
      const id = targetId(kind, target);
      const existing = targets.find((entry) => entry.id === id);
      const now = new Date().toISOString();
      if (existing) {
        existing.lastScannedAt = scannedAt ?? existing.lastScannedAt;
        existing.pageCount = pageCount ?? existing.pageCount;
        existing.parent = parent ?? existing.parent;
      } else {
        targets.push({
          id, kind, target,
          name: nameFor(kind, target),
          addedAt: now,
          lastScannedAt: scannedAt,
          pageCount,
          parent
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
      const current = await this.dropped(id);
      if (current.includes(pageId)) return current;
      const next = [...current, pageId];
      await mkdir(path.join(directory, "dropped"), { recursive: true });
      await writeFile(path.join(directory, "dropped", `${id}.json`), JSON.stringify(next));
      return next;
    },

    async dropped(id) {
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, "dropped", `${id}.json`), "utf8"));
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
      } catch {
        return [];
      }
    },

    async saveInventory(kind, target, inventory, { parent = null } = {}) {
      const id = targetId(kind, target);
      await mkdir(path.join(directory, "inventories"), { recursive: true });
      await writeFile(cachePath(id), JSON.stringify(inventory));
      await this.remember(kind, target, {
        pageCount: inventory?.pages?.length ?? null,
        scannedAt: new Date().toISOString(),
        parent
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
      await writeFile(cachePath(id), JSON.stringify(inventory));
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
      try {
        return JSON.parse(await readFile(cachePath(id), "utf8"));
      } catch {
        return null;
      }
    }
  };
}

module.exports = { createInventoryRegistry, groupTargets, nameFor, targetId };
