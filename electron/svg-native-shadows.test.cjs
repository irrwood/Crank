const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareNativeSvgShadows, supportedFilters } = require("./svg-native-shadows.cjs");

test("extracts feDropShadow into a native Figma shadow plan", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
    <defs><filter id="drop-shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000000" flood-opacity="0.25" />
    </filter></defs>
    <rect x="20" y="20" width="88" height="88" rx="22" fill="#3030FF" filter="url(#drop-shadow)" />
  </svg>`;

  const result = prepareNativeSvgShadows(source);

  assert.equal(result.fallbackSvg, source);
  assert.equal(result.shadows.length, 1);
  assert.deepEqual(result.shadows[0], {
    marker: "ui-sync-shadow-0",
    color: { r: 0, g: 0, b: 0, a: 0.25 },
    offset: { x: 0, y: 6 },
    radius: 10,
    spread: 0
  });
  assert.match(result.svg, /id="ui-sync-shadow-0"/);
  assert.doesNotMatch(result.svg, /filter="url\(#drop-shadow\)"/);
  assert.doesNotMatch(result.svg, /<feDropShadow\b/);
});

test("recognizes the standard expanded drop-shadow filter chain", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="shadow">
      <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>
      <feOffset in="blur" dx="2" dy="3" result="offsetBlur"/>
      <feFlood flood-color="rgb(12, 34, 56)" flood-opacity="0.4" result="shadowColor"/>
      <feComposite in="shadowColor" in2="offsetBlur" operator="in" result="shadow"/>
      <feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>
    <path style="fill:#fff;filter:url(#shadow)" d="M0 0h20v20z"/>
  </svg>`;

  const result = prepareNativeSvgShadows(source);

  assert.equal(supportedFilters(source).size, 1);
  assert.equal(result.shadows.length, 1);
  assert.deepEqual(result.shadows[0].offset, { x: 2, y: 3 });
  assert.equal(result.shadows[0].radius, 4);
  assert.equal(result.shadows[0].color.a, 0.4);
  assert.match(result.svg, /style="fill:#fff"/);
  assert.doesNotMatch(result.svg, /filter:url/);
});

test("leaves ambiguous masks and unsupported filters untouched", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="blur"><feGaussianBlur stdDeviation="8"/></filter>
      <mask id="mask"><image width="20" height="20" href="data:image/png;base64,AA=="/></mask>
    </defs>
    <g filter="url(#blur)" mask="url(#mask)"><rect width="20" height="20"/></g>
  </svg>`;

  assert.deepEqual(prepareNativeSvgShadows(source), { svg: source, fallbackSvg: null, shadows: [] });
});
