import { z } from "zod";
import { formatCrankAnnotationContext } from "../../shared/annotation-context.js";
import { advanceHostLayout, type HostLayout } from "../../shared/host-layout.js";
import type { AppGraph, CanvasPayload, CanvasSelection, CrankJob, CrankVisualAnnotation, FigmaSendResult, FigmaSyncStatus, PageDocument, PaperCopyResult, PaperPushResult, PreparedReview } from "./types";

/**
 * The Codex canvas is an MCP App, not an Electron renderer. It therefore asks
 * the owning Crank MCP process for each captured preview instead of depending
 * on file URLs or the crank-asset protocol that only Electron can resolve.
 * Every host response is untrusted cross-boundary data and is parsed before it
 * is allowed into React state.
 */

type OpenAiHost = {
  toolOutput?: unknown;
  displayMode?: unknown;
  maxHeight?: unknown;
  safeArea?: unknown;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  openExternal?: (options: { href: string; redirectUrl?: boolean }) => Promise<unknown>;
  requestDisplayMode?: (options: { mode: "inline" | "fullscreen" }) => Promise<unknown>;
};

declare global {
  interface Window { openai?: OpenAiHost }
}

const graphScreenSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  route: z.string().max(2000).optional(),
  annotation: z.string().max(4000).optional(),
  status: z.enum(["observed", "proposed", "modified", "deleted"]),
  sourceRef: z.object({ file: z.string(), line: z.number().int(), column: z.number().int(), component: z.string().optional() }).optional()
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
  sourceRef: z.object({ file: z.string(), line: z.number().int(), column: z.number().int(), component: z.string().optional() }).optional()
});

const appGraphSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1).max(300),
    root: z.string().max(4096).optional(),
    inventoryId: z.string().regex(/^[a-f0-9]{16}$/).optional()
  }),
  screens: z.array(graphScreenSchema).max(500),
  edges: z.array(graphEdgeSchema).max(2000),
  groups: z.array(z.unknown()).max(200),
  annotations: z.array(z.unknown()).max(1000)
});

const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screen"), screenId: z.string(), sourceRef: graphScreenSchema.shape.sourceRef.nullable().optional() }),
  z.object({ kind: z.literal("edge"), edgeId: z.string(), sourceRef: graphScreenSchema.shape.sourceRef.nullable().optional() }),
  z.object({
    kind: z.literal("node"),
    screenId: z.string(),
    nodeId: z.string(),
    name: z.string().optional(),
    sourceRef: graphScreenSchema.shape.sourceRef.nullable().optional(),
    pointer: z.object({ x: z.number().finite(), y: z.number().finite(), clientX: z.number().finite(), clientY: z.number().finite() }).optional()
  })
]);

const normalizedPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1)
});

const visualAnnotationSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(200),
  inventoryId: z.string().regex(/^[a-f0-9]{16}$/),
  screenId: z.string().min(1).max(200),
  screenName: z.string().min(1).max(300),
  comment: z.string().trim().min(1).max(2000),
  target: z.object({
    kind: z.enum(["node", "point"]),
    point: normalizedPointSchema,
    boundingBox: normalizedPointSchema.extend({
      width: z.number().finite().min(0).max(1),
      height: z.number().finite().min(0).max(1)
    }).optional(),
    nodeId: z.string().min(1).max(300).optional(),
    name: z.string().max(500).optional(),
    sourceRef: graphScreenSchema.shape.sourceRef.nullable().optional()
  }),
  createdAt: z.string().datetime()
});

const sceneSchema = z.object({
  version: z.literal(1),
  layoutVersion: z.number().int().nonnegative().optional(),
  stateVersion: z.number().int().nonnegative(),
  inventoryId: z.string().regex(/^[a-f0-9]{16}$/),
  view: z.enum(["map", "screens"]),
  showPreviews: z.boolean(),
  nodes: z.array(z.object({ id: z.string(), x: z.number().finite(), y: z.number().finite() })),
  selection: selectionSchema.nullable(),
  updatedAt: z.string()
});

const canvasPayloadSchema = z.object({
  inventoryId: z.string().regex(/^[a-f0-9]{16}$/),
  observedGraph: appGraphSchema,
  intentGraph: appGraphSchema,
  scene: sceneSchema,
  stateVersion: z.number().int().nonnegative(),
  // An already-running Codex task may still have the previous MCP process.
  // Defaulting this new hint keeps that task usable while the plugin resource
  // is replaced; only the remembered URL is absent until the next task.
  exportSettings: z.object({ figmaUrl: z.string().max(2000).nullable() }).optional()
});

