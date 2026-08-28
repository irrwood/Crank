#if DEBUG
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Reads the render tree SwiftUI actually drew, out of the live app.
///
/// SwiftUI hands nothing out. There is no view hierarchy to walk that
/// corresponds to what is on screen — `body` is a description, not a drawing,
/// and by the time anything is painted the structs are gone. What survives is
/// `DisplayList`, SwiftUI's own flattened list of drawing operations, held by
/// the renderer behind the hosting view. Every item in it carries the frame the
/// layout engine computed, an identity that is stable while the item stays on
/// screen, and typed content: a path, a colour, a string, an image.
///
/// It is reached by reflection rather than by linking against private symbols.
/// `Mirror` asks the Swift runtime for a type's fields, so it needs no mangled
/// names, no memory layouts and no dlsym, and a field that has been renamed
/// comes back missing instead of returning garbage or crashing. That is the
/// whole reason this is written the way it is: every lookup here is a `nil` on
/// the day Apple moves something, and `capture()` reports the gap rather than
/// producing a plausible wrong answer.
///
/// What is emitted is a faithful copy of the display list, not a design
/// document. Turning it into layers is the other side's job, and keeping the
/// two apart is what lets that half be tested without Xcode, a Simulator, and
/// several minutes of building.
enum CrankDisplayList {

    // MARK: - Reflection helpers

    /// A stored property by name, including ones a superclass declares.
    ///
    /// `Mirror.children` lists only what the immediate class declares. In a real
    /// app the view SwiftUI hosts is not `NSHostingView` but a subclass of it —
    /// `AppKitWindowHostingView` for a `WindowGroup` — whose own mirror has no
    /// children at all, so a lookup that stopped at the first level found
    /// nothing and reported the app as having no renderer.
    private static func field(_ value: Any, _ label: String) -> Any? {
        var mirror: Mirror? = Mirror(reflecting: value)
        while let current = mirror {
            if let match = current.children.first(where: { $0.label == label }) { return match.value }
            mirror = current.superclassMirror
        }
        return nil
    }

    /// The payload of a single-case enum or an `Optional`, with its case name.
    private static func payload(_ value: Any) -> (name: String, value: Any)? {
        guard let child = Mirror(reflecting: value).children.first else { return nil }
        return (child.label ?? "_", child.value)
    }

    private static func tupleElements(_ value: Any) -> [Any] {
        Mirror(reflecting: value).children.map { $0.value }
    }

    // MARK: - Colour

    /// SwiftUI resolves colours into linear light. Everything downstream — CSS,
    /// Figma, a hex string a person reads — is sRGB, and the two differ enough
    /// that a mid grey converted wrongly is visibly the wrong grey.
    private static func encodeSRGB(_ linear: Float) -> Double {
        let v = Double(max(0, min(1, linear)))
        return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055
    }

    private static func resolvedColor(_ value: Any) -> [String: Any]? {
        // `Color.Resolved` sits behind `ResolvedHDR.base` on newer SDKs and
        // directly on the paint on older ones; try the wrapper, then the value.
        let base = field(value, "base") ?? value
        guard let r = field(base, "linearRed") as? Float,
              let g = field(base, "linearGreen") as? Float,
              let b = field(base, "linearBlue") as? Float else { return nil }
        let a = (field(base, "opacity") as? Float) ?? 1
        return [
            "r": encodeSRGB(r), "g": encodeSRGB(g), "b": encodeSRGB(b),
            "a": Double(max(0, min(1, a)))
        ]
    }

    /// The fill behind a shape. A gradient or an image paint has no single
    /// colour; it is named rather than flattened to an average, so the other
    /// side can say "gradient, not captured" instead of inventing a colour.
    private static func paint(_ value: Any) -> [String: Any] {
        var out: [String: Any] = ["kind": "unknown"]
        let inner = field(value, "paint") ?? value
        let name = String(describing: type(of: inner))
        if let color = field(inner, "color"), let resolved = resolvedColor(color) {
            out["kind"] = "color"
            out["color"] = resolved
        } else if name.contains("Gradient") {
            out["kind"] = "gradient"
        }
        out["type"] = name
        return out
    }

    // MARK: - Text

