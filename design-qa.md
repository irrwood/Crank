# Sidebar alignment QA

- Source visual truth: `/var/folders/1r/s41tlht54vndy5tkxp_lb6l00000gn/T/codex-clipboard-2512e638-2966-422f-9274-8b87112459bf.png`
- Implementation screenshot: `/Users/qian/Documents/UI-Sync/.codex-sidebar-left-aligned.png`
- Focused comparison: `/Users/qian/Documents/UI-Sync/.codex-sidebar-alignment-comparison.png`
- Source pixels: 370 × 798; normalized from an apparent @2x crop to 185 × 399
- Implementation pixels: 1187 × 768; sidebar comparison crop 207 × 399 at 1x
- State: UI-Sync selected, project list expanded

## Full-view comparison evidence

The running Electron window shows every project name beginning at the same x position immediately after its 28px icon. Long names truncate to the right without changing the starting point, and the selected-row background does not change alignment.

## Focused comparison evidence

The combined comparison places the user crop on the left and the revised implementation on the right. The source demonstrates the defect: short names such as `cv` and `desktop` shift toward the centre according to their width. In the implementation, `desktop`, `ChatWise.app`, `cv`, `UI-Sync`, and the remaining names share one left edge.

## Required fidelity surfaces

- Fonts and typography: existing SF/system font, 12px size, 700 weight, line height, antialiasing, and truncation are preserved.
- Spacing and layout rhythm: icons remain 28px; the fixed 9px icon-to-label gap and one shared label origin create a consistent column.
- Colors and visual tokens: sidebar, text, selected surface, and icon treatments are unchanged.
- Image quality and asset fidelity: original project icons remain sharp and retain their existing crops.
- Copy and content: only the project names remain in each row, as requested; no scan-age or page-count metadata reappears.

## Comparison history

1. P1: project labels were horizontally centred inside the remaining row width, so every name began at a different x position.
2. Cause: after removing the metadata line, `.project-copy` became a row flex container but retained `justify-content: center` from its earlier vertical layout.
3. Fix: set the main axis to `justify-content: flex-start`, vertically centre with `align-items: center`, and keep nested rows on the same left padding.
4. Post-fix: the focused comparison shows a single shared left edge across all nine project names.

## Findings

No actionable P0/P1/P2 differences remain for the requested alignment change.

## Implementation checklist

- [x] Align every project name to the icon column.
- [x] Keep nested and top-level project rows on the same text origin.
- [x] Preserve truncation, icons, selection, and hover actions.
- [x] Verify in the production Electron build.

final result: passed

---

# Figma-style inspector QA

- Source visual truth: `/var/folders/1r/s41tlht54vndy5tkxp_lb6l00000gn/T/codex-clipboard-dc368a5b-29c7-4bf7-96a2-30f65a7cc5e6.png`
- Implementation screenshot: `/Users/qian/Documents/UI-Sync/.codex-editor-figma-inspector.png`
- Focused comparison: `/Users/qian/Documents/UI-Sync/.codex-editor-inspector-comparison.png`
- Source pixels: 482 × 1498; apparent @2x Figma inspector crop, representing about 241 × 749 CSS px
- Implementation pixels: 2440 × 1580 at @2x; Electron viewport 1220 × 790 CSS px
- Implementation comparison crop: 504 × 1498 at @2x, representing the 252 × 749 CSS px inspector below the app toolbar
- Density normalization: both focused crops remain at @2x and share the same 1498px height; no scaling was applied
- State: one editable layer selected, Position/Layout/Appearance/Fill expanded, Stroke/Effects/Export collapsed

## Full-view comparison evidence

The production Electron build preserves Crank's layer rail and infinite canvas while replacing the previous sparse Properties form with a Figma-like object inspector. Selection, resize handles, and the property values remain synchronized in one view. The inspector is independently scrollable, so lower sections remain reachable at the real 1220 × 790 CSS viewport.

## Focused comparison evidence

The combined comparison places the Figma reference on the left and the final Crank inspector on the right at the same pixel density and content height. Both use the same hierarchy: selected-layer header; Position with six alignment actions, X/Y, constraints, and rotation; Layout with W/H and aspect lock; Appearance with opacity and radius; then Fill, Stroke, Effects, and Export. The implementation deliberately shows the selected layer's captured paint value rather than inventing the reference's `Linear` gradient for unrelated content.

## Required fidelity surfaces

- Fonts and typography: both use the macOS system UI family, compact labels, semibold section titles, tabular numeric fields, single-line truncation, and comparable hierarchy. The implementation keeps Crank's existing system-font rendering rather than importing a lookalike.
- Spacing and layout rhythm: the final 252px inspector is close to the reference's apparent 241px width. Section dividers, 25px controls, paired fields, six-way alignment strip, constraints block, and compact collapsed rows reproduce the reference rhythm without crowding.
- Colors and visual tokens: white panels, pale neutral fields, low-contrast dividers, dark text, blue selection/constraint accents, and disabled-state opacity reuse Crank's existing palette while matching the reference balance.
- Image quality and asset fidelity: this inspector contains no raster product imagery. All visible controls use the installed icon library rather than handcrafted symbols; the selected page remains the original captured editable layer tree.
- Copy and content: every new label is localized in English and Chinese. Values come from the selected layer, so Fill, dimensions, position, and constraints reflect the actual screen rather than the reference screenshot's sample values.

## Interaction evidence

- Six-way alignment: horizontal-center moved a 240px layer inside its 1182px parent to X 471; Undo restored X 0 and cleared the manifest.
- Aspect lock: changing W 240 to W 300 changed H 913 to H 1141.25; Undo restored both values.
- Appearance: opacity 80% and rotation 15° updated both the rendered layer and selection outline, and each produced one undoable manifest entry.
- Stroke: setting weight to 2 rendered a 2px stroke, produced one manifest entry, and Undo restored the original layer.
- No renderer error or unhandled rejection was observed during the interaction pass.

## Comparison history

1. P2: the first implementation placed open-section chevrons before the title, pushing titles to the far right, and its 31px controls made the inspector visibly looser than the reference.
2. Fix: titles were restored to the left, the inspector narrowed from 274px to 252px, controls and section headers were compacted, and the constraints area gained a dedicated visual state block.
3. Post-fix evidence: `.codex-editor-inspector-comparison.png` shows matching section order, left-aligned titles, comparable control density, paired property fields, and the same collapsed-section treatment. No actionable P0/P1/P2 difference remains.

## Findings

No actionable P0/P1/P2 differences remain for the requested Figma editing model.

P3 follow-up: vector-path-specific operations and editable gradient stops remain a later capability. Crank currently preserves an SVG/image's original paint rather than presenting a control that cannot truthfully edit it.

## Implementation checklist

- [x] Replace the generic Properties form with Figma-style grouped sections.
- [x] Make alignment, position, dimensions, aspect lock, rotation, flip, opacity, radius, fill, stroke, visibility, and effects functional.
- [x] Keep every edit undoable and represented in the change manifest.
- [x] Preserve original paint where the captured layer is still an opaque SVG or image.
- [x] Verify the production Electron build at its real window size.

final result: passed
