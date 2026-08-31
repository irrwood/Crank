const assert = require("node:assert/strict");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

function hostWindow(openai) {
  const listeners = new Map();
  const target = {
    openai,
    parent: null,
    addEventListener(type, receive) {
      const entries = listeners.get(type) ?? [];
      entries.push(receive);
      listeners.set(type, entries);
    },
    dispatch(type, event) {
      for (const receive of listeners.get(type) ?? []) receive(event);
    }
  };
  target.parent = target;
  return target;
}

async function importBridge(label) {
  const url = pathToFileURL(path.join(__dirname, "..", "codex", "src", "bridge.ts"));
  url.searchParams.set("test", `${label}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("the Codex host global seeds fullscreen and every later layout is replayed", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const fakeWindow = hostWindow({ displayMode: "fullscreen", maxHeight: 900 });
  const documentElement = { dataset: {} };
  globalThis.window = fakeWindow;
  globalThis.document = { documentElement };

  try {
    const bridge = await importBridge("initial-global");
    assert.deepEqual(bridge.initialHostLayout(), { mode: "fullscreen", revision: 0 });
    assert.equal(documentElement.dataset.displayMode, "fullscreen");

    // React subscribes in an effect, after its initial render. The store must
    // replay a notification that arrived in that gap.
    const received = [];
    const unsubscribe = bridge.onHostLayoutChange((layout) => received.push(layout));
    assert.deepEqual(received, [{ mode: "fullscreen", revision: 0 }]);

    fakeWindow.dispatch("openai:set_globals", {
      detail: { globals: { maxHeight: 960 } }
    });
    fakeWindow.dispatch("openai:set_globals", {
      detail: { globals: { displayMode: "inline" } }
    });
    assert.deepEqual(received.slice(1), [
      { mode: "fullscreen", revision: 1 },
      { mode: "inline", revision: 2 }
    ]);
    assert.equal(documentElement.dataset.displayMode, "inline");
    unsubscribe();
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("a fullscreen acknowledgement does not swallow the final Codex layout event", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const fakeWindow = hostWindow(undefined);
  const parent = {
    postMessage(message) {
      queueMicrotask(() => fakeWindow.dispatch("message", {
        source: parent,
        data: { jsonrpc: "2.0", id: message.id, result: { mode: "fullscreen" } }
      }));
    }
  };
  fakeWindow.parent = parent;
  globalThis.window = fakeWindow;
  globalThis.document = { documentElement: { dataset: {} } };

  try {
    const bridge = await importBridge("late-global");
    const received = [];
    bridge.onHostLayoutChange((layout) => received.push(layout));

    assert.equal(await bridge.requestFullscreen(), true);
    fakeWindow.dispatch("openai:set_globals", {
      detail: { globals: { displayMode: "fullscreen", maxHeight: 980 } }
    });
    assert.deepEqual(received, [
      { mode: "inline", revision: 0 },
      { mode: "fullscreen", revision: 1 },
      { mode: "fullscreen", revision: 2 }
    ]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
