const { createHash } = require("node:crypto");
const { readFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { PNG } = require("pngjs");

const ignoredDirectories = new Set([
  ".git", "DerivedData", "build", "node_modules", "output", ".build", "Pods"
]);

function swiftStructBodies(source) {
  const results = [];
  const pattern = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)[^\{]*\{/g;
  for (const match of String(source || "").matchAll(pattern)) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth === 0) results.push({ sourceName: match[1], body: source.slice(match.index, cursor) });
  }
  return results;
}

function referencedImageNames(source) {
  const names = new Set();
  const patterns = [
    /\bUIImage\s*\(\s*named:\s*["']([^"']+)["']/g,
    /\bImage\s*\(\s*["']([^"']+)["']/g,
    /\bpath\s*\(\s*forResource:\s*["']([^"']+)["']\s*,\s*ofType:\s*["']png["']/g
  ];
  for (const pattern of patterns) {
    for (const match of String(source || "").matchAll(pattern)) {
      if (!match[1].includes("\\(")) names.add(match[1]);
    }
  }
  return [...names];
}

function scaleNumber(value) {
  return Number(String(value || "1x").replace(/x$/i, "")) || 1;
}

function unscaledPngName(filename) {
  return path.basename(filename, path.extname(filename)).replace(/@[1-9]\d*x$/i, "");
}

async function namespaceFolder(directory) {
  try {
    const contents = JSON.parse(await readFile(path.join(directory, "Contents.json"), "utf8"));
    return contents?.properties?.["provides-namespace"] === true;
  } catch {
    return false;
  }
}

async function imageSetLogicalName(imagesetDirectory, catalogDirectory) {
  const components = [path.basename(imagesetDirectory, ".imageset")];
  let cursor = path.dirname(imagesetDirectory);
  while (cursor !== catalogDirectory && cursor.startsWith(`${catalogDirectory}${path.sep}`)) {
    if (await namespaceFolder(cursor)) components.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }
  return components.join("/");
}

async function preferredImageSetPng(imagesetDirectory) {
  try {
    const contents = JSON.parse(await readFile(path.join(imagesetDirectory, "Contents.json"), "utf8"));
    const images = (contents?.images || [])
      .filter((image) => image.filename && path.extname(image.filename).toLowerCase() === ".png")
      .sort((left, right) => scaleNumber(right.scale) - scaleNumber(left.scale)
        || Number(right.idiom === "universal") - Number(left.idiom === "universal"));
    for (const image of images) {
      const imagePath = path.join(imagesetDirectory, image.filename);
      try {
        await readFile(imagePath);
        return imagePath;
      } catch {}
    }
  } catch {}
  return null;
}

async function assetCatalogIndex(root) {
  const aliases = new Map();
  const add = (name, assetPath) => {
    if (!name) return;
    if (!aliases.has(name)) aliases.set(name, new Set());
    aliases.get(name).add(assetPath);
  };
  const visit = async (directory, catalogDirectory = null) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (directory.endsWith(".imageset") && catalogDirectory) {
      const assetPath = await preferredImageSetPng(directory);
      if (!assetPath) return;
      const logicalName = await imageSetLogicalName(directory, catalogDirectory);
      add(logicalName, assetPath);
      add(path.basename(directory, ".imageset"), assetPath);
      add(unscaledPngName(assetPath), assetPath);
      return;
    }
    const nextCatalog = directory.endsWith(".xcassets") ? directory : catalogDirectory;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(entryPath, nextCatalog);
      } else if (entry.isFile() && !nextCatalog && path.extname(entry.name).toLowerCase() === ".png") {
        add(unscaledPngName(entry.name), entryPath);
      }
    }
  };
  await visit(root);
  return new Map([...aliases]
    .filter(([, paths]) => paths.size === 1)
    .map(([name, paths]) => [name, [...paths][0]]));
}

function translatedFrame(frame, snapshot, coordinateSpace) {
  const origin = coordinateSpace ?? snapshot?.environment?.viewport ?? { x: 0, y: 0, width: 1, height: 1 };
  const scaleX = coordinateSpace?.outputWidth ? coordinateSpace.outputWidth / origin.width : 1;
  const scaleY = coordinateSpace?.outputHeight ? coordinateSpace.outputHeight / origin.height : 1;
  return {
    x: (frame.x - origin.x) * scaleX,
    y: (frame.y - origin.y) * scaleY,
    width: frame.width * scaleX,
    height: frame.height * scaleY
  };
}

async function sourceImagePlan(assetName, assetPath, sourceName, frame, identity) {
  try {
    const buffer = await readFile(assetPath);
    const png = PNG.sync.read(buffer);
    return {
      id: `swift-image-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
      assetName,
      sourceName,
      frame,
      width: png.width,
      height: png.height,
      buffer
    };
  } catch {
    return null;
  }
}

async function originalAssetPlans(assets) {
  const namesByPath = new Map();
  for (const [assetName, assetPath] of assets) {
    if (!namesByPath.has(assetPath)) namesByPath.set(assetPath, []);
    namesByPath.get(assetPath).push(assetName);
  }
  const plans = [];
  for (const [assetPath, names] of namesByPath) {
    try {
      const buffer = await readFile(assetPath);
      const png = PNG.sync.read(buffer);
      plans.push({
        assetName: names.sort((left, right) => right.split("/").length - left.split("/").length || right.length - left.length)[0],
        width: png.width,
        height: png.height,
        buffer,
        originalAsset: true
      });
    } catch {}
  }
  return plans;
}

async function resolveSwiftSourceImages(root, snapshot, pageSourceName, coordinateSpace = null) {
  const allNodes = (snapshot?.nodes ?? []).filter((node) => node.frame?.width > 0 && node.frame?.height > 0);
  const pageNodes = pageSourceName ? allNodes.filter((node) => node.pageSourceName === pageSourceName) : allNodes;
  const nodes = pageNodes.length > 0 ? pageNodes : allNodes;
  const assets = await assetCatalogIndex(root);
  const plans = [];
  const identities = new Set();
  const append = async (assetName, node, identity) => {
    const assetPath = assets.get(assetName);
    if (!assetPath || identities.has(identity)) return;
    const plan = await sourceImagePlan(
      assetName,
      assetPath,
      node.sourceName,
      translatedFrame(node.frame, snapshot, coordinateSpace),
      identity
    );
    if (plan) {
      identities.add(identity);
      plans.push(plan);
    }
  };

  for (const node of nodes) {
    if (node.kind !== "Image" || !node.assetName) continue;
    await append(node.assetName, node, `runtime:${node.sourceFile}:${node.syncId}:${node.instanceId || "single"}:${node.assetName}`);
  }

  const captures = new Map(nodes.map((node) => [`${node.sourceFile}:${node.sourceName}`, node]));
  const files = [...new Set(nodes.map((node) => node.sourceFile).filter(Boolean))];
  for (const sourceFile of files) {
    let source;
    try {
      source = await readFile(path.join(root, sourceFile), "utf8");
    } catch {
      continue;
    }
    for (const declaration of swiftStructBodies(source)) {
      const capture = captures.get(`${sourceFile}:${declaration.sourceName}`);
      if (!capture) continue;
      for (const assetName of referencedImageNames(declaration.body)) {
        await append(assetName, capture, `static:${sourceFile}:${declaration.sourceName}:${assetName}`);
      }
    }
  }
  return [...plans, ...await originalAssetPlans(assets)];
}

module.exports = { assetCatalogIndex, referencedImageNames, resolveSwiftSourceImages, swiftStructBodies, translatedFrame };
