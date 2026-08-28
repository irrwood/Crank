const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_PIPELINE,
  readCapturePipeline,
  usesDisplayList,
  usesVectorPdf,
  writeCapturePipeline
} = require("./capture-pipeline.cjs");

const temporaryDirectory = () => mkdtemp(path.join(os.tmpdir(), "crank-capture-settings-"));

test("a machine that has never chosen gets the pipeline that was already there", async () => {
  const directory = await temporaryDirectory();
  assert.equal(await readCapturePipeline(directory), "vector-pdf");
  assert.equal(DEFAULT_PIPELINE, "vector-pdf");
});

test("a chosen pipeline is what is read back", async () => {
  const directory = await temporaryDirectory();
  await writeCapturePipeline(directory, "display-list");
  assert.equal(await readCapturePipeline(directory), "display-list");
  await writeCapturePipeline(directory, "both");
  assert.equal(await readCapturePipeline(directory), "both");
});

test("a settings file that cannot be read leaves scanning working", async () => {
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, "capture-settings.json"), "{ not json", "utf8");
  assert.equal(await readCapturePipeline(directory), "vector-pdf");

  await writeFile(path.join(directory, "capture-settings.json"), JSON.stringify({ capturePipeline: "telepathy" }), "utf8");
  assert.equal(await readCapturePipeline(directory), "vector-pdf");
});

test("a pipeline nobody implemented is refused rather than stored", async () => {
  const directory = await temporaryDirectory();
  await assert.rejects(() => writeCapturePipeline(directory, "telepathy"));
  assert.equal(await readCapturePipeline(directory), "vector-pdf");
});

test("no half-written settings file is left behind", async () => {
  const directory = await temporaryDirectory();
  await writeCapturePipeline(directory, "both");
  const raw = await readFile(path.join(directory, "capture-settings.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { capturePipeline: "both" });
});

test("both means both, and either means only itself", () => {
  assert.equal(usesVectorPdf("vector-pdf"), true);
  assert.equal(usesDisplayList("vector-pdf"), false);
  assert.equal(usesVectorPdf("display-list"), false);
  assert.equal(usesDisplayList("display-list"), true);
  assert.equal(usesVectorPdf("both"), true);
  assert.equal(usesDisplayList("both"), true);
});
