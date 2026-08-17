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
