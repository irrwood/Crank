const path = require("node:path");
const { readFile, writeFile, mkdir, rename } = require("node:fs/promises");
const { z } = require("zod");

/**
 * Which way a SwiftUI project is captured.
 *
 * There are two, and neither is obviously better on every project. The vector
 * path exports each screen as a PDF and turns that into SVG: it draws exactly
 * what the app draws, and it arrives as a flat set of shapes with no tree, no
 * names, and no identity a second scan could recognise. The display-list path
 * reads the render tree SwiftUI itself built, so it keeps all three — but it
 * reads private fields by reflection, so a screen it cannot read is a screen it
 * reports rather than draws.
 *
 * Which one wins is a question about a real project, not one to settle in the
 * abstract, so the choice is a setting and `both` is a real option: one launch
 * of the app, captured twice, so the two results can be compared without the
 * two runs differing for reasons nobody can pin down.
 *
 * The default stays `vector-pdf`. A setting that changes what an existing scan
 * produces should be something a person turned on, not something that happened
 * to them on an update.
 */

const PIPELINES = ["vector-pdf", "display-list", "both"];

const settingsSchema = z.object({
  capturePipeline: z.enum(["vector-pdf", "display-list", "both"])
}).strict();

const DEFAULT_PIPELINE = "vector-pdf";

const settingsPath = (userDataDirectory) => path.join(userDataDirectory, "capture-settings.json");

/**
 * Reads the setting, falling back to the default for anything unreadable.
 *
 * A corrupt or hand-edited settings file must not stop the app from scanning:
 * the cost of ignoring it is one setting silently back at its default, and the
 * cost of throwing is a project that cannot be opened at all.
 */
async function readCapturePipeline(userDataDirectory) {
  const raw = await readFile(settingsPath(userDataDirectory), "utf8").catch(() => null);
  if (!raw) return DEFAULT_PIPELINE;
  try {
    return settingsSchema.parse(JSON.parse(raw)).capturePipeline;
  } catch {
    return DEFAULT_PIPELINE;
  }
}

async function writeCapturePipeline(userDataDirectory, pipeline) {
  const settings = settingsSchema.parse({ capturePipeline: pipeline });
  await mkdir(userDataDirectory, { recursive: true });
  // Written beside the target and moved into place, so a crash midway leaves
  // the previous setting rather than a half-written file that reads as neither.
  const target = settingsPath(userDataDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return settings.capturePipeline;
}

/** Whether this pipeline runs the vector export. */
const usesVectorPdf = (pipeline) => pipeline === "vector-pdf" || pipeline === "both";

/** Whether this pipeline reads the display list. */
const usesDisplayList = (pipeline) => pipeline === "display-list" || pipeline === "both";

module.exports = {
  DEFAULT_PIPELINE,
  PIPELINES,
  readCapturePipeline,
  settingsSchema,
  usesDisplayList,
  usesVectorPdf,
  writeCapturePipeline
};
