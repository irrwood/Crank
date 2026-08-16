# UI Sync project instructions

## Product objective

UI Sync is an independent local-first desktop application for translating editable UI structure between source projects and Figma. It is not part of MOMO and must not assume that MOMO exists on the machine.

The active product scope is web and Electron projects. Prefer Electron and Chromium's official runtime APIs over source-language layout reconstruction. Existing SwiftUI connections may remain readable for backward compatibility, but do not extend SwiftUI parsing or Design Build unless the product direction is explicitly changed again.

## Architecture rules

1. Never hard-code a customer project path, Figma file, node ID, project name, or pairing code.
2. Treat every connected source folder and Figma file as user-owned external data.
3. Keep source inspection and runtime capture local. Send only normalized visual structure during an explicit sync action.
4. Capture third-party renderers in an isolated, sandboxed Electron session with Node integration disabled and external network requests blocked.
5. Stable source identity comes from source semantics and deterministic DOM identity. Runtime instances and frames are observations attached to that identity.
6. Preserve editable Figma layers and remembered frame identity. Do not replace linked frames with screenshots.
7. Validate IPC, bridge payloads, stored registry data, and runtime capture data with Zod.
8. Do not silently substitute missing fonts, assets, renderer builds, or unsupported dynamic states.
9. A selected folder can be a workspace. Discover every independently runnable application package and register each one as its own project.
10. Raster fallbacks must be bounded to the unsupported renderer itself. If a page contains SceneKit, Metal, WebView, video, canvas, or another opaque renderer, capture only that renderer's visible bounds as an image and preserve the rest of the page as editable text, shapes, layout, and vector layers. The presence of an opaque descendant must never cause its ancestor, page, or entire window to be rasterized.

## SwiftUI PDF-to-Figma rules

These rules are mandatory for existing SwiftUI PDF import compatibility:

1. The rendered PDF is the visual source of truth. Source parsing, semantic reconstruction, inferred layout, and generated Figma layers must never replace or override the PDF/SVG appearance.
2. Use data actually obtained during capture only as supporting evidence for restoring native Figma effects and components with explicit, deterministic rules, including shadows, blur, the matching native Tab Bar, and native buttons. Apply the same standard to original project images and editable text: replace PDF/SVG content only when the captured data and correspondence are reliable.
3. When the required data was not captured or cannot be matched reliably, preserve the PDF/SVG appearance. Never guess, invent placeholder content, auto-fill missing values, or semantically redraw the page.
4. Build the page inventory from every deterministically runnable top-level navigation state, not only `TabView` children or the launch root. Treat enum-backed `NavigationSplitView` / `NavigationStack` destinations as separate pages when the source provides an exact state-to-view mapping and UI Sync can launch that state without fabricated data. Do not count arbitrary component structs as pages.
5. Prefer an exact original project asset over a PDF image, soft mask, screenshot crop, or reconstructed bitmap. Resolve asset-catalog logical names (including namespaced paths and scale variants) and runtime-captured image names first; preserve the PDF representation when the original asset cannot be matched confidently.

The import order is therefore fixed: preserve the complete PDF-to-SVG visual result first, then replace only reliably matched elements with native editable Figma layers. A window fallback, `NavigationStack`, `List`, sheet, or other container must never trigger whole-page semantic reconstruction.

## Development loop

After changing TypeScript, JavaScript, Electron, Figma plugin, or Swift scanner code:

```bash
npm test
npm run build
npm audit --omit=dev
```

## UI direction

- macOS-native, compact, calm, and direct.
- Explain whether a screen is runtime-captured or using static fallback.
- Keep pairing device-level and remembered across projects.
- Prefer one-click project and Figma workflows with actionable error messages.
