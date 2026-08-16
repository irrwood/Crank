const { z } = require("zod");

const vectorEffectFrameSchema = z.object({
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().positive().max(10000),
  height: z.number().finite().positive().max(10000)
}).strict();

const vectorEffectSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_:/.-]{1,600}$/),
  syncId: z.string().regex(/^[A-Za-z0-9_:/.-]{1,500}$/),
  type: z.enum(["DROP_SHADOW", "LAYER_BLUR"]),
  frame: vectorEffectFrameSchema,
  radius: z.number().finite().positive().max(240),
  colorToken: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  offset: z.object({
    x: z.number().finite().min(-4000).max(4000),
    y: z.number().finite().min(-4000).max(4000)
  }).strict().optional()
}).strict();

const sourceVectorEffectSchema = z.object({
  id: z.string().regex(/^swift\/[a-f0-9]{16}\/(?:shadow|blur)$/),
  syncId: z.string().regex(/^swift\/[a-f0-9]{16}$/),
  sourceFile: z.string().min(1).max(500),
  sourceName: z.string().min(1).max(160),
  type: z.enum(["DROP_SHADOW", "LAYER_BLUR"]),
  radius: z.number().finite().positive().max(240),
  colorToken: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  offset: z.object({
    x: z.number().finite().min(-4000).max(4000),
    y: z.number().finite().min(-4000).max(4000)
  }).strict().optional()
}).strict();

function collectSwiftVectorEffects(root, eligibleEffectIds = null) {
  const effects = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const frame = node.runtimeFrame;
    const syncId = typeof node.syncId === "string" ? node.syncId : null;
    if (syncId && frame && Number(node.shadowRadius) > 0) {
      const id = `${syncId}/shadow`;
      if (!seen.has(id) && (!eligibleEffectIds || eligibleEffectIds.has(id))) {
        effects.push(vectorEffectSchema.parse({
          id,
          syncId,
          type: "DROP_SHADOW",
          frame,
          radius: node.shadowRadius,
          colorToken: node.shadowColorToken || "black",
          opacity: node.shadowOpacity ?? 0.33,
          offset: { x: node.shadowX ?? 0, y: node.shadowY ?? 0 }
        }));
        seen.add(id);
      }
    }
    if (syncId && frame && Number(node.blurRadius) > 0) {
      const id = `${syncId}/blur`;
      if (!seen.has(id) && (!eligibleEffectIds || eligibleEffectIds.has(id))) {
        effects.push(vectorEffectSchema.parse({
          id,
          syncId,
          type: "LAYER_BLUR",
          frame,
          radius: node.blurRadius
        }));
        seen.add(id);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return effects;
}

function resolveCapturedSwiftVectorEffects(sourceEffects, snapshot, pageSourceName, coordinateSpace = null) {
  const captures = new Map((snapshot?.nodes ?? [])
    .filter((node) => !pageSourceName || node.pageSourceName === pageSourceName)
    .map((node) => [node.syncId, node]));
  const origin = coordinateSpace ?? snapshot?.environment?.viewport ?? { x: 0, y: 0, width: 1, height: 1 };
  const scaleX = coordinateSpace?.outputWidth ? coordinateSpace.outputWidth / origin.width : 1;
  const scaleY = coordinateSpace?.outputHeight ? coordinateSpace.outputHeight / origin.height : 1;
  return (sourceEffects ?? []).flatMap((candidate) => {
    const effect = sourceVectorEffectSchema.parse(candidate);
    const capture = captures.get(effect.syncId);
    if (!capture?.frame || capture.frame.width <= 0 || capture.frame.height <= 0) return [];
    return [vectorEffectSchema.parse({
      id: effect.id,
      syncId: effect.syncId,
      type: effect.type,
      frame: {
        x: (capture.frame.x - origin.x) * scaleX,
        y: (capture.frame.y - origin.y) * scaleY,
        width: capture.frame.width * scaleX,
        height: capture.frame.height * scaleY
      },
      radius: effect.radius * Math.max(scaleX, scaleY),
      ...(effect.colorToken ? { colorToken: effect.colorToken } : {}),
      ...(effect.opacity !== undefined ? { opacity: effect.opacity } : {}),
      ...(effect.offset ? { offset: { x: effect.offset.x * scaleX, y: effect.offset.y * scaleY } } : {})
    })];
  });
}

module.exports = { collectSwiftVectorEffects, resolveCapturedSwiftVectorEffects, sourceVectorEffectSchema, vectorEffectSchema };
