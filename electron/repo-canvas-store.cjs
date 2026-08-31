const { createHash, randomBytes } = require("node:crypto");
const { readFile, writeFile, mkdir, rename, rm } = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod/v4");

/**
 * Keeps Crank's editable canvas beside the code it describes.
 *
 * The capture registry is still the cache for large browser observations, but
 * it cannot be the product workspace: another Codex task cannot recover the
 * user's layout, intent, or selected source from an opaque global ID. These
 * small versioned files make the repository authoritative while assets remain
 * bounded to `.crank/assets`. Every read is validated because repositories are
 * user-owned input, including repositories that already contain `.crank`.
 */

const absolutePathSchema = z.string().min(1).max(4096).refine(path.isAbsolute);
const inventoryIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const sourceRefSchema = z.object({
  file: z.string().min(1).max(1000),
  line: z.number().int().min(1).max(10_000_000),
  column: z.number().int().min(1).max(100_000),
  component: z.string().min(1).max(300).optional()
});
const pointerSchema = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  clientX: z.number().finite().min(-100_000).max(100_000),
  clientY: z.number().finite().min(-100_000).max(100_000)
});
const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screen"), screenId: z.string().min(1).max(200), sourceRef: sourceRefSchema.nullable().optional() }),
  z.object({ kind: z.literal("edge"), edgeId: z.string().min(1).max(300), sourceRef: sourceRefSchema.nullable().optional() }),
  z.object({
    kind: z.literal("node"),
    screenId: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(1000),
    name: z.string().max(300).optional(),
    sourceRef: sourceRefSchema.nullable().optional(),
    pointer: pointerSchema.optional()
  })
]);
const sourceAwareSchema = { sourceRef: sourceRefSchema.optional() };
const graphScreenSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  route: z.string().max(2000).optional(),
  annotation: z.string().max(4000).optional(),
  status: z.enum(["observed", "proposed", "modified", "deleted"]),
  ...sourceAwareSchema
});
const graphEdgeSchema = z.object({
  id: z.string().min(1).max(300),
  fromScreenId: z.string().min(1).max(200),
  toScreenId: z.string().min(1).max(200),
  status: z.enum(["observed", "proposed", "modified", "deleted"]),
  trigger: z.object({
    type: z.enum(["click", "submit", "route", "redirect", "automatic", "state-change", "unknown"]).optional(),
    label: z.string().max(500).optional()
  }).optional(),
  condition: z.string().max(2000).optional(),
  action: z.string().max(1000).optional(),
  ...sourceAwareSchema
});
const appGraphSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1).max(300),
    root: z.string().max(4096).optional(),
    inventoryId: inventoryIdSchema.optional()
  }),
  screens: z.array(graphScreenSchema).max(500),
  edges: z.array(graphEdgeSchema).max(2000),
  groups: z.array(z.unknown()).max(200),
  annotations: z.array(z.unknown()).max(1000)
});
const sceneInputSchema = z.object({
  inventoryId: inventoryIdSchema,
  layoutVersion: z.number().int().nonnegative().optional(),
  view: z.enum(["map", "screens"]),
  showPreviews: z.boolean(),
  nodes: z.array(z.object({
    id: z.string().min(1).max(200),
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000)
  })).max(500),
  selection: selectionSchema.nullable()
});
const sceneFileSchema = sceneInputSchema.extend({
  version: z.literal(1),
  stateVersion: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});
const flowFileSchema = z.object({
  version: z.literal(1),
  stateVersion: z.number().int().nonnegative(),
  inventoryId: inventoryIdSchema,
  observedGraph: appGraphSchema,
  intentGraph: appGraphSchema,
  updatedAt: z.string().datetime()
});
const manifestSchema = z.object({
  version: z.string(),
  flow: z.string(),
  summary: z.string(),
  changes: z.array(z.object({ type: z.string(), description: z.string() }).passthrough()),
  annotations: z.array(z.unknown()),
  affectedSources: z.array(z.unknown())
});
const changesFileSchema = z.object({
  version: z.literal(1),
  stateVersion: z.number().int().nonnegative(),
  inventoryId: inventoryIdSchema,
  manifest: manifestSchema,
  updatedAt: z.string().datetime()
});
const assetIndexSchema = z.object({
  version: z.literal(1),
  assets: z.record(z.string(), z.object({ file: z.string().min(1).max(300), mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) }))
});

async function writeAtomic(target, contents) {
  const temporary = `${target}.writing-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readValidated(target, schema, label) {
  let contents;
  try {
    contents = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const parsed = schema.safeParse(JSON.parse(contents));
  if (!parsed.success) throw new Error(`Invalid ${label}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  return parsed.data;
}

function safeSourcePath(root, sourceRef) {
  const ref = sourceRefSchema.parse(sourceRef);
  const target = path.resolve(root, ref.file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The selected source is outside this repository.");
  }
  return { ref, target, relative };
}

function dataUrlParts(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(value ?? ""));
  if (!match) return null;
  const extension = new Map([
    ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"],
    ["image/gif", "gif"], ["image/svg+xml", "svg"]
  ]).get(match[1].toLowerCase()) ?? "image";
  return { mimeType: match[1], extension, bytes: Buffer.from(match[2], "base64") };
}

