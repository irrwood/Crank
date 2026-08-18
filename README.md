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
- **Walks every page.** Routes, tabs and overlays each count as a page. A theme
  or language switch is the same page wearing a different look, and is grouped
  with it.
- **Attaches to what is already running.** An app started with a debugging port
  can be scanned as it is, with the data actually in it — which is the only way
  to capture screens that live behind a login or a bridge.
- **Hands the result over.** A self-contained HTML handoff page, or editable
  layers pushed straight into a Figma file.

## Development

```bash
npm run dev
```

## SwiftUI visual editing MVP

The SwiftUI Design Studio implements the v1 visual-editing loop:

- discover every SwiftUI screen, modal, and component and expose them in the local Pages & Views rail;
- render source-linked SwiftUI IR as real selectable DOM layers in the UI Sync canvas;
- edit text, width, height, corner radius, font size, and background with immediate local preview;
- keep a Simulator PNG as an optional, hidden-by-default visual reference rather than editable content;
- add [`swift-sdk/UISyncDesignNode.swift`](swift-sdk/UISyncDesignNode.swift) to the app target;
- wrap the editable screen root in `UISyncDesignCanvas { ... }`;
- mark 5–30 component-level views with `.designNode("stable-id", cornerRadius: ..., fontSize: ...)`;
- optionally run Design Build to add runtime measurements for the active launch route, then switch between Interact and Select mode;
- resize a node or set an Inspector target, review the relational intent payload, and confirm it for Codex;
- UI Sync creates a clean `ui-sync/design-edit-*` Git branch, rebuilds up to three times, spot-checks a second Simulator canvas for geometry edits, then waits for Accept or Reject.

The target project must be a clean Git worktree before a visual edit. Runtime capture stays local; only the confirmed normalized intent batch is sent to Codex.

The application icon is sourced from `public/app-icon.png`; macOS raster and `.icns` variants live in `assets/`.

Supported local sources:

- Electron desktop projects, including React, Vue, Svelte, Angular, Solid, Lit, and plain Chromium renderers
- Web projects, including Vite, Next.js, Remix, Gatsby, and Astro
- Tailwind is detected automatically when present

Website and desktop sources use the same explicit element-to-Figma identity. A published URL without its source repository is treated separately because it cannot support safe two-way code updates.

Drop a project or workspace folder anywhere on the application window to inspect it. If the folder contains several independently runnable packages, UI Sync creates one Project for each app. Component libraries without an app start script are ignored.

External Electron renderers are opened through Electron's official sandboxed `BrowserWindow` runtime. Node integration is disabled, permissions and new windows are denied, and non-local network requests are blocked. UI Sync reads Chromium's real DOM geometry and computed styles into editable structure; it does not use a screenshot as the Figma result. A built renderer such as `out/renderer/index.html`, `dist/renderer/index.html`, or `dist/index.html` is required for deterministic capture.

## Automatic Figma frame identity

After connecting a Figma Design file, choose **Create & link frames**. UI Sync gives you a six-digit pairing code for the local **UI Sync Bridge** Figma plugin in `figma-plugin/`.

The plugin uses Figma's official Plugin API to:

- reuse an exact stored node ID when it still exists;
- recover a moved or renamed frame from stable shared plugin data;
- create a 393 × 852 screen frame only when no identity exists;
- rebuild Chromium DOM geometry, text, SVG, images, fills, borders, radii, and typography as editable Figma layers;
- return every native Figma node ID to the desktop app automatically.

Import the plugin once from `figma-plugin/manifest.json` via **Plugins → Development → Import plugin from manifest…**. Communication is restricted to `localhost:38457`; the explicit sync action sends normalized editable visual structure, never project source code.

## Run

Double-click `Start UI Sync.command`, or run:

```sh
cd /Users/qian/Documents/UI-Sync
npm start
```

The current milestone includes real local project discovery, a source-structured local SwiftUI editor, Codex-backed SwiftUI edits with Git accept/reject checkpoints, and automatic native Figma frame creation/identity recovery.
