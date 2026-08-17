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
