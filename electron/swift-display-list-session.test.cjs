const test = require("node:test");
const assert = require("node:assert/strict");
const { createDisplayListServer } = require("./swift-display-list-session.cjs");

const capture = (items, viewport = { width: 200, height: 100 }) => ({ ok: true, viewport, items });

async function withServer(run) {
  // Port 0 lets the OS pick, so tests never collide with a running app or with
  // each other.
  const server = createDisplayListServer({ port: 0 });
  await server.start();
  try {
    await run(server);
  } finally {
    await server.stop();
  }
}

function post(port, endpoint, body, headers = {}) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("a captured screen arrives as a layer tree", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    const response = await post(server.port, endpoint, capture([{
      frame: { x: 0, y: 0, width: 100, height: 40 },
      kind: "text",
      identity: "3",
      text: "Home",
      textStyle: { fontSize: 17, weight: 700 }
    }]), { "x-crank-screen-name": "Home" });
    assert.equal(response.status, 200);

    const [screen] = server.screens(token);
    assert.equal(screen.name, "Home");
    assert.equal(screen.ok, true);
    assert.equal(screen.layerTree.width, 200);
    assert.equal(screen.layerTree.tree.children[0].text, "Home");
  });
});

test("a screen the agent could not read is kept, with its reason", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    await post(server.port, endpoint, { ok: false, reason: "the renderer has drawn no display list yet" });
    const [screen] = server.screens(token);
    assert.equal(screen.ok, false);
    assert.match(screen.reason, /no display list/);
    assert.equal(screen.layerTree, null);
  });
});

test("a capture that does not validate is refused, and the session survives it", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    const bad = await post(server.port, endpoint, { ok: true, viewport: { width: -1, height: 10 }, items: [] });
    assert.equal(bad.status, 400);
    assert.equal(server.screens(token).length, 0);

    const good = await post(server.port, endpoint, capture([]));
    assert.equal(good.status, 200);
    assert.equal(server.screens(token).length, 1);
  });
});

test("an unknown token is not a way to reach another session", async () => {
  await withServer(async (server) => {
    server.beginSession("/tmp/project");
    const response = await post(
      server.port,
      `http://127.0.0.1:${server.port}/v1/crank-display-list/${"f".repeat(48)}/screen`,
      capture([])
    );
    assert.equal(response.status, 404);
  });
});

test("a screen with no name is numbered rather than left blank", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    await post(server.port, endpoint, capture([]));
    assert.equal(server.screens(token)[0].name, "Screen 1");
  });
});

test("waiting returns once the app has stopped sending", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    await post(server.port, endpoint, capture([]));
    const screens = await server.waitForScreens(token, { timeoutMs: 5_000, settleMs: 150 });
    assert.equal(screens.length, 1);
  });
});

test("an ended session no longer accepts captures", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    server.endSession(token);
    const response = await post(server.port, endpoint, capture([]));
    assert.equal(response.status, 404);
  });
});

test("a screen carries the picture the app drew of itself", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    await post(server.port, endpoint, { ...capture([]), screenshot: "iVBORw0KGgo=" });
    const [screen] = server.screens(token);
    assert.equal(screen.thumbnail.dataUrl, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(screen.thumbnail.width, 200);
    assert.equal(screen.thumbnail.height, 100);
  });
});

test("a screen with no picture is a page without one, not a page without layers", async () => {
  await withServer(async (server) => {
    const { token, endpoint } = server.beginSession("/tmp/project");
    await post(server.port, endpoint, capture([]));
    const [screen] = server.screens(token);
    assert.equal(screen.thumbnail, null);
    assert.ok(screen.layerTree);
  });
});
