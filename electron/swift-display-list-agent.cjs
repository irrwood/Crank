const { readFile } = require("node:fs/promises");
const path = require("node:path");

/**
 * Puts the display-list capture agent into a copy of someone's app.
 *
 * Nothing is written to the project itself. The Design Build pipeline already
 * copies a project before it instruments it, and this appends to a file in that
 * copy — so there is no diff to review, nothing to commit, and nothing left
 * behind if a scan is interrupted.
 *
 * The agent is appended rather than added as a new file because adding a file
 * to an Xcode target means editing `project.pbxproj`, and a pbxproj edited by
 * a tool is the thing most likely to leave a project that no longer opens. A
 * file that is already in the target compiles whatever is at the bottom of it.
 *
 * Every symbol carries the same per-file suffix the rest of the instrumentation
 * uses. Two scans of the same project, or a project that already has something
 * called `CrankDisplayList` in it, must not collide.
 */

const AGENT_FILE = "CrankDisplayList.swift";

function swiftString(value) {
  return JSON.stringify(String(value));
}

/**
 * The agent itself, as it ships in `swift-sdk/`.
 *
 * Read from inside the archive rather than from a copy unpacked beside it: a
 * packaged build reads its own files out of `app.asar` transparently, and this
 * file is only ever read here and written into a copy of the project — nothing
 * outside the app opens it, which is the only reason to unpack anything.
 */
async function readAgentSource() {
  return readFile(path.join(__dirname, "..", "swift-sdk", AGENT_FILE), "utf8");
}

/**
 * The part that knows about this app rather than about SwiftUI: find the view
 * the app is hosted in, capture it, and post it.
 *
 * It waits for the window to exist rather than capturing at launch. A display
 * list read before the first frame is drawn is empty, and an empty capture is
 * indistinguishable from an app with nothing on screen — so it polls until the
 * renderer has produced one, and gives up with a reason rather than posting a
 * screen that is merely early.
 */
function shimSource({ endpoint, suffix, screenName }) {
  return `

#if DEBUG
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
import Foundation

@MainActor
enum _CrankDisplayListShim_${suffix} {
  /// Every view SwiftUI hosts content in, with the frame each occupies in the
  /// window.
  ///
  /// All of them, not the first: on iOS a screen is usually several nested
  /// hosting views separated by UIKit containers, and the outermost one holds
  /// only a placeholder where the container is. The search does not stop at a
  /// hosting view, because the ones inside it are where the content is.
  private static func hostingViews() -> (views: [AnyObject], frames: [CGRect], viewport: CGRect) {
    var views: [AnyObject] = []
    var frames: [CGRect] = []
    var viewport = CGRect.zero

    #if canImport(UIKit)
    func search(_ view: UIView, _ window: UIWindow) {
      if String(describing: type(of: view)).contains("HostingView") {
        views.append(view)
        frames.append(view.convert(view.bounds, to: window))
      }
      for child in view.subviews where !child.isHidden && child.alpha > 0.01 { search(child, window) }
    }
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .filter { !$0.isHidden }
    if let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first {
      viewport = window.bounds
      search(window, window)
    }
    #elseif canImport(AppKit)
    func search(_ view: NSView, _ root: NSView) {
      if String(describing: type(of: view)).contains("HostingView") {
        views.append(view)
        frames.append(view.convert(view.bounds, to: root))
      }
      for child in view.subviews where !child.isHidden { search(child, root) }
    }
    if let window = NSApplication.shared.windows.first(where: { $0.isVisible }), let root = window.contentView {
      viewport = root.bounds
      search(root, root)
    }
    #endif
    return (views, frames, viewport)
  }

  private static func post(_ body: String) {
    guard let url = URL(string: ${swiftString(endpoint)}) else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    // The pipeline reaches each screen by relaunching the app pointed at it, so
    // which screen this capture is of is only known at run time. The baked name
    // is the fallback for a project with a single screen and nothing to point at.
    let screen = ProcessInfo.processInfo.environment["UI_SYNC_PAGE_SOURCE_NAME"]
      ?? ProcessInfo.processInfo.environment["CRANK_SCREEN_NAME"]
      ?? ${swiftString(screenName)}
    request.setValue(screen, forHTTPHeaderField: "x-crank-screen-name")
    request.httpBody = Data(body.utf8)
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
    // Waited on because the process may be told to quit as soon as the scan has
    // what it wanted, and a capture still in flight would be lost.
    _ = done.wait(timeout: .now() + 5)
  }

  /// Captures once the app has drawn something, or reports why it could not.
  static func start(attempt: Int = 0) {
    let found = hostingViews()
    let payload = found.views.isEmpty
      ? ["ok": false, "reason": "this app has no SwiftUI hosting view on screen"] as [String: Any]
      : CrankDisplayList.captureAll(views: found.views, frames: found.frames, viewport: found.viewport)

    // Drawn but not yet rendered: a hosting view exists before its renderer has
    // produced a list, and the difference is a few frames. Retried rather than
    // reported, because "no display list" for an app that simply had not
    // finished launching is a wrong answer, not a missing one.
    if payload["ok"] as? Bool != true, attempt < 20 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { start(attempt: attempt + 1) }
      return
    }
    post(CrankDisplayList.captureAllJSON(views: found.views, frames: found.frames, viewport: found.viewport))
  }
}
#endif
`;
}

/**
 * Appends the agent and its shim to an already-instrumented source file.
 *
 * Only ever applied to the file that holds the app's entry point, so the agent
 * is compiled once. Applying it to every file would be a duplicate-symbol error
 * on the second one.
 */
async function attachDisplayListAgent(source, { endpoint, suffix, screenName = "Screen" }) {
  if (!/^[a-f0-9]{6,32}$/.test(String(suffix))) {
    throw new Error("A display-list agent needs the same hex suffix the rest of the instrumentation uses");
  }
  const agent = await readAgentSource();
  return `${source}\n${agent}\n${shimSource({ endpoint, suffix, screenName })}`;
}

/**
 * Starts the capture from the app's own launch.
 *
 * Swift has no `+load`, and a static initializer in an appended file is never
 * touched, so the shim has to be started by something that definitely runs. The
 * app's entry point is the one place guaranteed to, and `@main` marks it.
 *
 * Returns the source unchanged when there is no entry point to start from,
 * because that is what every file except one looks like.
 */
function startDisplayListCapture(source, suffix) {
  const entry = source.match(/@main\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*App\s*\{/);
  if (!entry) return { source, started: false };
  const insertAt = entry.index + entry[0].length;
  const initializer = `
#if DEBUG
  // Runs once, when the app type is created, which is before any window exists
  // — the shim waits for one rather than assuming it is already there.
  init() { Task { @MainActor in _CrankDisplayListShim_${suffix}.start() } }
#endif
`;
  return { source: source.slice(0, insertAt) + initializer + source.slice(insertAt), started: true };
}

module.exports = { attachDisplayListAgent, shimSource, startDisplayListCapture };
