const path = require("node:path");
const { access, cp, readdir } = require("node:fs/promises");

/**
 * Carries what the app remembers across a rename.
 *
 * Electron derives the user data directory from the product name, so renaming
 * the product silently points it at an empty folder: every scanned project,
 * every kept inventory, every Figma baseline and the paired device would appear
 * to have vanished. Nothing is lost on disk — the app is simply looking
 * somewhere else.
 *
 * Copied rather than moved, and only into a directory that does not already
 * hold them, so running an older build afterwards still finds its own data and
 * a second run cannot overwrite newer work with older.
 */

const CARRIED = [
  "inventory-targets.json",
  "projects.json",
  "figma-device-connection.json",
  "inventories",
  "baselines",
  "dropped"
];

const exists = async (target) => access(target).then(() => true).catch(() => false);

async function carryUserData(previousDirectory, currentDirectory) {
  if (previousDirectory === currentDirectory) return { carried: [] };
  if (!(await exists(previousDirectory))) return { carried: [] };

  const carried = [];
  for (const entry of CARRIED) {
    const from = path.join(previousDirectory, entry);
    const to = path.join(currentDirectory, entry);
    if (!(await exists(from)) || (await exists(to))) continue;
    try {
      await cp(from, to, { recursive: true });
      carried.push(entry);
    } catch {}
  }
  return { carried };
}

module.exports = { CARRIED, carryUserData };
