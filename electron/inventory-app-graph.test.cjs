const test = require("node:test");
const assert = require("node:assert/strict");

test("a stored inventory becomes the same route and action graph in every Crank surface", async () => {
  const { buildInventoryAppGraph } = await import("../shared/inventory-app-graph.js");
  const inventory = {
    ok: true,
    source: { kind: "folder", target: "/Examples/Transfer" },
    pages: [
      { id: "home", name: "Home", route: "/", recipe: [], snapshot: { links: [{ href: "/review", label: "Review" }] } },
      { id: "review", name: "Review", route: "/review", recipe: [], snapshot: { links: [] } },
      { id: "amount", name: "Amount", route: "/", recipe: [{ kind: "click", locator: "#amount", label: "Enter amount" }], snapshot: { links: [] } }
    ]
  };
  const graph = buildInventoryAppGraph(inventory, { inventoryId: "0123456789abcdef" });
  assert.equal(graph.project.name, "Transfer");
  assert.equal(graph.project.inventoryId, "0123456789abcdef");
  assert.deepEqual(graph.edges.map((edge) => [edge.fromScreenId, edge.toScreenId, edge.trigger.type]), [
    ["home", "review", "route"],
    ["home", "amount", "click"]
  ]);
});

