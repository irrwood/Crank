const { z } = require("zod");

const figmaUrlSchema = z.string().url().max(2048);

function parseFigmaDesignUrl(value, requireNode = false) {
  const url = new URL(figmaUrlSchema.parse(value.trim()));
  if (url.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(url.hostname)) {
    throw new Error("Use a figma.com design link");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const designIndex = segments.findIndex((segment) => segment === "design" || segment === "file");
  const fileKey = designIndex >= 0 ? segments[designIndex + 1] : null;
  if (!fileKey || !/^[A-Za-z0-9_-]+$/.test(fileKey)) {
    throw new Error("This link does not contain a Figma file key");
  }
  const rawNodeId = url.searchParams.get("node-id");
  const nodeId = rawNodeId?.replace("-", ":") ?? null;
  if (nodeId && !/^\d+:\d+$/.test(nodeId)) throw new Error("The Figma node ID is invalid");
  if (requireNode && !nodeId) throw new Error("Copy a link to the exact Figma frame");
  const encodedName = segments[designIndex + 2];
  const fileName = encodedName ? decodeURIComponent(encodedName).replace(/[-_]+/g, " ") : "Figma file";
  return { fileKey, fileName, nodeId };
}

module.exports = { parseFigmaDesignUrl };