    /// Font, size, weight and colour, read off the attributed string SwiftUI
    /// already built to draw the run. Reading the attributes is the only part
    /// of this file that touches a public API.
    private static func textStyle(_ styled: Any) -> [String: Any] {
        var out: [String: Any] = [:]
        guard let drawing = field(styled, "text"),
              let cache = field(drawing, "cache"),
              let attributed = field(cache, "string") as? NSAttributedString,
              attributed.length > 0 else { return out }
        out["string"] = attributed.string
        let attributes = attributed.attributes(at: 0, effectiveRange: nil)

        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        if let font = attributes[.font] as? NSFont {
            out["fontName"] = font.fontName
            out["fontSize"] = Double(font.pointSize)
            let traits = NSFontManager.shared.weight(of: font)
            out["weight"] = weightFromFontManager(traits)
        }
        if let color = attributes[.foregroundColor] as? NSColor,
           let srgb = color.usingColorSpace(.sRGB) {
            out["color"] = ["r": Double(srgb.redComponent), "g": Double(srgb.greenComponent),
                            "b": Double(srgb.blueComponent), "a": Double(srgb.alphaComponent)]
        }
        #elseif canImport(UIKit)
        if let font = attributes[.font] as? UIFont {
            out["fontName"] = font.fontName
            out["fontSize"] = Double(font.pointSize)
            out["weight"] = weightFromUIFont(font)
        }
        if let color = attributes[.foregroundColor] as? UIColor {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            if color.getRed(&r, green: &g, blue: &b, alpha: &a) {
                out["color"] = ["r": Double(r), "g": Double(g), "b": Double(b), "a": Double(a)]
            }
        }
        #endif

        if let paragraph = attributes[.paragraphStyle] as? NSParagraphStyle {
            switch paragraph.alignment {
            case .center: out["align"] = "center"
            case .right: out["align"] = "right"
            case .justified: out["align"] = "justify"
            default: out["align"] = "left"
            }
        }
        return out
    }

    #if canImport(AppKit) && !targetEnvironment(macCatalyst)
    /// AppKit reports weight on a -1...1 scale; CSS wants 100...900.
    private static func weightFromFontManager(_ weight: Int) -> Int {
        // NSFontManager's scale is 0...15 with 5 regular and 9 bold. Mapping it
        // by position rather than by those two anchors put every bold face at
        // 800, and a heading came back heavier than it is drawn.
        let table = [100, 100, 200, 300, 400, 400, 500, 600, 600, 700, 800, 900, 900, 900, 900, 900]
        return table[max(0, min(table.count - 1, weight))]
    }
    #endif

    #if canImport(UIKit)
    private static func weightFromUIFont(_ font: UIFont) -> Int {
        let traits = font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
        guard let raw = traits?[.weight] as? CGFloat else { return 400 }
        switch raw {
        case ..<(-0.6): return 100
        case ..<(-0.4): return 200
        case ..<(-0.2): return 300
        case ..<0.1: return 400
        case ..<0.3: return 500
        case ..<0.4: return 600
        case ..<0.6: return 700
        case ..<0.8: return 800
        default: return 900
        }
    }
    #endif

    // MARK: - Images

