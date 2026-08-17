const test = require("node:test");
const assert = require("node:assert/strict");
const { createProtocol, listTargets } = require("./cdp-session.cjs");

/** A socket that answers the way a debugging port does. */
function fakeSocket({ reply = () => ({}) } = {}) {
  const listeners = new Map();
  const sent = [];
  const socket = {
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
      const { id, method, params } = JSON.parse(raw);
      const answer = reply(method, params);
      queueMicrotask(() => socket.emit("message", { data: JSON.stringify({ id, ...answer }) }));
    },
    close() { socket.emit("close", {}); },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    emit(name, event) {
      for (const handler of listeners.get(name) ?? []) handler(event);
    }
  };
  return socket;
}

test("pairs each answer with the call that asked for it", async () => {
  const socket = fakeSocket({ reply: (method) => ({ result: { echoed: method } }) });
  const protocol = createProtocol(socket);
  const [one, two] = await Promise.all([protocol.send("Page.enable"), protocol.send("Runtime.enable")]);
  assert.deepEqual(one, { echoed: "Page.enable" });
  assert.deepEqual(two, { echoed: "Runtime.enable" });
  assert.deepEqual(socket.sent.map((message) => message.id), [1, 2], "ids must not be reused");
});

test("a protocol error rejects rather than resolving with nothing", async () => {
  const socket = fakeSocket({ reply: () => ({ error: { message: "No such target" } }) });
  const protocol = createProtocol(socket);
  await assert.rejects(() => protocol.send("Page.navigate"), /No such target/);
});

test("events reach their handler, and are not mistaken for answers", async () => {
  const socket = fakeSocket();
  const protocol = createProtocol(socket);
  const seen = [];
  protocol.on("Fetch.requestPaused", (params) => seen.push(params.requestId));
  socket.emit("message", { data: JSON.stringify({ method: "Fetch.requestPaused", params: { requestId: "r1" } }) });
  socket.emit("message", { data: JSON.stringify({ method: "Fetch.requestPaused", params: { requestId: "r2" } }) });
  assert.deepEqual(seen, ["r1", "r2"]);
});

test("a dropped connection fails the calls waiting on it instead of hanging", async () => {
  const socket = fakeSocket({ reply: () => null });
  const protocol = createProtocol(socket);
  const waiting = protocol.send("Runtime.evaluate");
  socket.emit("close", {});
  await assert.rejects(() => waiting, /closed/i);
  await assert.rejects(() => protocol.send("Runtime.evaluate"), /closed/i, "and later calls do not wait either");
});

test("offers the app's windows, not devtools' own", async () => {
  const targets = await listTargets(9222, {
    fetchJson: async () => ([
      { type: "page", id: "a", title: "UI Sync", url: "http://127.0.0.1:5173/", webSocketDebuggerUrl: "ws://x/a" },
      { type: "page", id: "b", title: "DevTools", url: "devtools://devtools/bundled/x.html", webSocketDebuggerUrl: "ws://x/b" },
      { type: "service_worker", id: "c", title: "sw", url: "http://127.0.0.1:5173/sw.js", webSocketDebuggerUrl: "ws://x/c" },
      { type: "page", id: "d", title: "No socket", url: "http://127.0.0.1:5173/other" }
    ])
  });
  assert.deepEqual(targets.map((target) => target.id), ["a"]);
  assert.equal(targets[0].title, "UI Sync");
});

test("a port with nothing on it is empty, not an exception", async () => {
  assert.deepEqual(await listTargets(9222, { fetchJson: async () => ({ not: "an array" }) }), []);
});
