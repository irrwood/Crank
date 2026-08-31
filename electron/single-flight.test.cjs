const test = require("node:test");
const assert = require("node:assert/strict");
const { createSingleFlight } = require("./single-flight.cjs");

const deferred = () => {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
};

test("asking twice while it runs does the work once", async () => {
  const flight = createSingleFlight();
  const gate = deferred();
  let runs = 0;
  const work = () => { runs += 1; return gate.promise; };

  const first = flight.run("a", work);
  const second = flight.run("a", work);
  assert.equal(runs, 1);
  assert.equal(first, second);

  gate.resolve("scanned");
  assert.equal(await first, "scanned");
  assert.equal(await second, "scanned");
});

test("different keys do not share a run", async () => {
  const flight = createSingleFlight();
  let runs = 0;
  await Promise.all([
    flight.run("a", async () => { runs += 1; }),
    flight.run("b", async () => { runs += 1; })
  ]);
  assert.equal(runs, 2);
});

test("asking again after it finishes runs it again", async () => {
  // A scan is how you find out what changed; a remembered answer would defeat it.
  const flight = createSingleFlight();
  let runs = 0;
  const work = async () => { runs += 1; return runs; };
  assert.equal(await flight.run("a", work), 1);
  assert.equal(await flight.run("a", work), 2);
});

test("a failure reaches everyone waiting, and does not stick", async () => {
  const flight = createSingleFlight();
  const gate = deferred();
  const first = flight.run("a", () => gate.promise);
  const second = flight.run("a", () => gate.promise);

  gate.reject(new Error("the app never started"));
  await assert.rejects(() => first, /never started/);
  await assert.rejects(() => second, /never started/);

  assert.equal(flight.has("a"), false);
  assert.equal(await flight.run("a", async () => "recovered"), "recovered");
});

test("work that throws before returning a promise leaves nothing behind", async () => {
  const flight = createSingleFlight();
  await assert.rejects(() => flight.run("a", () => { throw new Error("bad root"); }), /bad root/);
  assert.equal(flight.has("a"), false);
  assert.equal(flight.size, 0);
});

test("the key stops being busy once its run settles", async () => {
  const flight = createSingleFlight();
  const gate = deferred();
  const run = flight.run("a", () => gate.promise);
  assert.equal(flight.has("a"), true);
  gate.resolve(null);
  await run;
  assert.equal(flight.has("a"), false);
});
