# Crank project instructions

## Product objective

Crank is an independent local-first desktop application for translating editable UI structure between source projects and Figma. It is not part of MOMO and must not assume that MOMO exists on the machine.

The active product scope is web, Electron, and SwiftUI iOS projects. Prefer Electron and Chromium's official runtime APIs over source-language layout reconstruction for anything served in a browser, and the Simulator's own rendered output over source reconstruction for iOS.

There are two capture pipelines behind one flow:

- **Served projects** are started, crawled in a sandboxed Chromium, and reach Figma as `editable-dom` screens built from their layer trees.
- **iOS projects** have no address to serve. A folder holding an `.xcodeproj` is built, launched on a Simulator, and each top-level state is exported as a vector PDF page; those pages reach Figma as `structured` screens carrying the page's SVG.

Everything after capture is shared: one sidebar, one `inventory:scan-folder`, one inventory shape, one `inventory:send-to-figma`, one bridge job. An exported iOS page carries only its identity (`page.vector`); the PDFs, their clean variants, and the runtime snapshot stay on disk and are read back when the page is sent.

## Architecture rules

1. Never hard-code a customer project path, Figma file, node ID, project name, or pairing code.
2. Treat every connected source folder and Figma file as user-owned external data.
3. Local means nothing about the project leaves the machine: send only normalized visual structure, and only during an explicit sync action. It does not mean capture refuses to load what the page itself loads — see rule 11.
4. Capture third-party renderers in an isolated, sandboxed Electron session with Node integration disabled. Block what can change the project or run someone else's code in it — any non-GET request, and off-host scripts and data calls. Subresources the page merely draws are not that; see rule 11.
5. Stable source identity comes from source semantics and deterministic DOM identity. Runtime instances and frames are observations attached to that identity.
6. Preserve editable Figma layers and remembered frame identity. Do not replace linked frames with screenshots.
7. Validate IPC, bridge payloads, stored registry data, and runtime capture data with Zod.
8. Never substitute a missing font, asset, renderer build, or unsupported dynamic state *silently*. Substituting and naming what was substituted is the required behaviour; refusing is not. Twice this rule was implemented as a refusal and cost far more than it protected: a page with one unavailable font produced no layers at all, and a font Figma did not have left an empty frame on the canvas after the frame had already been created.
9. A selected folder can be a workspace. Discover every independently runnable application package and register each one as its own project.
10. Raster fallbacks must be bounded to the unsupported renderer itself. If a page contains SceneKit, Metal, WebView, video, canvas, or another opaque renderer, capture only that renderer's visible bounds as an image and preserve the rest of the page as editable text, shapes, layout, and vector layers. The presence of an opaque descendant must never cause its ancestor, page, or entire window to be rasterized.
11. A browser is the floor. A page that renders correctly when someone simply opens it must not come back from a scan worse than that — missing its typeface, its images, or its layers. Capture is a browser; producing less than one is a defect, never a trade-off to be weighed. When something genuinely cannot be captured, report the gap and deliver the rest: a partial result names what is missing, an empty one names nothing.
12. Prefer a deterministic anchor over a resemblance. Identity derived from source — an attribute injected at build time, a route, a recorded click path — beats identity inferred from what a node looks like, and the inferred kind is the fallback for projects whose build Crank does not control. Injected anchors must never be written into the user's files.

Rules here are decisions, not axioms. Where evidence contradicts one, change it and say what the evidence was; rules 3, 4 and 8 were narrowed after each was read as a prohibition it never stated.

## How this repository is laid out

| Area | Language | What it owns |
| --- | --- | --- |
| `electron/` | CommonJS `.cjs` on Node | Everything that touches the machine: starting projects, driving Chromium, capture, storage, the Figma bridge. |
| `src/` | TypeScript + React 18, built by Vite | The window. Reaches the machine only through `window.uiSync`. |
| `shared/` | Plain ESM `.js` with a hand-written `.d.ts` | The few decisions both sides must agree on. Loaded by `await import()` in the main process and bundled by Vite in the renderer, so it may use neither Node nor the DOM. |
| `figma-plugin/` | Plain JS against the Figma Plugin API | The other half of a sync. No build step — `code.js` ships as written, typechecked by `npm run typecheck:plugin`. |
| `figma-plugin/listing/` | — | The Community submission: the copy and the artwork it is published with. |
| `swift-tools/`, `swift-sdk/` | Swift | The iOS path: the SwiftSyntax scanner and the PDF compositor Crank compiles on demand, and the design SDK a project can adopt. |
| `public/`, `assets/` | — | `public/app-icon.png` is the icon; `assets/` holds the macOS `.icns` variants built from it. |

Read the docblock at the top of a module before reading the module. Nearly every
file in `electron/` opens with one that says what the file is for and, more
usefully, what went wrong before it existed. `asset-store.cjs`,
`node-identity.cjs`, `page-origin.cjs` and `browsing-session.cjs` are the four to
read first. Grepping for a symbol tends to land in the wrong file; those
docblocks are the map.

### What is dormant, and stays that way

`src/App.tsx` is the previous interface. It is unreachable from `src/main.tsx`
and is kept deliberately, to be folded back in a piece at a time. The SwiftUI
runtime — `electron/swiftui-*.cjs`, `electron/swift-*.cjs`, `swift-tools/`,
`swift-sdk/` — is the same: kept readable for compatibility, not extended.
Neither is dead code to be tidied away, and neither is somewhere to add
anything.

