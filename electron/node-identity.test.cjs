const test = require("node:test");
const assert = require("node:assert/strict");
const { assignKeys, flatten, matchTrees, traitOf } = require("./node-identity.cjs");

const element = (name, extra = {}) => ({ kind: "element", name, width: 100, height: 40, children: [], ...extra });
const text = (value) => ({ kind: "text", name: "Text", text: value, width: 80, height: 20 });

function page({ withBanner = false } = {}) {
  return {
    kind: "element", name: "Root", width: 1200, height: 800,
    children: [
      ...(withBanner ? [element("Banner", { children: [text("New!")] })] : []),
      element("Header", { children: [text("Catfolio")] }),
      element("Card", { children: [text("Holdings")] }),
      element("Card", { children: [text("Returns")] })
    ]
  };
}

test("inserting a sibling does not move anything else", () => {
  // The defect this exists to prevent: with a position path, adding one
  // wrapper shifted every identity below it and saved Figma mappings quietly
  // pointed at the wrong layer from then on.
  const before = assignKeys(page());
  const after = assignKeys(page({ withBanner: true }));

  const keyOf = (tree, name) => flatten(tree).find((node) => node.name === name)?.key;
  assert.equal(keyOf(before, "Header"), keyOf(after, "Header"), "Header must keep its identity");

  const holdingsBefore = flatten(before).find((node) => node.text === "Holdings")?.key;
  const holdingsAfter = flatten(after).find((node) => node.text === "Holdings")?.key;
  assert.equal(holdingsBefore, holdingsAfter, "text deep inside must keep its identity too");
});

test("identical siblings are told apart, and stay told apart", () => {
  const tree = assignKeys(page());
  const cards = flatten(tree).filter((node) => node.name === "Card");
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].key, cards[1].key, "two identical cards need distinct keys");
  // Re-running gives the same answer.
  const again = flatten(assignKeys(page())).filter((node) => node.name === "Card");
  assert.deepEqual(cards.map((node) => node.key), again.map((node) => node.key));
});

test("a node that changed is not silently treated as the old one", () => {
  const before = assignKeys(page());
  const renamed = page();
  renamed.children[1].children[0].text = "Positions";
  const after = assignKeys(renamed);

  const result = matchTrees(before, after);
  const pair = result.matched.find((entry) => entry.before.text === "Holdings");
  assert.ok(pair, "an unambiguous single change under one parent is paired");
  assert.equal(pair.confidence, "likely", "but marked as a guess, not an exact match");
  assert.equal(pair.after.text, "Positions");
});

test("what cannot be matched is reported rather than guessed", () => {
  const before = assignKeys(page());
  const stripped = page();
  stripped.children.splice(1, 2); // remove both cards at once
  const after = assignKeys(stripped);

  const result = matchTrees(before, after);
  assert.equal(result.complete, false);
  assert.ok(result.removed.length >= 2, "ambiguous losses are surfaced, not paired off");
  assert.ok(
    result.removed.every((node) => !result.matched.some((entry) => entry.before === node)),
    "a reported node must not also be claimed as matched"
  );
});

test("an unchanged page matches completely", () => {
  const result = matchTrees(assignKeys(page()), assignKeys(page()));
  assert.equal(result.complete, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.ok(result.matched.every((entry) => entry.confidence === "exact"));
});

test("a responsive reflow is not a different node", () => {
  // Identity must not move because a column got wider.
  const before = assignKeys(page());
  const nudged = page();
  nudged.children[0].width = 640;
  nudged.children[1].height = 96;
  const after = assignKeys(nudged);
  assert.equal(matchTrees(before, after).complete, true);
});

test("trait ignores position and depends on what the node is", () => {
  assert.equal(traitOf(element("Card")), traitOf(element("Card")));
  assert.notEqual(traitOf(element("Card")), traitOf(element("Panel")));
  assert.notEqual(traitOf(text("a")), traitOf(text("b")));
});

test("the identity a layer is remembered by is the stable one", () => {
  // Everything downstream reads node.id: the baseline written when pages are
  // pushed, the dom id the Figma layer stores, and the match a pull runs
  // between them. A position path there meant inserting one wrapper renamed
  // every layer below it, and the pull quietly found nothing to compare.
  const before = assignKeys(page());
  const after = assignKeys(page({ withBanner: true }));
  const idOf = (tree, value) => flatten(tree).find((node) => node.text === value)?.id;

  assert.equal(idOf(before, "Holdings"), idOf(after, "Holdings"), "a new banner above must not rename it");
  for (const node of flatten(after)) assert.equal(node.id, node.key, "one identity, not two");
});

test("an anchored node keeps its identity when everything about it changes", () => {
  // The trait is kind, name, selector and text. Redesign a button — rename the
  // class, rewrite the label — and every one of those moves, so a resemblance
  // cannot recognise it. What the element says about where it was written does
  // not move, and that is the whole point of asking the build for it.
  const before = { kind: "element", name: "Save", selector: ".btn-primary", source: "src/Form.tsx:12:5", width: 90, height: 32, children: [] };
  const after = { kind: "element", name: "Confirm", selector: ".button--accent", source: "src/Form.tsx:12:5", width: 120, height: 40, children: [] };
  assert.equal(assignKeys({ ...before }).id, assignKeys({ ...after }).id);
});

test("two elements written on different lines are two elements", () => {
  const page = (extra) => ({
    kind: "element", name: "Root", source: "src/Page.tsx:1:1", width: 100, height: 100,
    children: [
      { kind: "element", name: "Card", source: "src/Page.tsx:9:7", width: 10, height: 10, children: [] },
      { kind: "element", name: "Card", source: "src/Page.tsx:14:7", width: 10, height: 10, children: [] },
      ...(extra ? [{ kind: "element", name: "Banner", source: "src/Page.tsx:4:3", width: 10, height: 10, children: [] }] : [])
    ]
  });
  const plain = flatten(assignKeys(page(false)));
  const withBanner = flatten(assignKeys(page(true)));
  assert.notEqual(plain[1].id, plain[2].id, "same name, different line — different nodes");
  const idAt = (nodes, line) => nodes.find((node) => node.source?.endsWith(`:${line}:7`))?.id;
  assert.equal(idAt(plain, 9), idAt(withBanner, 9), "an element added above renames nothing");
  assert.equal(idAt(plain, 14), idAt(withBanner, 14));
});

test("a node with no anchor still gets one from what it is", () => {
  const mixed = assignKeys({
    kind: "element", name: "Root", width: 100, height: 100,
    children: [{ kind: "text", name: "Text", text: "Hello", width: 10, height: 10 }]
  });
  const [root, text] = flatten(mixed);
  assert.ok(root.id.startsWith("root/"), "projects UI Sync does not build still work");
  assert.ok(text.id.startsWith(root.id));
});