const jobSchema = z.object({
  id: z.string().uuid(),
  kind: z.string().min(1).max(80),
  state: z.enum(["running", "complete", "error"]),
  progress: z.unknown().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable()
}).passthrough();

const figmaSendResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable().optional(),
  pairingCode: z.string().regex(/^\d{6}$/).optional(),
  expiresAt: z.string().optional(),
  screenCount: z.number().int().nonnegative().optional(),
  requiresPairing: z.boolean().optional(),
  fileName: z.string().optional(),
  fileKey: z.string().optional(),
  missing: z.array(z.string()).optional(),
  missingReasons: z.array(z.string()).optional(),
  dropped: z.array(z.string()).optional(),
  substitutedFonts: z.array(z.string()).optional()
}).passthrough();

const figmaSyncStatusSchema = z.object({
  state: z.enum(["waiting", "running", "complete", "error", "expired"]),
  expiresAt: z.string().optional(),
  createdCount: z.number().int().nonnegative().optional(),
  reusedCount: z.number().int().nonnegative().optional(),
  renderedCount: z.number().int().nonnegative().optional(),
  substitutedFonts: z.array(z.string()).optional(),
  message: z.string().nullable().optional()
}).passthrough();

const paperCopyResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable().optional(),
  screens: z.array(z.string()).optional(),
  missing: z.array(z.string()).optional(),
  dropped: z.array(z.string()).optional()
}).passthrough();

const paperPushResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable().optional(),
  created: z.array(z.string()).optional(),
  updated: z.array(z.string()).optional(),
  failed: z.array(z.object({ name: z.string(), reason: z.string() })).optional(),
  fileName: z.string().nullable().optional(),
  missing: z.array(z.string()).optional(),
  dropped: z.array(z.string()).optional()
}).passthrough();

const preparedReviewSchema = z.object({
  inventoryId: z.string().regex(/^[a-f0-9]{16}$/),
  screenId: z.string().min(1).max(200),
  url: z.string().url(),
  hasEditableLayers: z.boolean()
});

const imageBlockSchema = z.object({
  type: z.literal("image"),
  data: z.string().min(1),
  mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i)
});

const pageDocumentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("layers"),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    layerTree: z.object({
      width: z.number().finite().positive().max(100_000),
      height: z.number().finite().positive().max(100_000),
      tree: z.record(z.string(), z.unknown())
    }),
    dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(30_000_000).optional()
  }),
  z.object({
    kind: z.literal("image"),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(30_000_000)
  })
]);

const pageDocumentToolResultSchema = z.object({
  _meta: z.object({
    "crank/pageDocument": pageDocumentSchema
  }).passthrough()
}).passthrough();

const toolResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional()
}).passthrough();

const displayModeResultSchema = z.object({
  mode: z.enum(["inline", "fullscreen", "pip"])
}).passthrough();

const openLinkResultSchema = z.object({
  isError: z.boolean().optional()
}).passthrough();

const hostContextSchema = z.object({
  displayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
  maxHeight: z.number().finite().positive().optional(),
  safeArea: z.object({
    top: z.number().finite().nonnegative().optional(),
    right: z.number().finite().nonnegative().optional(),
    bottom: z.number().finite().nonnegative().optional(),
    left: z.number().finite().nonnegative().optional()
  }).passthrough().optional()
}).passthrough();

const hostGlobalsEventSchema = z.object({
  globals: hostContextSchema
}).passthrough();

export type DisplayMode = z.infer<typeof displayModeResultSchema>["mode"];

let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
const initialHostContext = hostContextSchema.safeParse(window.openai);
let currentHostLayout: HostLayout = {
  mode: initialHostContext.success && initialHostContext.data.displayMode
    ? initialHostContext.data.displayMode
    : "inline",
  revision: 0
};
const hostLayoutListeners = new Set<(layout: HostLayout) => void>();
document.documentElement.dataset.displayMode = currentHostLayout.mode;

function updateHostLayout(mode?: DisplayMode) {
  currentHostLayout = advanceHostLayout(currentHostLayout, mode);
  document.documentElement.dataset.displayMode = currentHostLayout.mode;
  for (const receive of hostLayoutListeners) receive({ ...currentHostLayout });
}

function postRequest(method: string, params: unknown) {
  const id = ++sequence;
  const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return promise;
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.method === "ui/notifications/host-context-changed") {
    const context = hostContextSchema.safeParse(message.params);
    // Geometry can finish changing after the mode already says fullscreen.
    // Repeated modes and height-only notifications must therefore repaint too.
    if (context.success) updateHostLayout(context.data.displayMode);
    return;
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.id !== "number") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message || "The Codex host rejected the request."));
  else request.resolve(message.result);
});

