const assert = require("node:assert/strict");
const test = require("node:test");

test("each screen keeps its own Dagre position in the embedded flow", async () => {
  const { layoutScreenPositions } = await import("../shared/flow-layout.js");
  const ids = ["home", "one", "two", "three"];
  const positions = layoutScreenPositions(ids, [
    { fromScreenId: "home", toScreenId: "one" },
    { fromScreenId: "home", toScreenId: "two" },
    { fromScreenId: "home", toScreenId: "three" }
  ], { width: 228, height: 205, ranksep: 130, nodesep: 74, marginx: 42, marginy: 42 });

  assert.equal(positions.length, ids.length);
  assert.equal(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size, ids.length);
  assert.ok(positions.filter((position) => position.id !== "home").every((position) => position.x > positions[0].x));
});

test("a wide fan-out is a radial hub instead of false sequential ranks", async () => {
  const { layoutScreenPositions } = await import("../shared/flow-layout.js");
  const children = Array.from({ length: 9 }, (_, index) => `child-${index + 1}`);
  const positions = layoutScreenPositions(["home", ...children], children.map((id) => ({
    fromScreenId: "home",
    toScreenId: id
  })), {
    width: 216,
    height: 196,
    ranksep: 130,
    nodesep: 74,
    marginx: 42,
    marginy: 42,
    maxRankRows: 3
  });
  const childPositions = positions.filter(({ id }) => id !== "home");

  const home = positions.find(({ id }) => id === "home");
  const radiusX = Math.max(216 * 2.45, 500);
  const radiusY = Math.max(196 * 1.9, 400);
  const normalizedDistances = childPositions.map(({ x, y }) => Math.hypot((x - home.x) / radiusX, (y - home.y) / radiusY));

  assert.equal(new Set(childPositions.map(({ x, y }) => `${x.toFixed(3)}:${y.toFixed(3)}`)).size, children.length);
  assert.ok(normalizedDistances.every((distance) => Math.abs(distance - 1) < 0.001));
  assert.ok(childPositions.some(({ x }) => x < home.x));
  assert.ok(childPositions.some(({ x }) => x > home.x));
});

test("vertical layout keeps navigation ranks moving downward", async () => {
  const { layoutScreenPositions } = await import("../shared/flow-layout.js");
  const positions = layoutScreenPositions(["home", "details", "done"], [
    { fromScreenId: "home", toScreenId: "details" },
    { fromScreenId: "details", toScreenId: "done" }
  ], {
    width: 216,
    height: 210,
    ranksep: 130,
    nodesep: 74,
    marginx: 42,
    marginy: 42,
    style: "vertical"
  });

  const byId = new Map(positions.map((position) => [position.id, position]));
  assert.ok(byId.get("details").y > byId.get("home").y);
  assert.ok(byId.get("done").y > byId.get("details").y);
});

test("grid layout follows screen order in stable rows", async () => {
  const { layoutScreenPositions } = await import("../shared/flow-layout.js");
  const ids = ["one", "two", "three", "four", "five"];
  const positions = layoutScreenPositions(ids, [], {
    width: 216,
    height: 210,
    ranksep: 130,
    nodesep: 74,
    marginx: 42,
    marginy: 42,
    style: "grid"
  });

  assert.deepEqual(positions, [
    { id: "one", x: 42, y: 42 },
    { id: "two", x: 388, y: 42 },
    { id: "three", x: 734, y: 42 },
    { id: "four", x: 42, y: 326 },
    { id: "five", x: 388, y: 326 }
  ]);
});
