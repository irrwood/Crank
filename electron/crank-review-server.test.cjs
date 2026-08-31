const test = require("node:test");
const assert = require("node:assert/strict");
const { createCrankReviewServer, renderReviewDocument } = require("./crank-review-server.cjs");

const inventoryId = "0123456789abcdef";
const document = {
  kind: "layers",
  width: 320,
  height: 180,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  layerTree: {
    width: 320,
    height: 180,
    tree: {
      kind: "element", id: "root", name: "CheckoutView", source: "src/Checkout.tsx:10:3",
      x: 0, y: 0, width: 320, height: 180, style: {},
      children: [{
        kind: "text", id: "button-183", name: "CheckoutButton", source: "src/Checkout.tsx:42:7",
        x: 20, y: 30, width: 120, height: 24, text: "Pay now", style: { fontSize: 16, lineHeight: 20 }
      }]
    }
  }
};

test("a Browser review keeps captured layers as source-linked DOM instead of one canvas", async () => {
  const html = await renderReviewDocument({
    inventoryId,
    locale: "en",
    screen: { id: "checkout", name: "Checkout", route: "/checkout" },
    document,
    onSelection() {}
  }, "a".repeat(48));
  assert.match(html, /data-crank-id="button-183"/);
  assert.match(html, /data-crank-layer-id="button-183"/);
  assert.match(html, /data-source="src\/Checkout\.tsx:42:7"/);
  assert.match(html, /data-component="CheckoutButton"/);
  assert.match(html, /class="reference" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(html, /class="vector-overlay is-hit-map"/);
  assert.doesNotMatch(html, /<canvas[\s>]/);
  assert.match(html, /pointerdown/);
});

test("a Browser review keeps captured image layers visible above its reference capture", async () => {
  const html = await renderReviewDocument({
    inventoryId,
    locale: "en",
    screen: { id: "checkout", name: "Checkout" },
    document: {
      ...document,
      layerTree: {
        ...document.layerTree,
        tree: {
          ...document.layerTree.tree,
          children: [{
            kind: "image", id: "hero", name: "Hero", x: 0, y: 0, width: 80, height: 40,
            dataUrl: "data:image/png;base64,iVBORw0KGgo=", style: {}, children: []
          }]
        }
      }
    },
    onSelection() {}
  }, "a".repeat(48));
  assert.match(html, /class="vector-overlay"/);
  assert.doesNotMatch(html, /class="vector-overlay is-hit-map"/);
  assert.match(html, /data-crank-layer-id="hero"/);
});

test("a review hit writes node identity, SourceRef, and pointer position through the validated boundary", async () => {
  const hits = [];
  const review = createCrankReviewServer({ createToken: () => "b".repeat(48) });
  try {
    const opened = await review.open({
      inventoryId,
      locale: "zh-CN",
      screen: { id: "checkout", name: "结账", route: "/checkout" },
      document,
      onSelection(selection) { hits.push(selection); }
    });
    const page = await fetch(opened.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /先选择页面元素/);

    const response = await fetch(`${opened.url}/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        screenId: "checkout",
        nodeId: "button-183",
        name: "CheckoutButton",
        source: "src/Checkout.tsx:42:7",
        pointer: { x: 34.5, y: 48, clientX: 100, clientY: 120 }
      })
    });
    assert.equal(response.status, 204);
    assert.deepEqual(hits, [{
      kind: "node",
      screenId: "checkout",
      nodeId: "button-183",
      name: "CheckoutButton",
      sourceRef: { file: "src/Checkout.tsx", line: 42, column: 7, component: "CheckoutButton" },
      pointer: { x: 34.5, y: 48, clientX: 100, clientY: 120 }
    }]);

    const invalid = await fetch(`${opened.url}/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screenId: "checkout", nodeId: "button-183" })
    });
    assert.equal(invalid.status, 400);
    assert.equal(hits.length, 1);
  } finally {
    await review.close();
  }
});

test("an unknown review token cannot read a prepared screen", async () => {
  const review = createCrankReviewServer({ createToken: () => "c".repeat(48) });
  try {
    const opened = await review.open({
      inventoryId,
      locale: "en",
      screen: { id: "checkout", name: "Checkout" },
      document,
      onSelection() {}
    });
    const target = new URL(opened.url);
    target.pathname = `/review/${"d".repeat(48)}`;
    assert.equal((await fetch(target)).status, 404);
  } finally {
    await review.close();
  }
});
