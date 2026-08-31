const path = require("node:path");
const { homedir } = require("node:os");
const { readFile } = require("node:fs/promises");
const { z } = require("zod");
const { internalise } = require("./asset-store.cjs");
const { createInventoryRegistry } = require("./inventory-registry.cjs");
const { createMcpRpcClient } = require("./mcp-rpc.cjs");

/**
 * Runs the Codex plugin without an Electron application process.
 *
 * Opening a saved flow only needs Crank's registry, asset store, shared graph
 * decisions, and MCP server. Starting Electron for that work made the plugin
 * disappear whenever the optional desktop runtime exited, even though every
 * byte needed by the canvas was still on disk. This adapter owns those pure
 * Node reads directly and starts the plugin's bundled, windowless Chromium
 * runtime only for capture or Figma operations that genuinely require it.
 */

const inventoryIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const pageIdSchema = z.string().min(1).max(200);
const paperCopyResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable().optional(),
  screens: z.array(z.string()).max(120).optional(),
  missing: z.array(z.string()).max(120).optional(),
  dropped: z.array(z.string()).max(120).optional()
}).passthrough();
const paperPushResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable().optional(),
  created: z.array(z.string()).max(120).optional(),
  updated: z.array(z.string()).max(120).optional(),
  failed: z.array(z.object({ name: z.string(), reason: z.string() })).max(120).optional(),
  fileName: z.string().nullable().optional(),
  missing: z.array(z.string()).max(120).optional(),
  dropped: z.array(z.string()).max(120).optional()
}).passthrough();

function defaultCrankUserDataDirectory({
  platform = process.platform,
  home = homedir(),
  env = process.env
} = {}) {
  if (env.CRANK_USER_DATA_DIR) {
    return z.string().min(1).max(4096).refine(path.isAbsolute).parse(env.CRANK_USER_DATA_DIR);
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Crank");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Crank");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Crank");
}

function withoutIcon(entry) {
  if (entry?.kind === "group") {
    return {
      ...entry,
      root: entry.root ? withoutIcon(entry.root) : null,
      children: entry.children.map(withoutIcon)
    };
  }
  if (!entry || typeof entry !== "object") return entry;
  const { icon, ...rest } = entry;
  return rest;
}

async function createWidgetHtmlLoader(widgetPath, { readTextFile = readFile } = {}) {
  // Codex keeps an MCP process alive for the lifetime of a task, while a
  // plugin reinstall may replace the cache directory that launched it. Read
  // the resource once at startup so an already-open task does not lose its UI
  // merely because a newer plugin build was installed beside it.
  const widgetHtml = await readTextFile(widgetPath, "utf8");
  return async () => widgetHtml;
}

function createStandaloneMcpOperations({
  dataDirectory = defaultCrankUserDataDirectory(),
  registry = createInventoryRegistry(dataDirectory),
  connectRuntime = () => createMcpRpcClient({ tokenPath: path.join(dataDirectory, "mcp-rpc-token") })
} = {}) {
  const inventory = (id) => registry.loadInventory(inventoryIdSchema.parse(id));
  const page = async (id, pageId) => {
    const stored = await inventory(id);
    const safePageId = pageIdSchema.parse(pageId);
    return stored?.ok ? stored.pages.find((candidate) => candidate.id === safePageId) ?? null : null;
  };
  const runtime = async (capability) => {
    const client = await connectRuntime();
    if (client) return client;
    throw new Error(`${capability} requires Crank's bundled capture runtime, but it is unavailable. Saved flows remain readable and the desktop app is not used as a fallback.`);
  };

  return {
    listProjects: async () => (await registry.grouped()).map(withoutIcon),
    getInventory: inventory,
    getPage: page,
    async getPageImage(id, pageId) {
      const storedPage = await page(id, pageId);
      const reference = storedPage?.thumbnail?.dataUrl;
      if (!reference) return null;
      return reference.startsWith("crank-asset://") ? registry.assets.dataUrl(reference) : reference;
    },
    async getPageDocument(id, pageId) {
      const storedPage = await page(id, pageId);
      if (!storedPage) return null;
      const reference = storedPage.thumbnail?.dataUrl;
      const dataUrl = reference?.startsWith("crank-asset://")
        ? await registry.assets.dataUrl(reference)
        : reference;
      if (storedPage.layerTree?.tree) {
        const layerTree = await internalise(storedPage.layerTree, registry.assets);
        return {
          kind: "layers",
          width: layerTree.width,
          height: layerTree.height,
          layerTree,
          ...(dataUrl ? { dataUrl } : {})
        };
      }
      return dataUrl ? {
        kind: "image",
        width: storedPage.thumbnail.width,
        height: storedPage.thumbnail.height,
        dataUrl
      } : null;
    },
    async scanProject(root, workspaceRoot, progress) {
      return (await runtime("Scanning a project")).scanProject(root, workspaceRoot, progress);
    },
    async scanUrl(url, seeds, progress) {
      return (await runtime("Scanning a URL")).scanUrl(url, seeds, progress);
    },
    async scanAttached(port, progress) {
      return (await runtime("Scanning an attached app")).scanAttached(port, progress);
    },
    async sendToFigma(id, figmaUrl, pageIds, progress) {
      return (await runtime("Sending to Figma")).sendToFigma(id, figmaUrl, pageIds, progress);
    },
    async getFigmaStatus(pairingCode) {
      return (await runtime("Reading Figma sync status")).getFigmaStatus(pairingCode);
    },
    async copyForPaper(id, pageIds, title) {
      return paperCopyResultSchema.parse(
        await (await runtime("Copying layers for Paper")).copyForPaper(id, pageIds, title)
      );
    },
    async pushToPaper(id, pageIds) {
      return paperPushResultSchema.parse(
        await (await runtime("Drawing layers in Paper")).pushToPaper(id, pageIds)
      );
    }
  };
}

module.exports = {
  createStandaloneMcpOperations,
  createWidgetHtmlLoader,
  defaultCrankUserDataDirectory,
  withoutIcon
};
