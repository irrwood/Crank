# Crank

Crank walks a running application, finds every screen it can reach, and hands
you those screens as editable Figma layers — with identity stable enough that a
second run updates the same frames instead of drawing new ones beside them.

It does not rebuild your interface. It runs the real one in Chromium and reads
what the browser laid out, so what arrives is what the page actually renders.

## What it does

- **Starts the project itself.** npm and pnpm projects run their own dev script;
  Electron projects serve the renderer without opening a window; Python and Ruby
  projects use the command their Dockerfile, Procfile or README already declares.
  Crank never invents a start command — a half-working start produces a
  confusing scan rather than an honest failure.
- **Walks every page.** Routes, tabs and overlays each count as a page. A theme
  or language switch is the same page wearing a different look, and is grouped
  with it. Every page carries the exact steps to reach it again from a fresh
  load, so a page that takes a click is not a page that can only be found once.
- **Attaches to what is already running.** An app started with a debugging port
  can be scanned as it is, with the data actually in it — which is the only way
  to capture screens that live behind a login or a bridge.
- **Hands the result over.** A self-contained HTML handoff page, or editable
  layers pushed straight into a Figma file.

## Giving it something to scan

Drop a project folder anywhere on the window. If the folder is a workspace with
several independently runnable applications, each becomes its own project;
component libraries with no start script are ignored.

Three other ways in, for the cases where there is no folder to give:

- **A built `.app`.** A designer handed a build has no project — Crank opens the
  bundle's own debug port, scans, and closes it again.
- **An address.** If the app is already running, scan the URL. Discovery only
  ever talks HTTP, so what the project is written in does not come into it.
- **An app you are using right now**, over its debugging port. The pages worth
  handing to a designer are usually the ones with real data in them, and those
  only exist in the process you are actually running.

Supported sources:

- Web projects — Vite, Next.js, Remix, Gatsby, Astro
- Electron desktop projects, including React, Vue, Svelte, Angular, Solid, Lit
  and plain Chromium renderers
- Any address that answers over HTTP, whatever served it
- Tailwind is recognised when the project depends on it

An external renderer is opened in a sandboxed Electron session with Node
integration disabled. Non-GET requests are cancelled unless they are framework
tooling, and off-host scripts and data calls are cancelled too, so a scan cannot
write to your project or run a third party's code inside it. What the page
merely draws — its fonts, its images — is loaded, because a scan that comes back
worse than opening the page in a browser is a defect, not a safety measure.

## What comes back

A page can be looked at three ways, and the window says which one is on screen,
because they differ and knowing which you are looking at is the point of having
more than one:

1. **The project's own page**, served and shown live. Fonts, `::before`,
   gradients, hover and animation are then simply correct, because nothing is
   standing in for them.
2. **The captured markup**, when the real page cannot be reached — the folder
   moved, the address is down, the project was an installed app.
3. **The layer tree**, which is what Figma receives.

Every captured image is stored once, under the hash of its own bytes, however
many pages show it.

The handoff export is one `.html` file that opens in any browser and carries its
own images, so it can be sent to someone who has none of this installed.

## Figma

Connect a Figma Design file and choose **Create & link frames**. Crank gives you
a six-digit pairing code for the companion plugin in [`figma-plugin/`](figma-plugin/).
Pairing is per-machine and remembered, so it is done once rather than per
project.

The plugin uses Figma's official Plugin API to:

- reuse an exact stored node ID while it still exists;
- recover a moved or renamed frame from stable shared plugin data;
- create a frame at the captured viewport — 393 × 852 when there is nothing to
  go on — only when no identity exists;
- rebuild Chromium's geometry, text, SVG, images, fills, borders, radii and
  typography as editable Figma layers;
- send back the file name, the new node IDs, and the text, size, colour and font
  of each mapped layer, which is how a later run finds the same frames and how
  Crank can tell what changed in Figma.

Import it once from `figma-plugin/manifest.json` via **Plugins → Development →
Import plugin from manifest…**. It can reach `localhost:38457` and nothing else;
a sync sends normalized visual structure, never your source code.

Nothing about a project leaves the machine except during an explicit sync.

## Running it

```bash
npm run dev     # Vite and Electron together, with reload
npm start       # build, then run it the way a user gets it
```

Or double-click `Start UI Sync.command`, which installs dependencies on first
run and then does the same.

The icon comes from `public/app-icon.png`; the macOS `.icns` variants built from
it live in `assets/`.

## Working on Crank

[`AGENTS.md`](AGENTS.md) is the file to read first: the rules the product is
held to, where everything lives, and the conventions this codebase actually
follows. The short version is that `electron/` owns everything touching the
machine, `src/` is the window and reaches the machine only through
`window.uiSync`, and nearly every module opens with a paragraph saying what it
is for and what went wrong before it existed.

```bash
npm test
npm run build
npm audit --omit=dev
```

## iOS projects

An Xcode project is scanned like everything else — drop the folder, and it
appears in the sidebar — but nothing about it can be served, so the scan takes
a different road:

1. The project is copied into a workspace of its own, its views are
   instrumented in that copy, and it is built with `xcodebuild`. The originals
   are never touched.
2. It launches on a Simulator device the project keeps, and each top-level
   navigation state is opened in turn.
3. Each state is exported through SwiftUI's `ImageRenderer` as a vector PDF
   page, with a UIKit window capture standing in for genuinely opaque content.
4. Those pages become the project's inventory: the same cards, the same
   right-click menu, the same **Send to Figma**.

Sending a page converts its PDF to SVG with Poppler and then restores only what
the capture can vouch for on top of it — editable text, shadows and blur, the
matching native Tab Bar, original asset-catalog images. Anything that cannot be
matched confidently keeps its rendered appearance; the page is never redrawn
from the source.

An exported page has no address, so it cannot be reopened live, recaptured, or
explored one level further. Its card says which view it came from instead.

Needs the full Xcode app (found through `DEVELOPER_DIR`, `xcode-select -p`, or
the default install), an installed iOS Simulator runtime, and Poppler
(`brew install poppler`), which is checked before a build starts rather than
after.

