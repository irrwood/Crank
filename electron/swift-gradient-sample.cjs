const { PNG } = require("pngjs");

/**
 * Reads a gradient's colours off the picture the app drew.
 *
 * SwiftUI's display list names a gradient but does not carry its stops, so the
 * conversion had nothing to fill the shape with and left it empty — and an
 * empty shape is not "a gradient we could not read", it is a background that
 * vanished. A whole screen came back white that is not white.
 *
 * The colours are not invented: every capture already carries a screenshot of
 * the same frame, so they are read from what the app itself painted, at the
 * place the shape covers. That is the difference between substituting and
 * guessing — and the substitution is named in the warnings either way.
 *
 * Each stop is the *median* of a whole row (or column) rather than one pixel,
 * because a background gradient has a button, a card and a paragraph sitting on
 * top of it. A median ignores what covers a minority of the line; a single
 * sample would have returned the colour of whatever it happened to land on.
 */

/** Where along the shape the stops are read. Not the very edge: a rounded
 * corner or a hairline border is not the fill. */
const STOPS = [0.02, 0.25, 0.5, 0.75, 0.98];

/** Samples per stop. Enough for a median to outvote what sits on the fill. */
const ACROSS = 33;

/** Below this the two ends are the same colour and the fill is flat. */
const FLAT_DISTANCE = 6;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function distance(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** Whether a line of stops moves one way, allowing for rounding. */
function monotone(line) {
  return ["r", "g", "b"].every((channel) => {
    const values = line.map((stop) => stop.colour[channel]);
    const rising = values.every((value, index) => index === 0 || value >= values[index - 1] - 2);
    const falling = values.every((value, index) => index === 0 || value <= values[index - 1] + 2);
    return rising || falling;
  });
}

function sameColour(a, b) {
  return distance(a, b) < 2;
}

/**
 * A sampler over one screen's picture, or null when there is no picture, it
 * cannot be read, or it is not of this screen.
 */
function createScreenshotSampler(screenshot, viewport) {
  if (typeof screenshot !== "string" || !screenshot) return null;
  let png;
  try {
    png = PNG.sync.read(Buffer.from(screenshot, "base64"));
  } catch {
    return null;
  }
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!(width > 0) || !(height > 0) || png.width < 2 || png.height < 2) return null;
  const scale = png.width / width;
  // A picture of a different screen — a rotation, a window that resized between
  // the capture and the shot — must not be sampled as if it were this one.
  if (Math.abs(png.height / height - scale) > 0.02 * scale) return null;

  const at = (pointX, pointY) => {
    const x = Math.min(png.width - 1, Math.max(0, Math.round(pointX * scale)));
    const y = Math.min(png.height - 1, Math.max(0, Math.round(pointY * scale)));
    const index = (png.width * y + x) << 2;
    return { r: png.data[index], g: png.data[index + 1], b: png.data[index + 2] };
  };

  /** The median colour of a line across the shape, in points. */
  const lineColour = (from, to, fixed, horizontal) => {
    const reds = [];
    const greens = [];
    const blues = [];
    for (let step = 0; step < ACROSS; step += 1) {
      const along = from + ((to - from) * step) / (ACROSS - 1);
      const pixel = horizontal ? at(along, fixed) : at(fixed, along);
      reds.push(pixel.r);
      greens.push(pixel.g);
      blues.push(pixel.b);
    }
    return { r: median(reds), g: median(greens), b: median(blues) };
  };

  return {
    /**
     * The fill to draw a shape with: a run of stops down or across it, or one
     * flat colour where the two ends agree. Null when the shape is too small
     * to read, which is most of the shapes that are not backgrounds.
     */
    fillFor(frame) {
      const left = Number(frame?.x);
      const top = Number(frame?.y);
      const boxWidth = Number(frame?.width);
      const boxHeight = Number(frame?.height);
      if (![left, top, boxWidth, boxHeight].every(Number.isFinite)) return null;
      if (boxWidth < 8 || boxHeight < 8) return null;

      const down = STOPS.map((offset) => ({
        offset,
        colour: lineColour(left, left + boxWidth, top + boxHeight * offset, true)
      }));
      const across = STOPS.map((offset) => ({
        offset,
        colour: lineColour(top, top + boxHeight, left + boxWidth * offset, false)
      }));
      const spreadOf = (line) => Math.max(...line.map((stop) => distance(stop.colour, line[0].colour)));
      // A gradient ramps; a card sitting on one is a spike. Reading the widest
      // spread alone picked the spike — a screen with a tall panel down the
      // middle was read as a left-to-right gradient into the panel's colour —
      // so an axis only counts if its colours move one way the whole length.
      const chosen = [down, across].filter(monotone).sort((a, b) => spreadOf(b) - spreadOf(a))[0];
      if (!chosen) {
        return { flat: down[Math.floor(down.length / 2)].colour, kind: "flat" };
      }
      const vertical = chosen === down;

      if (spreadOf(chosen) < FLAT_DISTANCE) {
        const flat = chosen[Math.floor(chosen.length / 2)].colour;
        return { flat, kind: "flat" };
      }
      // Stops that repeat their neighbour say nothing and cost a stop each.
      const stops = chosen.filter((stop, index) =>
        index === 0 || index === chosen.length - 1 || !sameColour(stop.colour, chosen[index - 1].colour));
      return { kind: "gradient", stops, vertical };
    }
  };
}

module.exports = { FLAT_DISTANCE, createScreenshotSampler };
