const http = require("node:http");
const { randomInt } = require("node:crypto");
const { z } = require("zod");
const { uiNodeSchema } = require("./swiftui-ir.cjs");
const { pdfTextRunSchema } = require("./swift-pdf-text.cjs");
const { nativeShadowSchema } = require("./svg-native-shadows.cjs");
const { vectorEffectSchema } = require("./swift-vector-effects.cjs");

const DEFAULT_PORT = 38457;
const JOB_TTL_MS = 15 * 60 * 1000;
const connectionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

const baseScreenSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  name: z.string().min(1).max(160),
  sourceType: z.enum(["screen", "modal"]),
  currentNodeId: z.string().regex(/^\d+:\d+$/).nullable()
});
const domBoundsSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_:/-]{1,500}$/),
  selector: z.string().min(1).max(240).nullable(),
  x: z.number().finite().min(-40000).max(40000),
  y: z.number().finite().min(-40000).max(40000),
  width: z.number().finite().min(0.5).max(40000),
  height: z.number().finite().min(0.5).max(40000),
  name: z.string().min(1).max(100)
});
const cssColorSchema = z.string().min(1).max(80);
const textLineRectSchema = z.object({
  x: z.number().finite().min(-40000).max(40000),
  y: z.number().finite().min(-40000).max(40000),
  width: z.number().finite().min(0).max(40000),
  height: z.number().finite().min(0).max(40000)
}).strict();
const domNodeSchema = z.lazy(() => z.discriminatedUnion("kind", [
  domBoundsSchema.extend({
    kind: z.literal("element"),
    style: z.object({
      backgroundColor: cssColorSchema,
      borderTopColor: cssColorSchema,
      borderRightColor: cssColorSchema,
      borderBottomColor: cssColorSchema,
      borderLeftColor: cssColorSchema,
      borderTopWidth: z.number().finite().min(0).max(100),
      borderRightWidth: z.number().finite().min(0).max(100),
      borderBottomWidth: z.number().finite().min(0).max(100),
      borderLeftWidth: z.number().finite().min(0).max(100),
      borderRadius: z.number().finite().min(0).max(5000),
      opacity: z.number().finite().min(0).max(1),
      clipsContent: z.boolean()
    }),
    // A real dashboard has containers with thousands of rows. Refusing them
    // would export a page missing most of its content.
    children: z.array(domNodeSchema).max(6000)
  }),
  domBoundsSchema.extend({
    kind: z.literal("text"),
    text: z.string().min(1).max(4000),
    style: z.object({
      color: cssColorSchema,
      fontSize: z.number().finite().min(1).max(400),
      fontWeight: z.number().int().min(100).max(1000),
      lineHeight: z.number().finite().min(1).max(1000),
      letterSpacing: z.number().finite().min(-100).max(100),
      textAlign: z.enum(["left", "center", "right", "justify"]),
      fontFamilies: z.array(z.string().min(1).max(160)).min(1).max(20).optional(),
      resolvedFontFamily: z.string().min(1).max(160).optional(),
      // Families the page asked for that the capture could not render, so its
      // measured widths and line breaks describe a fallback.
      unavailableFonts: z.array(z.string().min(1).max(160)).max(12).optional(),
      fontStyle: z.enum(["normal", "italic", "oblique"]).optional(),
      fontStretch: z.string().min(1).max(80).optional(),
      whiteSpace: z.string().min(1).max(80).optional(),
      wordBreak: z.string().min(1).max(80).optional(),
      overflowWrap: z.string().min(1).max(80).optional(),
      direction: z.enum(["ltr", "rtl"]).optional(),
      writingMode: z.string().min(1).max(80).optional()
    }),
    sourceText: z.string().max(4000).optional(),
    wrapMode: z.enum(["nowrap", "wrap", "explicit"]).optional(),
    lineCount: z.number().int().min(1).max(1000).optional(),
    lineRects: z.array(textLineRectSchema).min(1).max(1000).optional(),
    lineBreakOffsets: z.array(z.number().int().min(1).max(3999)).max(999).optional(),
    layoutWidth: z.number().finite().min(0.5).max(40000).optional(),
    layoutX: z.number().finite().min(-40000).max(40000).optional()
  }),
  domBoundsSchema.extend({ kind: z.literal("svg"), svg: z.string().min(1).max(250000) }),
  domBoundsSchema.extend({ kind: z.literal("image"), dataUrl: z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,/).max(8_000_000) })
]));
const screenSchema = z.discriminatedUnion("renderMode", [
  baseScreenSchema.extend({
    renderMode: z.literal("structured"),
    uiTree: uiNodeSchema,
    visualReferenceAssetId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).nullable().optional(),
    vectorSvg: z.string().min(1).max(2_500_000).nullable().optional(),
    vectorFallbackSvg: z.string().min(1).max(2_500_000).nullable().optional(),
    vectorNativeShadows: z.array(nativeShadowSchema).max(2000).optional(),
    vectorEffects: z.array(vectorEffectSchema).max(2000).optional(),
    vectorTextMode: z.enum(["pdf-glyphs", "editable-pdf", "editable-runtime"]).nullable().optional(),
    vectorTextRuns: z.array(pdfTextRunSchema).max(2000).optional(),
    systemTabBar: z.object({
      designKit: z.string().regex(/^iOS \d+$/).optional(),
      appearance: z.enum(["classic", "liquid-glass"]).optional(),
      selectedIndex: z.number().int().nonnegative().max(20),
      items: z.array(z.object({
        title: z.string().min(1).max(120),
        systemImage: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/)
      }).strict()).min(2).max(20)
    }).strict().nullable().optional(),
    semanticAutoLayout: z.boolean().optional()
  }),
  baseScreenSchema.extend({
    renderMode: z.literal("editable-dom"),
    width: z.number().int().min(320).max(40000),
    height: z.number().int().min(320).max(40000),
    domTree: domNodeSchema
  }),
  baseScreenSchema.extend({
    renderMode: z.literal("snapshot"),
    width: z.number().int().min(320).max(40000),
    height: z.number().int().min(320).max(40000)
  })
]);

