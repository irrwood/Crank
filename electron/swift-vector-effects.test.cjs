const test = require("node:test");
const assert = require("node:assert/strict");
const { collectSwiftVectorEffects, resolveCapturedSwiftVectorEffects, vectorEffectSchema } = require("./swift-vector-effects.cjs");

test("collects source shadow and blur semantics only when a runtime frame exists", () => {
  const effects = collectSwiftVectorEffects({
    type: "zstack",
    syncId: "swift/root",
    runtimeFrame: { x: 0, y: 0, width: 393, height: 852 },
    shadowRadius: 34,
    shadowColorToken: "flowAccent",
    shadowOpacity: 0.08,
    children: [
      {
        type: "circle",
        syncId: "swift/orb",
        runtimeFrame: { x: 100, y: 200, width: 180, height: 180 },
        blurRadius: 12
      },
      { type: "text", syncId: "swift/missing-frame", shadowRadius: 8 }
    ]
  });

  assert.deepEqual(effects, [
    {
      id: "swift/root/shadow",
      syncId: "swift/root",
      type: "DROP_SHADOW",
      frame: { x: 0, y: 0, width: 393, height: 852 },
      radius: 34,
      colorToken: "flowAccent",
      opacity: 0.08,
      offset: { x: 0, y: 0 }
    },
    {
      id: "swift/orb/blur",
      syncId: "swift/orb",
      type: "LAYER_BLUR",
      frame: { x: 100, y: 200, width: 180, height: 180 },
      radius: 12
    }
  ]);
  assert.equal(vectorEffectSchema.safeParse(effects[0]).success, true);
  assert.deepEqual(collectSwiftVectorEffects({
    type: "circle", syncId: "swift/orb", runtimeFrame: { x: 0, y: 0, width: 20, height: 20 }, blurRadius: 8
  }, new Set(["swift/other/blur"])), []);
});

test("resolves source-recorded effects with runtime frames and page coordinates", () => {
  const effects = resolveCapturedSwiftVectorEffects([{
    id: "swift/1111111111111111/shadow",
    syncId: "swift/1111111111111111",
    sourceFile: "Views/Orb.swift",
    sourceName: "Orb",
    type: "DROP_SHADOW",
    radius: 12,
    colorToken: "flowAccent",
    opacity: 0.2,
    offset: { x: 0, y: 6 }
  }], {
    environment: { viewport: { x: 0, y: 0, width: 400, height: 800 } },
    nodes: [{ syncId: "swift/1111111111111111", pageSourceName: "Orb", frame: { x: 100, y: 200, width: 80, height: 80 } }]
  }, "Orb", { x: 0, y: 50, width: 400, height: 700, outputWidth: 400, outputHeight: 700 });
  assert.deepEqual(effects, [{
    id: "swift/1111111111111111/shadow",
    syncId: "swift/1111111111111111",
    type: "DROP_SHADOW",
    frame: { x: 100, y: 150, width: 80, height: 80 },
    radius: 12,
    colorToken: "flowAccent",
    opacity: 0.2,
    offset: { x: 0, y: 6 }
  }]);
});

test("uses the runtime page association so shared backdrop blurs belong to every rendered page", () => {
  const sourceEffect = {
    id: "swift/2222222222222222/blur", syncId: "swift/2222222222222222",
    sourceFile: "Theme.swift", sourceName: "AmbientBackdrop", type: "LAYER_BLUR", radius: 36
  };
  const snapshot = {
    environment: { viewport: { x: 0, y: 0, width: 400, height: 800 } },
    nodes: [
      { syncId: sourceEffect.syncId, pageSourceName: "CaptureView", frame: { x: 90, y: 40, width: 220, height: 220 } },
      { syncId: sourceEffect.syncId, pageSourceName: "SequenceView", frame: { x: 80, y: 60, width: 240, height: 240 } }
    ]
  };
  const effects = resolveCapturedSwiftVectorEffects([sourceEffect], snapshot, "CaptureView");
  assert.equal(effects.length, 1);
  assert.deepEqual(effects[0].frame, { x: 90, y: 40, width: 220, height: 220 });
});
