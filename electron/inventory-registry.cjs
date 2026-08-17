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

const targetSchemaKeys = ["id", "kind", "target", "name", "addedAt", "lastScannedAt", "pageCount"];

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
 * Groups targets that live under a shared folder, so a workspace reads as one
 * project with its packages inside rather than as several unrelated entries.
 */
function groupTargets(targets) {
  const folders = targets.filter((entry) => entry.kind === "folder");
  const groups = new Map();

  for (const entry of folders) {
    const parent = path.dirname(entry.target);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(entry);
  }

  const grouped = [];
  const claimed = new Set();
  for (const [parent, members] of groups) {
    if (members.length < 2) continue;
    for (const member of members) claimed.add(member.id);
    grouped.push({
      kind: "group",
      id: targetId("group", parent),
      name: path.basename(parent) || parent,
      target: parent,
      children: members.sort((a, b) => a.name.localeCompare(b.name))
    });
  }

  const loose = targets.filter((entry) => !claimed.has(entry.id));
  return [...grouped.sort((a, b) => a.name.localeCompare(b.name)),
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

    async remember(kind, target, { pageCount = null, scannedAt = null } = {}) {
      const targets = await read();
      const id = targetId(kind, target);
      const existing = targets.find((entry) => entry.id === id);
      const now = new Date().toISOString();
      if (existing) {
        existing.lastScannedAt = scannedAt ?? existing.lastScannedAt;
        existing.pageCount = pageCount ?? existing.pageCount;
      } else {
        targets.push({
          id, kind, target,
          name: nameFor(kind, target),
          addedAt: now,
          lastScannedAt: scannedAt,
          pageCount
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

    async saveInventory(kind, target, inventory) {
      const id = targetId(kind, target);
      await mkdir(path.join(directory, "inventories"), { recursive: true });
      await writeFile(cachePath(id), JSON.stringify(inventory));
      await this.remember(kind, target, {
        pageCount: inventory?.pages?.length ?? null,
        scannedAt: new Date().toISOString()
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