window.addEventListener("openai:set_globals", (event) => {
  // ChatGPT and Codex publish host globals through a DOM CustomEvent. The
  // JSON-RPC notification above remains necessary for MCP Apps hosts, while
  // this path is what survives Codex moving an iframe into its fullscreen
  // surface. Missing it left the document fitted to the old inline bounds
  // until a later window resize happened to wake the renderer.
  const parsed = hostGlobalsEventSchema.safeParse((event as CustomEvent<unknown>).detail);
  if (parsed.success) updateHostLayout(parsed.data.globals.displayMode);
});

function unwrapResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.result && typeof record.result === "object") return unwrapResult(record.result);
  return value;
}

function structured<T>(value: unknown, schema: z.ZodType<T>): T | null {
  const unwrapped = unwrapResult(value);
  if (!unwrapped || typeof unwrapped !== "object") return null;
  const record = unwrapped as Record<string, unknown>;
  const candidate = record.structuredContent && typeof record.structuredContent === "object"
    ? record.structuredContent
    : record;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function canvasPayload(value: unknown): CanvasPayload | null {
  const parsed = structured(value, canvasPayloadSchema);
  return parsed ? { ...parsed, exportSettings: parsed.exportSettings ?? { figmaUrl: null } } : null;
}

async function callTool(name: string, args: Record<string, unknown>) {
  // Codex currently exposes the compatibility call directly. The standard
  // tools/call bridge remains the portable path for every other MCP Apps host.
  if (window.openai?.callTool) return window.openai.callTool(name, args);
  if (window.parent !== window) {
    return postRequest("tools/call", { name, arguments: args });
  }
  throw new Error("No MCP Apps host is available.");
}

export function initialPayload(): CanvasPayload | null {
  return canvasPayload(window.openai?.toolOutput);
}

export function onToolPayload(receive: (payload: CanvasPayload) => void) {
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.method !== "ui/notifications/tool-result") return;
    const payload = canvasPayload(message.params);
    if (payload) receive(payload);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export async function loadPagePreview(inventoryId: string, pageId: string) {
  const raw = unwrapResult(await callTool("get_page_image", { inventory_id: inventoryId, page_id: pageId }));
  const result = toolResultSchema.parse(raw);
  const image = result.content?.map((block) => imageBlockSchema.safeParse(block)).find((parsed) => parsed.success);
  if (!image?.success) throw new Error("Crank returned no valid preview image.");
  return `data:${image.data.mimeType};base64,${image.data.data}`;
}

export async function loadPageDocument(inventoryId: string, pageId: string): Promise<PageDocument> {
  const raw = unwrapResult(await callTool("get_page_document", { inventory_id: inventoryId, page_id: pageId }));
  return pageDocumentToolResultSchema.parse(raw)._meta["crank/pageDocument"];
}

export async function prepareReview(inventoryId: string, screenId: string, locale: "en" | "zh-CN"): Promise<PreparedReview> {
  const result = await callTool("open_crank_review", {
    inventory_id: inventoryId,
    screen_id: screenId,
    locale
  });
  const prepared = structured<PreparedReview>(result, preparedReviewSchema);
  if (!prepared) throw new Error("Crank returned no valid Browser review target.");
  const target = new URL(prepared.url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error("Crank review targets must remain on the local loopback server.");
  }
  return prepared;
}

export async function startFigmaSend(inventoryId: string, figmaUrl: string, pageIds?: string[]): Promise<CrankJob> {
  const result = await callTool("send_to_figma", {
    inventory_id: inventoryId,
    figma_url: figmaUrl,
    ...(pageIds ? { page_ids: pageIds } : {})
  });
  const job = structured<CrankJob>(result, jobSchema);
  if (!job) throw new Error("Crank returned no valid Figma preparation job.");
  return job;
}

export async function startRepositoryRescan(repoPath: string): Promise<CrankJob> {
  const result = await callTool("sync_from_code", { repo_path: repoPath });
  const job = structured<CrankJob>(result, jobSchema);
  if (!job) throw new Error("Crank returned no valid rescan job.");
  return job;
}

export async function openRepositoryCanvas(repoPath: string): Promise<CanvasPayload> {
  const result = canvasPayload(await callTool("open_crank_canvas", { repo_path: repoPath }));
  if (!result) throw new Error("Crank returned no valid canvas after rescanning.");
  return result;
}

export async function loadJob(jobId: string): Promise<CrankJob> {
  const result = await callTool("get_job", { job_id: jobId });
  const job = structured<CrankJob>(result, jobSchema);
  if (!job) throw new Error("Crank returned no valid job state.");
  return job;
}

export function figmaSendResult(value: unknown): FigmaSendResult {
  return figmaSendResultSchema.parse(value);
}

export async function loadFigmaSyncStatus(pairingCode: string): Promise<FigmaSyncStatus> {
  const result = await callTool("get_figma_sync_status", { pairing_code: pairingCode });
  const status = structured<FigmaSyncStatus>(result, figmaSyncStatusSchema);
  if (!status) throw new Error("Crank returned no valid Figma sync status.");
  return status;
}

export async function copyForPaper(inventoryId: string, title: string, pageIds?: string[]): Promise<PaperCopyResult> {
  const result = await callTool("copy_for_paper", {
    inventory_id: inventoryId,
    title,
    ...(pageIds ? { page_ids: pageIds } : {})
  });
  const copied = structured<PaperCopyResult>(result, paperCopyResultSchema);
  if (!copied) throw new Error("Crank returned no valid Paper copy result.");
  return copied;
}

export async function drawInPaper(inventoryId: string, pageIds?: string[]): Promise<PaperPushResult> {
  const result = await callTool("push_to_paper", {
    inventory_id: inventoryId,
    ...(pageIds ? { page_ids: pageIds } : {})
  });
  const pushed = structured<PaperPushResult>(result, paperPushResultSchema);
  if (!pushed) throw new Error("Crank returned no valid Paper push result.");
  return pushed;
}

export async function openReviewInCodex(review: PreparedReview) {
  // The native Annotation overlay belongs to Codex Browser, not the sandboxed
  // widget. Ask the host to open the source-linked review URL directly so the
  // user lands on the annotatable surface without an intermediate chat turn.
  if (window.parent !== window) {
    try {
      const result = openLinkResultSchema.parse(unwrapResult(
        await postRequest("ui/open-link", { url: review.url })
      ));
      if (!result.isError) return;
    } catch {
      // Older ChatGPT hosts expose only the compatibility method below.
    }
  }
  if (window.openai?.openExternal) {
    await window.openai.openExternal({ href: review.url, redirectUrl: false });
    return;
  }
  throw new Error("The host cannot open the Codex Browser review page.");
}

export async function saveCanvasState(inventoryId: string, intentGraph: AppGraph, scene: {
  layoutVersion: number;
  view: "map" | "screens";
  showPreviews: boolean;
  nodes: Array<{ id: string; x: number; y: number }>;
  selection: CanvasSelection | null;
}) {
  await callTool("save_canvas_state", {
    inventory_id: inventoryId,
    intent_graph: intentGraph,
    scene
  });
}

export async function updateModelContext(annotations: CrankVisualAnnotation[]) {
  if (window.parent === window) return false;
  const parsedAnnotations = z.array(visualAnnotationSchema).max(100).parse(annotations);
  const annotationLabel = formatCrankAnnotationContext(parsedAnnotations);
  try {
    await postRequest("ui/update-model-context", {
      // Selection is already durable in .crank/scene.json and Codex reads it
      // through get_selection when the user says "this". Mirroring every
      // pointer click here made ordinary canvas use inject verbose IDs into the
      // next chat message. Only deliberately staged comments belong here; UI
      // persistence must not use setWidgetState either because Codex can attach
      // that snapshot to the user's next turn.
      content: annotationLabel ? [{ type: "text", text: annotationLabel }] : [],
      structuredContent: annotationLabel ? { crankAnnotations: parsedAnnotations } : {}
    });
    return true;
  } catch {
    return false;
  }
}

export async function requestFullscreen() {
  // Display mode is part of the MCP Apps protocol. Codex exposes that
  // protocol through the parent frame and does not install window.openai, so
  // relying on the ChatGPT compatibility API made this button silently inert.
  if (window.parent !== window) {
    try {
      const result = displayModeResultSchema.parse(unwrapResult(
        await postRequest("ui/request-display-mode", { mode: "fullscreen" })
      ));
      updateHostLayout(result.mode);
      return result.mode === "fullscreen";
    } catch {
      // Older hosts may only expose the ChatGPT compatibility method below.
    }
  }
  if (!window.openai?.requestDisplayMode) return false;
  const result = displayModeResultSchema.parse(unwrapResult(
    await window.openai.requestDisplayMode({ mode: "fullscreen" })
  ));
  updateHostLayout(result.mode);
  return result.mode === "fullscreen";
}

export function initialHostLayout() {
  return { ...currentHostLayout };
}

export function onHostLayoutChange(receive: (layout: HostLayout) => void) {
  hostLayoutListeners.add(receive);
  // A host can announce fullscreen after React reads initialHostLayout but
  // before its effect subscribes. Replaying the snapshot closes that mount
  // race instead of waiting for an unrelated later resize.
  receive({ ...currentHostLayout });
  return () => { hostLayoutListeners.delete(receive); };
}