const publicJobSchema = z.object({
  operation: z.enum(["push", "pull"]).default("push"),
  projectId: z.string().regex(/^[a-f0-9]{24}$/),
  projectName: z.string().min(1).max(160),
  figmaFileName: z.string().min(1).max(240),
  screens: z.array(screenSchema).min(1).max(120)
});

const figmaDomNodeSnapshotSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_:/-]{1,500}$/),
  selector: z.string().min(1).max(240).nullable(),
  kind: z.enum(["element", "text", "svg", "image"]),
  width: z.number().finite().min(0).max(40000),
  height: z.number().finite().min(0).max(40000),
  backgroundColor: z.string().max(80).nullable(),
  radius: z.number().finite().min(0).max(5000).nullable(),
  fontSize: z.number().finite().min(0).max(400).nullable(),
  fontWeight: z.number().int().min(0).max(1000).nullable(),
  text: z.string().max(4000).nullable()
});
const screenSnapshotSchema = z.object({
  screenId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  nodes: z.array(figmaDomNodeSnapshotSchema).max(5000)
});
const pushCompletionSchema = z.object({
  operation: z.literal("push").optional(),
  fileName: z.string().min(1).max(240),
  mappings: z.array(z.object({
    screenId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    nodeId: z.string().regex(/^\d+:\d+$/),
    frameName: z.string().min(1).max(240),
    disposition: z.enum(["created", "reused"]),
    contentDisposition: z.enum(["rendered", "reused", "preserved"])
  })).min(1).max(120),
  screens: z.array(screenSnapshotSchema).min(1).max(120).optional()
});
const pullCompletionSchema = z.object({
  operation: z.literal("pull"),
  fileName: z.string().min(1).max(240),
  screens: z.array(screenSnapshotSchema).min(1).max(120)
});
const completionSchema = z.union([pushCompletionSchema, pullCompletionSchema]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendPng(response, payload) {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Length": payload.length,
    "Content-Type": "image/png"
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createPairingCode(jobs) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(randomInt(100000, 1000000));
    if (!jobs.has(code)) return code;
  }
  throw new Error("Could not create a pairing code");
}

