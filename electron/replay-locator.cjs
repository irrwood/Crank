/**
 * Turns a control observed during discovery into something that can be found
 * again after the renderer remounts.
 *
 * React 19 and Base UI generate ids such as `_r_7_` and `base-ui-_r_p_`.
 * Cursor recreated those ids between discovery and capture, so Crank counted
 * 22 states but could only photograph five of them. Authored ids and test ids
 * remain the first choice; this semantic form is the fallback for controls
 * whose runtime instance has no durable DOM identity.
 */

const SEMANTIC_PREFIX = "crank:a11y:";

function isStableDomId(value) {
  const id = String(value ?? "").trim();
  if (!id || /^[0-9]/.test(id)) return false;
  if (/(?:^|[-_:])_?r_[a-z0-9]+_?$/i.test(id)) return false;
  if (/:r[a-z0-9]+:$/i.test(id)) return false;
  return true;
}

function semanticLocator(role, tag, name, index = 0) {
  return `crank:a11y:${JSON.stringify({
    role: String(role ?? "").toLowerCase(),
    tag: String(tag ?? "").toLowerCase(),
    name: String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
    index: Number.isInteger(index) && index >= 0 ? index : 0
  })}`;
}

/** Runs inside the captured page; it must close over nothing. */
function findReplayElement(locator) {
  if (typeof locator !== "string") return null;
  if (!locator.startsWith("crank:a11y:")) {
    try { return document.querySelector(locator); } catch { return null; }
  }

  let wanted;
  try { wanted = JSON.parse(locator.slice("crank:a11y:".length)); } catch { return null; }
  const accessibleName = (element) => (
    element.getAttribute("aria-label")
    || (element.innerText || element.textContent || "").trim()
    || element.getAttribute("title")
    || ""
  ).replace(/\s+/g, " ").slice(0, 60);
  const roleOf = (element) => {
    const declared = element.getAttribute("role");
    if (declared) return declared.toLowerCase();
    if (element.tagName === "BUTTON") return "button";
    if (element.tagName === "A" && element.hasAttribute("href")) return "link";
    if (element.tagName === "INPUT") return "textbox";
    return "";
  };
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };

  const matches = Array.from(document.querySelectorAll("button,a[href],[role],[aria-label],[title],nav [class*=item],[class*=tab]:not([role])"))
    .filter((element) => (
      (!wanted.role || roleOf(element) === wanted.role)
      && (!wanted.tag || element.tagName.toLowerCase() === wanted.tag)
      && accessibleName(element) === wanted.name
      && visible(element)
    ));
  return matches[wanted.index ?? 0] ?? matches[0] ?? null;
}

function replayClickScript(locator) {
  return `(() => {
    const findReplayElement = (${findReplayElement.toString()});
    const element = findReplayElement(${JSON.stringify(locator)});
    if (!element) return false;
    element.scrollIntoView({ block: "center" });
    element.click();
    return true;
  })()`;
}

module.exports = { SEMANTIC_PREFIX, findReplayElement, isStableDomId, replayClickScript, semanticLocator };
