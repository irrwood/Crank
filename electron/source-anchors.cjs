const path = require("node:path");

/**
 * Gives every JSX element an attribute naming where it was written.
 *
 * Identity derived from what a node looks like is a resemblance: two buttons
 * with the same label in the same container can only be told apart by their
 * order, and the pull direction has to find the source line by matching a CSS
 * selector and give up whenever the match is not unique. Where the element can
 * simply say which file and line it came from, neither problem exists.
 *
 * Nothing is written to the project. This runs as a transform in the server UI
 * Sync starts, so the attribute exists in the served JavaScript and in the
 * rendered DOM, and the file on disk is untouched — no diff to review, nothing
 * to commit, nothing to undo. That is the whole difference between this and the
 * editors that instrument a repository permanently.
 *
 * The path is relative to the project. An absolute one would carry someone's
 * home directory into the captured markup and from there into a handoff page.
 */

const SOURCE_ATTRIBUTE = "data-ui-sync-src";

/**
 * A Babel plugin, expressed as the plain function Babel expects, so it can be
 * handed to the project's own React plugin without UI Sync depending on Babel
 * at all.
 */
function createSourceAnchorPlugin(root) {
  return function sourceAnchors({ types: t }) {
    return {
      name: "ui-sync-source-anchors",
      visitor: {
        JSXOpeningElement(nodePath, state) {
          const start = nodePath.node.loc?.start;
          if (!start) return;

          // A fragment has no element to carry an attribute.
          if (nodePath.node.name?.type === "JSXFragment") return;
          const attributes = nodePath.node.attributes ?? [];
          const already = attributes.some(
            (attribute) => attribute.type === "JSXAttribute" && attribute.name?.name === SOURCE_ATTRIBUTE
          );
          if (already) return;

          // A spread may itself carry the attribute at runtime; adding a second
          // one would let whichever came last win unpredictably.
          const filename = state.filename || state.file?.opts?.filename;
          if (!filename) return;
          const relative = path.relative(root, filename);
          // Outside the project — a dependency's JSX, which has no source to
          // point at that would mean anything to the person scanning.
          if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;

          attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(SOURCE_ATTRIBUTE),
              t.stringLiteral(`${relative}:${start.line}:${start.column + 1}`)
            )
          );
        }
      }
    };
  };
}

/** Splits an anchor back into the place it names. */
function parseSourceAnchor(value) {
  const match = /^(.+):(\d+):(\d+)$/.exec(String(value ?? ""));
  if (!match) return null;
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

module.exports = { SOURCE_ATTRIBUTE, createSourceAnchorPlugin, parseSourceAnchor };