function normalizedName(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function createFigmaBridge({ port = DEFAULT_PORT, onComplete, onDisconnect = async () => {} }) {
  const jobs = new Map();
  const jobsByConnection = new Map();
  let server = null;

  function publicStatus(job) {
    if (!job) return { state: "expired" };
    if (job.expiresAt <= Date.now() && !["complete", "error"].includes(job.state)) {
      job.state = "expired";
    }
    return {
      state: job.state,
      expiresAt: new Date(job.expiresAt).toISOString(),
      createdCount: job.createdCount ?? 0,
      reusedCount: job.reusedCount ?? 0,
      renderedCount: job.renderedCount ?? 0,
      message: job.message ?? null,
      pullPreview: job.pullPreview ?? null
    };
  }

  const requestHandler = async (request, response) => {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    const match = url.pathname.match(/^\/v1\/jobs\/(\d{6})(\/complete)?$/);
    const assetMatch = url.pathname.match(/^\/v1\/jobs\/(\d{6})\/assets\/([A-Za-z0-9_-]{1,120})\.png$/);
    const connectionMatch = url.pathname.match(/^\/v1\/connections\/([a-f0-9]{64})\/(job|disconnect)$/);
    if (!match && !assetMatch && !connectionMatch) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method === "GET" && assetMatch) {
      const assetJob = jobs.get(assetMatch[1]);
      const asset = assetJob?.assets?.get(assetMatch[2]);
      if (!assetJob || assetJob.expiresAt <= Date.now() || !asset?.buffer) {
        sendJson(response, 404, { error: "Snapshot not found" });
        return;
      }
      sendPng(response, asset.buffer);
      return;
    }
    if (assetMatch) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (request.method === "POST" && connectionMatch?.[2] === "disconnect") {
      const token = connectionTokenSchema.parse(connectionMatch[1]);
      await onDisconnect(token);
      jobsByConnection.delete(token);
      sendJson(response, 200, { disconnected: true });
      return;
    }

    if (request.method === "GET" && connectionMatch?.[2] === "job") {
      const token = connectionTokenSchema.parse(connectionMatch[1]);
      const fileName = z.string().min(1).max(240).parse(url.searchParams.get("fileName"));
      const pairingCode = [...(jobsByConnection.get(token) ?? [])].reverse().find((code) => {
        const candidate = jobs.get(code);
        return candidate && candidate.expiresAt > Date.now() && !["complete", "error", "expired"].includes(candidate.state)
          && normalizedName(candidate.publicJob.figmaFileName) === normalizedName(fileName);
      });
      const connectedJob = pairingCode ? jobs.get(pairingCode) : null;
      if (!connectedJob || connectedJob.expiresAt <= Date.now() || ["complete", "error", "expired"].includes(connectedJob.state)) {
        response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      connectedJob.state = "running";
      sendJson(response, 200, { ...connectedJob.publicJob, pairingCode });
      return;
    }
    if (connectionMatch) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const code = match[1];
    const job = jobs.get(code);
    if (!job || job.expiresAt <= Date.now()) {
      if (job) job.state = "expired";
      sendJson(response, 404, { error: "Pairing code expired" });
      return;
    }

    if (request.method === "GET" && !match[2]) {
      job.state = "running";
      sendJson(response, 200, { ...job.publicJob, connectionToken: job.connectionToken });
      return;
    }

    if (request.method === "POST" && match[2]) {
      try {
        const result = completionSchema.parse(await readJson(request));
        const expectedIds = new Set(job.publicJob.screens.map((screen) => screen.id));
        const returnedScreens = "mappings" in result ? result.mappings : result.screens;
        if (returnedScreens.length !== expectedIds.size || returnedScreens.some((entry) => !expectedIds.has(entry.screenId))) {
          throw new Error("Plugin result does not match the requested screens");
        }
        if (new Set(returnedScreens.map((entry) => entry.screenId)).size !== expectedIds.size) {
          throw new Error("Plugin result contains duplicate screens");
        }
        const completionData = await onComplete(job.context, result);
        job.state = "complete";
        if ("mappings" in result) {
          job.createdCount = result.mappings.filter((mapping) => mapping.disposition === "created").length;
          job.reusedCount = result.mappings.filter((mapping) => mapping.disposition === "reused").length;
          job.renderedCount = result.mappings.filter((mapping) => mapping.contentDisposition === "rendered").length;
        } else {
          job.pullPreview = completionData?.pullPreview ?? null;
          job.renderedCount = result.screens.length;
        }
        sendJson(response, 200, publicStatus(job));
      } catch (error) {
        job.state = "error";
        job.message = error instanceof Error ? error.message : "Mapping could not be saved";
        sendJson(response, 400, { error: job.message });
      }
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  };

  return {
    async start() {
      if (server) return;
      server = http.createServer((request, response) => {
        void requestHandler(request, response).catch((error) => {
          sendJson(response, 500, { error: error instanceof Error ? error.message : "Bridge error" });
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "localhost", resolve);
      });
    },
    enqueue(publicJob, context, connectionToken, assets = new Map()) {
      const safeJob = publicJobSchema.parse(publicJob);
      const safeConnectionToken = connectionTokenSchema.parse(connectionToken);
      const safeAssets = assets instanceof Map ? assets : new Map();
      for (const screen of safeJob.screens) {
        if (screen.renderMode === "snapshot" && !safeAssets.get(screen.id)?.buffer) {
          throw new Error(`Missing snapshot for ${screen.name}`);
        }
      }
      const code = createPairingCode(jobs);
      const expiresAt = Date.now() + JOB_TTL_MS;
      jobs.set(code, { publicJob: safeJob, context, expiresAt, state: "waiting", connectionToken: safeConnectionToken, assets: safeAssets });
      if (!jobsByConnection.has(safeConnectionToken)) jobsByConnection.set(safeConnectionToken, new Set());
      jobsByConnection.get(safeConnectionToken).add(code);
      return {
        pairingCode: code,
        expiresAt: new Date(expiresAt).toISOString(),
        screenCount: safeJob.screens.length
      };
    },
    getStatus(code) {
      return publicStatus(jobs.get(z.string().regex(/^\d{6}$/).parse(code)));
    },
    async stop() {
      if (!server) return;
      const activeServer = server;
      server = null;
      await new Promise((resolve) => activeServer.close(resolve));
    },
    get port() {
      const address = server?.address();
      return address && typeof address === "object" ? address.port : port;
    }
  };
}

module.exports = { DEFAULT_PORT, createFigmaBridge };