    /// The pixels behind a `GraphicsImage`, as a PNG.
    ///
    /// The display list holds the image as a platform object rather than as
    /// data, and which object depends on where it came from — a bitmap asset, a
    /// symbol rendered to a layer, a `CGImage` handed in directly. Rather than
    /// enumerate those cases, this looks for the first thing in the value that
    /// can be cast to something with pixels. A case nobody anticipated then
    /// still works, and a case that genuinely has no pixels returns nil and is
    /// reported as a gap.
    ///
    /// Capped at four times the size the image is drawn at: enough for a retina
    /// screen and a couple of steps of zoom, and never more than the image has.
    /// A portfolio's hero photo kept at its full width is megabytes that nothing
    /// can display.
    private static func pngBase64(_ value: Any, drawnSize: CGSize, scale: CGFloat) -> String? {
        var budget = 400
        guard let image = findCGImage(value, depth: 0, budget: &budget) else { return nil }
        let headroom: CGFloat = 4
        let maxWidth = max(1, drawnSize.width * headroom * max(scale, 1))
        let maxHeight = max(1, drawnSize.height * headroom * max(scale, 1))
        let source = downscaled(image, maxWidth: maxWidth, maxHeight: maxHeight)
            ?? recoded(image)
            ?? image
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, source, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data).base64EncodedString()
    }

    private static func downscaled(_ image: CGImage, maxWidth: CGFloat, maxHeight: CGFloat) -> CGImage? {
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let factor = min(1, min(maxWidth / max(width, 1), maxHeight / max(height, 1)))
        if factor >= 1 { return nil }
        let targetWidth = Int(max(1, (width * factor).rounded()))
        let targetHeight = Int(max(1, (height * factor).rounded()))
        // Always sRGB at 8 bits, never the source's own space. A screen captured
        // on a modern display comes back 16-bit in an extended range, and asking
        // for an 8-bit context in that space fails — so the resize silently
        // returned nothing and a "thumbnail" arrived at full size, three
        // megabytes of it, for a picture shown at a couple of hundred pixels.
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: targetWidth, height: targetHeight,
                  bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        return context.makeImage()
    }

    /// Bounded on purpose. An `NSImage` holds representations that hold caches
    /// that point back at the image, and an unbounded walk of that graph does
    /// not return — the first version of this hung the app before it could post
    /// anything, which looked exactly like a capture that had failed. Depth
    /// alone is not enough when a single level has hundreds of fields, so the
    /// number of values examined is capped too. The depth has to clear the
    /// wrappers SwiftUI puts between the image and its pixels — `contents`, the
    /// optional inside it, the layer, and that layer's own contents — so a cap
    /// of four stopped one field short of every image and found none of them.
    /// The same picture at the same size, in 8-bit sRGB. Only worth doing when
    /// it is not already that, which is what the bit-depth test is for.
    private static func recoded(_ image: CGImage) -> CGImage? {
        if image.bitsPerComponent <= 8 { return nil }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: image.width, height: image.height,
                  bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.makeImage()
    }

    private static func findCGImage(_ value: Any, depth: Int, budget: inout Int) -> CGImage? {
        if depth > 7 || budget <= 0 { return nil }
        budget -= 1
        // `CGImage` is a CoreFoundation type: a conditional cast from `Any` does
        // not reach it, and the compiler suggests comparing type IDs instead.
        // Boxing a Swift value as `AnyObject` is safe and simply reports some
        // other type ID, so the check cannot match the wrong thing.
        let object = value as AnyObject
        if CFGetTypeID(object) == CGImage.typeID {
            return unsafeBitCast(object, to: CGImage.self)
        }
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        if let image = value as? NSImage {
            var rect = CGRect(origin: .zero, size: image.size)
            if let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) { return cg }
        }
        #endif
        #if canImport(UIKit)
        if let image = value as? UIImage, let cg = image.cgImage { return cg }
        #endif
        var mirror: Mirror? = Mirror(reflecting: value)
        while let current = mirror {
            for child in current.children {
                if let found = findCGImage(child.value, depth: depth + 1, budget: &budget) { return found }
            }
            mirror = current.superclassMirror
        }
        return nil
    }

    // MARK: - Screenshot

    /// A picture of the screen as it stood when the display list was read.
    ///
    /// A page read from the render tree has no exported PDF, and so had nothing
    /// to show in the sidebar — the layers are the page, but a list of layers is
    /// not something a person recognises a screen by. This is taken from the
    /// same view at the same moment, so what the sidebar shows and what the
    /// layers say are the same frame rather than two runs that drifted.
    ///
    /// Capped at 1400 points on the long side. A thumbnail is looked at, not
    /// zoomed into, and a full-resolution capture of every screen is tens of
    /// megabytes held in memory for no one.
    private static func screenshot(of view: AnyObject) -> String? {
        var image: CGImage?
        #if canImport(UIKit)
        if let uiView = view as? UIView, uiView.bounds.width > 1, uiView.bounds.height > 1 {
            let renderer = UIGraphicsImageRenderer(bounds: uiView.bounds)
            image = renderer.image { _ in
                uiView.drawHierarchy(in: uiView.bounds, afterScreenUpdates: false)
            }.cgImage
        }
        #elseif canImport(AppKit)
        if let nsView = view as? NSView, nsView.bounds.width > 1, nsView.bounds.height > 1,
           let rep = nsView.bitmapImageRepForCachingDisplay(in: nsView.bounds) {
            nsView.cacheDisplay(in: nsView.bounds, to: rep)
            image = rep.cgImage
        }
        #endif
        guard let source = image else { return nil }
        let bounded = downscaled(source, maxWidth: 1400, maxHeight: 1400) ?? recoded(source) ?? source
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, bounded, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data).base64EncodedString()
    }

    // MARK: - Items

    private static func rect(_ value: Any) -> [String: Any]? {
        guard let frame = value as? CGRect, frame.width.isFinite, frame.height.isFinite,
              frame.origin.x.isFinite, frame.origin.y.isFinite else { return nil }
        return ["x": Double(frame.origin.x), "y": Double(frame.origin.y),
                "width": Double(frame.width), "height": Double(frame.height)]
    }

    private static func items(_ list: Any, depth: Int) -> [[String: Any]] {
        // A deeply nested list is a bug somewhere else; stopping is better than
        // recursing until the stack goes.
        guard depth < 64, let itemsField = field(list, "items") else { return [] }
        var out: [[String: Any]] = []
        for item in Mirror(reflecting: itemsField).children.map({ $0.value }) {
            guard let frame = field(item, "frame").flatMap(rect) else { continue }
            var node: [String: Any] = ["frame": frame]
            if let identity = field(item, "identity"), let raw = field(identity, "value") {
                node["identity"] = String(describing: raw)
            }
            guard let value = field(item, "value"), let (caseName, caseValue) = payload(value) else {
                node["kind"] = "empty"
                out.append(node)
                continue
            }

            switch caseName {
            case "content":
                let seed = field(caseValue, "seed").map { String(describing: $0) }
                if let seed { node["seed"] = seed }
                guard let inner = field(caseValue, "value"), let (contentCase, contentValue) = payload(inner) else {
                    node["kind"] = "empty"
                    break
                }
                node["kind"] = contentCase
                switch contentCase {
                case "color":
                    if let resolved = resolvedColor(field(contentValue, "color") ?? contentValue) {
                        node["fill"] = ["kind": "color", "color": resolved]
                    }
                case "shape":
                    let parts = tupleElements(contentValue)
                    if parts.count >= 1 { node["path"] = String(describing: parts[0]) }
                    if parts.count >= 2 { node["fill"] = paint(parts[1]) }
                case "text":
                    let parts = tupleElements(contentValue)
                    if let styled = parts.first {
                        let style = textStyle(styled)
                        node["text"] = style["string"] as? String ?? ""
                        node["textStyle"] = style.filter { $0.key != "string" }
                    }
                    if parts.count >= 2, let size = parts[1] as? CGSize {
                        node["textSize"] = ["width": Double(size.width), "height": Double(size.height)]
                    }
                case "image":
                    let scale = (field(contentValue, "scale") as? CGFloat) ?? 1
                    if let size = field(contentValue, "unrotatedPixelSize") as? CGSize {
                        node["imageSize"] = ["width": Double(size.width), "height": Double(size.height)]
                    }
                    let drawn = CGSize(width: frame["width"] as? Double ?? 0, height: frame["height"] as? Double ?? 0)
                    if let png = pngBase64(contentValue, drawnSize: drawn, scale: scale) {
                        node["png"] = png
                    }
                case "backdrop":
                    // A material: the screen behind it, shrunk, blurred and
                    // tinted. The blur is measured in the shrunken image's own
                    // pixels, so it is scaled back up to the points a layer is
                    // drawn in — a radius of 60 at quarter scale is 15 on
                    // screen, and passing 60 through blurred a card into fog.
                    if let resolved = resolvedColor(field(contentValue, "color") ?? contentValue) {
                        node["fill"] = ["kind": "color", "color": resolved]
                    }
                    let backdropScale = number(field(contentValue, "scale")) ?? 1
                    if let filters = field(contentValue, "filters") {
                        for filter in Mirror(reflecting: filters).children.map({ $0.value }) {
                            guard let (filterName, filterValue) = payload(filter) else { continue }
                            if filterName == "blur", let radius = number(field(filterValue, "radius")) {
                                node["backdropBlur"] = radius * backdropScale
                            } else if filterName == "saturation", let amount = number(filterValue) {
                                node["backdropSaturation"] = amount
                            }
                        }
                    }
                case "chameleonColor":
                    // The tint a material lays over its own blur. Its colour is
                    // the one to fall back to when the thing behind cannot be
                    // sampled, which is exactly this situation, and it is held
                    // under `fallback` rather than under `color`.
                    if let resolved = resolvedColor(field(contentValue, "fallback") ?? contentValue) {
                        node["fill"] = ["kind": "color", "color": resolved]
                    }
                case "platformView", "platformLayer", "drawing", "view":
                    // An opaque renderer. Named, so the other side rasterises
                    // this box alone rather than giving up on the whole screen.
                    node["opaque"] = true
                default:
                    break
                }

            case "effect":
                let parts = tupleElements(caseValue)
                node["kind"] = "effect"
                if let effect = parts.first {
                    node["effect"] = payload(effect)?.name ?? String(describing: effect)
                    // How see-through the effect makes what is inside it. Only
                    // the effect's *name* used to be kept, so a tint applied at
                    // five per cent was drawn at full strength.
                    if let (name, effectValue) = payload(effect), name == "opacity",
                       let amount = number(effectValue) {
                        node["opacity"] = amount
                    }
                    if let (name, effectValue) = payload(effect), name == "filter",
                       let (filterName, filterValue) = payload(effectValue) {
                        node["filter"] = filterName
                        // `.blur(radius:)` on content. SwiftUI's radius is a
                        // standard deviation, which is what CSS's `blur()`
                        // takes and twice what a shadow's blur length takes —
                        // hence the doubling on one and not on the other.
                        if filterName == "blur", let radius = number(field(filterValue, "radius")) {
                            node["blur"] = radius
                        }
                        if filterName == "shadow" {
                            var shadow: [String: Any] = [:]
                            if let radius = field(filterValue, "radius") as? CGFloat { shadow["radius"] = Double(radius) }
                            if let offset = field(filterValue, "offset") as? CGSize {
                                shadow["dx"] = Double(offset.width); shadow["dy"] = Double(offset.height)
                            }
                            if let color = field(filterValue, "color"), let resolved = resolvedColor(color) {
                                shadow["color"] = resolved
                            }
                            node["shadow"] = shadow
                        }
                    }
                }
                if parts.count >= 2 { node["children"] = items(parts[1], depth: depth + 1) }

            case "states":
                node["kind"] = "states"

            default:
                node["kind"] = caseName
            }
            out.append(node)
        }
        return out
    }

    // MARK: - Entry point

    /// The live display list of `hostingView`, or `nil` with a reason.
    ///
    /// The path walked here — `renderer.renderer.<some>.lastList` — is the only
    /// part that is a guess about someone else's private field names, so it is
    /// the only part that reports which step failed.
    /// Every stored property visible on a value, including inherited ones. Used
    /// only to say what was actually there when a lookup fails: "no renderer on
    /// NSHostingView" is a bug report, "no renderer on it, but it has these
    /// fields" is the fix.
    /// A number SwiftUI stored as whatever width it felt like.
    ///
    /// `BackdropEffect.scale` and an opacity effect are `Float`, a shadow's
    /// radius is `CGFloat`. Casting to one of them returned nil for the others,
    /// which is how a material's blur arrived four times too strong and a five
    /// per cent tint arrived at full strength.
    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let value as Double: return value
        case let value as CGFloat: return Double(value)
        case let value as Float: return Double(value)
        case let value as Int: return Double(value)
        default: return nil
        }
    }

    private static func fieldNames(_ value: Any) -> [String] {
        var names: [String] = []
        var mirror: Mirror? = Mirror(reflecting: value)
        while let current = mirror {
            names.append(contentsOf: current.children.compactMap { $0.label })
            mirror = current.superclassMirror
        }
        return names
    }

    /// Field names worth following on the way to the renderer.
    ///
    /// The chain is not the same on every platform: on macOS the hosting view
    /// holds `renderer` directly, and on iOS `_UIHostingView` holds `_base` and
    /// the renderer is inside that. Rather than encode one path per platform —
    /// which is a list that is wrong the moment there is a platform nobody
    /// tested — the walk follows any of a few plausible names and stops at the
    /// first `DisplayList` it reaches. `some` is how `Mirror` labels the value
    /// inside an `Optional`.
    private static let rendererPath: Set<String> = [
        "renderer", "_base", "base", "host", "some", "value", "viewGraph"
    ]

    /// The display list reachable from `value`, if any.
    private static func findDisplayList(_ value: Any, depth: Int) -> Any? {
        if depth > 6 { return nil }
        var mirror: Mirror? = Mirror(reflecting: value)
        while let current = mirror {
            for child in current.children {
                let name = String(describing: type(of: child.value))
                // The list itself, rather than one of the identities and caches
                // that also carry `DisplayList` in their type name.
                if name == "DisplayList", Mirror(reflecting: child.value).children.contains(where: { $0.label == "items" }) {
                    return child.value
                }
                guard let label = child.label else { continue }
                if label == "lastList" || label == "currentList" {
                    if Mirror(reflecting: child.value).children.contains(where: { $0.label == "items" }) {
                        return child.value
                    }
                }
                if rendererPath.contains(label), let found = findDisplayList(child.value, depth: depth + 1) {
                    return found
                }
            }
            mirror = current.superclassMirror
        }
        return nil
    }

    /// The live display list of `hostingView`, or `nil` with a reason.
    ///
    /// Reflection is the whole mechanism here, so a field Apple renames comes
    /// back missing rather than wrong. When that happens the failure names the
    /// view's real type and the fields it actually had, because the next person
    /// to look at this needs the shape in front of them — finding out that iOS
    /// nests the renderer under `_base` took a build, a Simulator and a guess.
    static func capture(hostingView: AnyObject) -> [String: Any] {
        guard let list = findDisplayList(hostingView, depth: 0) else {
            return [
                "ok": false,
                "reason": "no display list reachable from \(type(of: hostingView))",
                "found": fieldNames(hostingView).prefix(40).joined(separator: ", ")
            ]
        }
        var viewport: [String: Any] = [:]
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        if let view = hostingView as? NSView {
            viewport = ["width": Double(view.bounds.width), "height": Double(view.bounds.height)]
        }
        #endif
        #if canImport(UIKit)
        if let view = hostingView as? UIView {
            viewport = ["width": Double(view.bounds.width), "height": Double(view.bounds.height)]
        }
        #endif
        return [
            "ok": true,
            "viewport": viewport,
            "items": items(list, depth: 0),
            // What SwiftUI itself prints. Kept beside the parsed items because
            // it is the only record of anything this file did not know to read,
            // and it costs one string.
            "description": String(describing: list)
        ]
    }

    /// Captures several hosting views as one screen.
    ///
    /// On iOS a SwiftUI screen is often not one render tree. A `NavigationSplitView`,
    /// a `TabView`, a `List` row — these are UIKit containers, and SwiftUI hosts
    /// its content inside them in *nested* hosting views, each with a display
    /// list of its own. The outermost list then holds nothing but an opaque
    /// placeholder where the container is, which is why capturing only the root
    /// brought back Apple's own sample app as a single grey rectangle.
    ///
    /// So every hosting view on screen is captured, and each is placed at the
    /// frame it occupies in the window. `frames` is in window coordinates and
    /// must be the same length as `views`.
    static func captureAll(views: [AnyObject], frames: [CGRect], viewport: CGRect) -> [String: Any] {
        var roots: [[String: Any]] = []
        var reasons: [String] = []
        for (index, view) in views.enumerated() {
            guard let list = findDisplayList(view, depth: 0) else {
                reasons.append("\(type(of: view)): no display list")
                continue
            }
            let captured = items(list, depth: 0)
            if captured.isEmpty { continue }
            let frame = index < frames.count ? frames[index] : .zero
            roots.append([
                "kind": "effect",
                "effect": "hosting-view",
                "frame": [
                    "x": Double(frame.origin.x), "y": Double(frame.origin.y),
                    "width": Double(frame.width), "height": Double(frame.height)
                ],
                "children": captured
            ])
        }
        if roots.isEmpty {
            return [
                "ok": false,
                "reason": reasons.isEmpty ? "nothing on screen reported a display list" : reasons.joined(separator: "; ")
            ]
        }
        var payload: [String: Any] = [
            "ok": true,
            "viewport": ["width": Double(viewport.width), "height": Double(viewport.height)],
            "items": roots
        ]
        // Taken from the outermost hosting view, which is the one that covers
        // the window; the nested ones are pieces of the same picture.
        if let outermost = views.first, let png = screenshot(of: outermost) {
            payload["screenshot"] = png
        }
        return payload
    }

    static func captureAllJSON(views: [AnyObject], frames: [CGRect], viewport: CGRect) -> String {
        return encode(captureAll(views: views, frames: frames, viewport: viewport))
    }

    private static func encode(_ payload: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"ok\":false,\"reason\":\"the capture could not be encoded\"}"
        }
        return text
    }

    static func captureJSON(hostingView: AnyObject) -> String {
        let payload = capture(hostingView: hostingView)
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"ok\":false,\"reason\":\"the capture could not be encoded\"}"
        }
        return text
    }
}
#endif
