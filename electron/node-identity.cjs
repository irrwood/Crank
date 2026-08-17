const { createHash } = require("node:crypto");

/**
 * Gives a captured node an identity that survives edits to its neighbours, and
 * matches two captures against each other honestly.
 *
 * The original identity was a position path — root/element:0/element:3. Insert
 * one wrapper in the source and every identity below it shifts, so a saved
 * Figma mapping silently starts pointing at the wrong layer. Nothing errors;
 * the data is simply wrong from then on.
 *
 * Two changes fix that. Identity is derived from what a node *is*, so an
 * unrelated sibling appearing beside it changes nothing. And re-capture is
 * treated as a matching problem rather than an assumption of stability: what
 * cannot be matched is reported instead of guessed, which turns silent
 * corruption into a short list to confirm.
 */

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

/**
 * What a node is, independent of where it sits or how large it renders: kind,
 * tag, the source selector the serialiser recorded, and its own text.
 *
 * Size is deliberately excluded. A node is the same node whether it renders at
 * 100px or 108px, and folding measurements into identity would make every
 * responsive reflow look like a different element — the same class of silent
 * drift this is meant to remove.
 */
function traitOf(node) {
  const text = typeof node?.text === "string" ? node.text.trim().slice(0, 40) : "";
  return [
    node?.kind ?? "element",
    node?.name ?? "",
    node?.selector ?? "",
    text
  ].join("|");
}

/**
 * Assigns every node a key of the form <parentKey>/<trait>:<n>, where n counts
 * only earlier siblings with the *same* trait. Adding a different sibling
 * therefore leaves existing keys untouched.
 *
 * The key is also the node's id, because the id is what the rest of the system
 * remembers a layer by: the baseline written at push time, the value the Figma
 * layer stores as its dom id, and the three-way match a pull runs across the
 * two. Leaving a position path in `id` while a stable key sat unread beside it
 * meant one wrapper element renamed every layer below it — the mapping did not
 * break loudly, it just stopped finding anything, and a designer's edit went
 * missing from the diff.
 */
function assignKeys(tree, parentKey = "root") {
  if (!tree || typeof tree !== "object") return tree;
  const counts = new Map();
  const walk = (node, parent) => {
    const trait = shortHash(traitOf(node));
    const seen = counts.get(`${parent}|${trait}`) ?? 0;
    counts.set(`${parent}|${trait}`, seen + 1);
    const key = `${parent}/${trait}:${seen}`;
    node.key = key;
    node.id = key;
    for (const child of node.children ?? []) walk(child, key);
    return node;
  };
  return walk(tree, parentKey);
}

function flatten(tree) {
  const nodes = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return nodes;
}

/**
 * Matches a previous capture against a new one.
 *
 * Keys are tried first. Whatever is left over is paired only when a removed
 * and an added node share a parent and a trait — an unambiguous rename or
 * move. Anything still unpaired is returned as such: a caller that needs to
 * carry a Figma mapping forward should ask rather than assume.
 */
function matchTrees(before, after) {
  const previous = flatten(before);
  const current = flatten(after);
  const byKey = new Map(current.map((node) => [node.key, node]));

  const matched = [];
  const removed = [];
  const takenKeys = new Set();

  for (const node of previous) {
    const hit = byKey.get(node.key);
    if (hit && !takenKeys.has(hit.key)) {
      takenKeys.add(hit.key);
      matched.push({ before: node, after: hit, confidence: "exact" });
    } else {
      removed.push(node);
    }
  }
  const added = current.filter((node) => !takenKeys.has(node.key));

  // A single leftover on each side under the same parent is a move or an edit
  // of one node, not a deletion plus an unrelated addition.
  const parentOf = (key) => String(key ?? "").split("/").slice(0, -1).join("/");
  const stillRemoved = [];
  for (const node of removed) {
    const candidates = added.filter((other) => parentOf(other.key) === parentOf(node.key));
    const sameKind = candidates.filter((other) => other.kind === node.kind);
    if (sameKind.length === 1 && candidates.length === 1) {
      matched.push({ before: node, after: sameKind[0], confidence: "likely" });
      added.splice(added.indexOf(sameKind[0]), 1);
    } else {
      stillRemoved.push(node);
    }
  }

  return {
    matched,
    added,
    removed: stillRemoved,
    /** True when every previous node found a home, exactly or plausibly. */
    complete: stillRemoved.length === 0 && added.length === 0
  };
}

module.exports = { assignKeys, flatten, matchTrees, shortHash, traitOf };
