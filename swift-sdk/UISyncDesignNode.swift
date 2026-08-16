import SwiftUI

/// Add this file to an app target. Everything except the no-op public API is
/// stripped from Release builds.
public struct UISyncDesignNodeSnapshot: Identifiable, Equatable {
    public let id: String
    public var frame: CGRect
    public var cornerRadius: CGFloat?
    public var backgroundColor: String?
    public var fontSize: CGFloat?
    public var sourceHint: String
}

#if DEBUG
private struct UISyncDesignNodePreferenceKey: PreferenceKey {
    static var defaultValue: [String: UISyncDesignNodeSnapshot] = [:]

    static func reduce(
        value: inout [String: UISyncDesignNodeSnapshot],
        nextValue: () -> [String: UISyncDesignNodeSnapshot]
    ) {
        value.merge(nextValue()) { _, new in new }
    }
}

@MainActor
public final class UISyncDesignNodeRegistry: ObservableObject {
    public static let shared = UISyncDesignNodeRegistry()
    @Published public private(set) var nodes: [String: UISyncDesignNodeSnapshot] = [:]

    private init() {}

    fileprivate func update(_ nodes: [String: UISyncDesignNodeSnapshot]) {
        self.nodes = nodes
    }
}

private struct UISyncDesignNodeModifier: ViewModifier {
    let id: String
    let cornerRadius: CGFloat?
    let backgroundColor: String?
    let fontSize: CGFloat?
    let sourceHint: String

    func body(content: Content) -> some View {
        content
            .accessibilityIdentifier(id)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: UISyncDesignNodePreferenceKey.self,
                        value: [
                            id: UISyncDesignNodeSnapshot(
                                id: id,
                                frame: proxy.frame(in: .named("DesignCanvas")),
                                cornerRadius: cornerRadius,
                                backgroundColor: backgroundColor,
                                fontSize: fontSize,
                                sourceHint: sourceHint
                            )
                        ]
                    )
                }
            }
    }
}
#endif

public extension View {
    @ViewBuilder
    func designNode(
        _ id: String,
        cornerRadius: CGFloat? = nil,
        backgroundColor: String? = nil,
        fontSize: CGFloat? = nil,
        source: String? = nil,
        file: String = #fileID,
        line: Int = #line
    ) -> some View {
        #if DEBUG
        modifier(
            UISyncDesignNodeModifier(
                id: id,
                cornerRadius: cornerRadius,
                backgroundColor: backgroundColor,
                fontSize: fontSize,
                sourceHint: source ?? "\(file):\(line)"
            )
        )
        #else
        self
        #endif
    }
}

#if DEBUG
public enum UISyncDesignMode: String, CaseIterable {
    case interact = "Interact"
    case select = "Select"
}

public struct UISyncDesignCanvas<Content: View>: View {
    @State private var mode: UISyncDesignMode = .interact
    @State private var selectedID: String?
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .coordinateSpace(name: "DesignCanvas")
            .onPreferenceChange(UISyncDesignNodePreferenceKey.self) { nodes in
                UISyncDesignNodeRegistry.shared.update(nodes)
            }
            .overlay {
                UISyncDesignOverlay(mode: $mode, selectedID: $selectedID)
            }
    }
}

private struct UISyncDesignOverlay: View {
    @ObservedObject private var registry = UISyncDesignNodeRegistry.shared
    @Binding var mode: UISyncDesignMode
    @Binding var selectedID: String?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ForEach(Array(registry.nodes.values)) { node in
                Rectangle()
                    .fill(selectedID == node.id ? Color.blue.opacity(0.08) : Color.clear)
                    .overlay {
                        Rectangle().stroke(
                            selectedID == node.id ? Color.blue : Color.blue.opacity(0.52),
                            lineWidth: selectedID == node.id ? 2 : 1
                        )
                    }
                    .contentShape(Rectangle())
                    .frame(width: node.frame.width, height: node.frame.height)
                    .position(x: node.frame.midX, y: node.frame.midY)
                    .onTapGesture {
                        guard mode == .select else { return }
                        selectedID = node.id
                    }
                    .allowsHitTesting(mode == .select)
            }

            Picker("Design mode", selection: $mode) {
                ForEach(UISyncDesignMode.allCases, id: \.self) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 180)
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding(12)
        }
    }
}
#else
public struct UISyncDesignCanvas<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View { content }
}
#endif