function createRepoCanvasStore(repositoryRoot, { clock = () => new Date().toISOString() } = {}) {
  const root = absolutePathSchema.parse(repositoryRoot);
  const directory = path.join(root, ".crank");
  const scenePath = path.join(directory, "scene.json");
  const flowPath = path.join(directory, "flow.json");
  const changesPath = path.join(directory, "changes.json");
  const assetsDirectory = path.join(directory, "assets");
  const assetIndexPath = path.join(assetsDirectory, "index.json");

  const readScene = () => readValidated(scenePath, sceneFileSchema, ".crank/scene.json");
  const readFlow = () => readValidated(flowPath, flowFileSchema, ".crank/flow.json");
  const readChanges = () => readValidated(changesPath, changesFileSchema, ".crank/changes.json");

  return {
    root,
    directory,
    readScene,
    readFlow,
    readChanges,
    async open(inventoryId, observedGraph) {
      const safeId = inventoryIdSchema.parse(inventoryId);
      const safeObserved = appGraphSchema.parse(observedGraph);
      const [flow, scene] = await Promise.all([readFlow(), readScene()]);
      return {
        flow: flow?.inventoryId === safeId ? flow : {
          version: 1, stateVersion: 0, inventoryId: safeId,
          observedGraph: safeObserved,
          intentGraph: JSON.parse(JSON.stringify(safeObserved)),
          updatedAt: clock()
        },
        scene: scene?.inventoryId === safeId ? scene : {
          version: 1, stateVersion: 0, inventoryId: safeId,
          layoutVersion: 2, view: "map", showPreviews: true, nodes: [], selection: null,
          updatedAt: clock()
        }
      };
    },
    async writeFlow(inventoryId, observedGraph, intentGraph) {
      const current = await readFlow();
      const value = flowFileSchema.parse({
        version: 1,
        stateVersion: (current?.stateVersion ?? 0) + 1,
        inventoryId,
        observedGraph,
        intentGraph,
        updatedAt: clock()
      });
      await mkdir(directory, { recursive: true });
      await writeAtomic(flowPath, `${JSON.stringify(value, null, 2)}\n`);
      return value;
    },
    async writeScene(input) {
      const safe = sceneInputSchema.parse(input);
      const current = await readScene();
      const value = sceneFileSchema.parse({
        version: 1,
        stateVersion: (current?.stateVersion ?? 0) + 1,
        ...safe,
        updatedAt: clock()
      });
      await mkdir(directory, { recursive: true });
      await writeAtomic(scenePath, `${JSON.stringify(value, null, 2)}\n`);
      return value;
    },
    async writeChanges(inventoryId, manifest) {
      const current = await readChanges();
      const value = changesFileSchema.parse({
        version: 1,
        stateVersion: (current?.stateVersion ?? 0) + 1,
        inventoryId,
        manifest,
        updatedAt: clock()
      });
      await mkdir(directory, { recursive: true });
      await writeAtomic(changesPath, `${JSON.stringify(value, null, 2)}\n`);
      return value;
    },
    async writeAsset(pageId, dataUrl) {
      const parts = dataUrlParts(dataUrl);
      if (!parts) return null;
      const safePageId = z.string().min(1).max(200).parse(pageId);
      const file = `${createHash("sha256").update(safePageId).digest("hex").slice(0, 20)}.${parts.extension}`;
      await mkdir(assetsDirectory, { recursive: true });
      await writeAtomic(path.join(assetsDirectory, file), parts.bytes);
      const current = await readValidated(assetIndexPath, assetIndexSchema, ".crank/assets/index.json")
        ?? { version: 1, assets: {} };
      const next = assetIndexSchema.parse({
        version: 1,
        assets: { ...current.assets, [safePageId]: { file, mimeType: parts.mimeType } }
      });
      await writeAtomic(assetIndexPath, `${JSON.stringify(next, null, 2)}\n`);
      return { path: path.posix.join("assets", file), mimeType: parts.mimeType };
    },
    async readAsset(pageId) {
      const safePageId = z.string().min(1).max(200).parse(pageId);
      const index = await readValidated(assetIndexPath, assetIndexSchema, ".crank/assets/index.json");
      const entry = index?.assets[safePageId];
      if (!entry) return null;
      const target = path.join(assetsDirectory, entry.file);
      return `data:${entry.mimeType};base64,${(await readFile(target)).toString("base64")}`;
    },
    async readSourceContext(sourceRef, radius = 6) {
      const { ref, target, relative } = safeSourcePath(root, sourceRef);
      const lines = (await readFile(target, "utf8")).split(/\r?\n/);
      const startLine = Math.max(1, ref.line - radius);
      const endLine = Math.min(lines.length, ref.line + radius);
      return {
        sourceRef: { ...ref, file: relative },
        startLine,
        endLine,
        text: lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n")
      };
    }
  };
}

module.exports = {
  appGraphSchema,
  createRepoCanvasStore,
  sceneInputSchema,
  selectionSchema,
  sourceRefSchema
};