## Conventions

### Comments and commit messages

A comment says why the code is the way it is, and names what went wrong without
it. `// increment the counter` is noise; `// Chromium reports the origin of every
file as "null", so without this the whole disk is either inside the app or
outside it` is the reason the next person does not delete the line. Prefer one
paragraph at the top of a module to a comment on every function.

A commit subject says what changed for the person using Crank, as an imperative
sentence — "Keep every picture once", not "refactor asset store". The body
carries the evidence: what was observed, what it cost, what was measured
afterwards.

### Tests

`node:test` and `node:assert/strict`, colocated as `electron/<module>.test.cjs`.
No test framework and no mocking library. A test name is a sentence about
behaviour — "an app that registered a scheme of its own is that scheme and host"
— so a failing run reads as a list of things that stopped being true. Cases
taken from real projects earn a comment naming the project and the symptom.

### The IPC surface

Channels are named `domain:verb` — `inventory:scan`, `projects:add`,
`preview:start`. Adding one means changing three files together, and there is no
way to add a working one without all three:

1. `electron/main.cjs` — `ipcMain.handle("domain:verb", …)`
2. `electron/preload.cjs` — one method on the `uiSync` bridge
3. `src/global.d.ts` — its type

Validate what crosses that boundary with Zod, along with stored registry data
and anything read back out of a captured page (rule 7).

### The renderer

- One stylesheet, `src/styles.css`, in semantic class names — `.sidebar-bar`,
  `.project-item`. Tailwind is imported at the top of it, but the interface is
  not written in utility classes; do not start.
- Every user-facing string goes through `t()` and exists in both `en` and
  `zh-CN` in `src/lib/locale.tsx`. A literal in JSX is a defect that
  typechecking cannot catch.
- The window is `hiddenInset` with the traffic lights at (18, 18), so a column
  starts below the `.sidebar-drag` spacer.
- The renderer has no Node. If it needs the machine, it needs a channel.
- A column that must keep something pinned at its foot needs `min-height: 0` on
  the part that scrolls: a flex item's automatic minimum is its content, so
  without it the list never overflows and pushes the rest off the bottom.

### Code that is injected into a captured page

`electron/figma-tree.cjs` is serialised with `toString()` and evaluated inside
the page being captured. It can close over nothing and require nothing, and the
same holds for any function handed to `browsing-session`. Adding an import to
one of these fails only at capture time, in someone else's app.

### The product is called Crank

It was called UI Sync. The old name survives where changing it would be risky or
pointless — the `window.uiSync` bridge, the user-data migration, the Swift SDK's
`UISyncDesignNode`, and many docblocks. Leave those. Anything a user reads says
Crank.

## SwiftUI PDF-to-Figma rules

These rules are mandatory for existing SwiftUI PDF import compatibility:

1. The rendered PDF is the visual source of truth. Source parsing, semantic reconstruction, inferred layout, and generated Figma layers must never replace or override the PDF/SVG appearance.
2. Use data actually obtained during capture only as supporting evidence for restoring native Figma effects and components with explicit, deterministic rules, including shadows, blur, the matching native Tab Bar, and native buttons. Apply the same standard to original project images and editable text: replace PDF/SVG content only when the captured data and correspondence are reliable.
3. When the required data was not captured or cannot be matched reliably, preserve the PDF/SVG appearance. Never guess, invent placeholder content, auto-fill missing values, or semantically redraw the page.
4. Build the page inventory from every deterministically runnable top-level navigation state, not only `TabView` children or the launch root. Treat enum-backed `NavigationSplitView` / `NavigationStack` destinations as separate pages when the source provides an exact state-to-view mapping and Crank can launch that state without fabricated data. Do not count arbitrary component structs as pages.
5. Prefer an exact original project asset over a PDF image, soft mask, screenshot crop, or reconstructed bitmap. Resolve asset-catalog logical names (including namespaced paths and scale variants) and runtime-captured image names first; preserve the PDF representation when the original asset cannot be matched confidently.

The import order is therefore fixed: preserve the complete PDF-to-SVG visual result first, then replace only reliably matched elements with native editable Figma layers. A window fallback, `NavigationStack`, `List`, sheet, or other container must never trigger whole-page semantic reconstruction.

## Development loop

While working on the renderer, the fast check is:

```bash
npm run typecheck
```

After changing TypeScript, JavaScript, Electron, Figma plugin, or Swift scanner code:

```bash
npm test
npm run build
npm audit --omit=dev
```

### Looking at the running app

`npm run dev` runs Vite and Electron together with reload. To see a change as a
user gets it — the built renderer, at the real window size, with the real
registry behind it — and to be able to screenshot it:

```bash
npm run build && npx electron . --remote-debugging-port=9223
```

The window is then a CDP target: `curl -s http://127.0.0.1:9223/json/list` names
it, and `Page.captureScreenshot` over its `webSocketDebuggerUrl` returns a PNG.
Node has had `WebSocket` built in since 21, so this needs nothing installed.

Look at the result. A change to the window is not finished because it
typechecks: the sidebar's own status label was truncated to "Figma …" at the
real 180px width, which no test would have failed on and which the browser at a
comfortable width never showed.

## UI direction

- macOS-native, compact, calm, and direct.
- Explain whether a screen is runtime-captured or using static fallback.
- Keep pairing device-level and remembered across projects.
- Prefer one-click project and Figma workflows with actionable error messages.
