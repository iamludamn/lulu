import PiStackKit
import QuickLook
import SwiftUI

extension EnvironmentValues {
    @Entry var openArtifact: (ArtifactAddress, String) -> Void = { _, _ in }
    @Entry var openSpace: (ArtifactAddress, SpaceOpening, String) -> Void = { _, _, _ in }
    @Entry var artifactZoom: Namespace.ID? = nil
}

/// A page opened as a space: `id` keys its saved state, `title` is the widget title. A preview is a card
/// still in chat: it reads the saved state but keeps what the page saves in memory only.
struct SpaceOpening: Hashable {
    let id: String
    let title: String
    var preview = false
    var showUpdates = false
    var refresh: SpaceRefresh = .manual
}

private struct ArtifactOpening: Hashable {
    let address: ArtifactAddress
    let source: String
    var space: SpaceOpening?
}

private struct ArtifactPage: View {
    let item: ArtifactAddress
    let space: SpaceOpening?
    let botId: String
    let api: Api
    let updates: SpaceUpdate?
    @State private var bridge: SpaceBridge?

    init(item: ArtifactAddress, space: SpaceOpening?, botId: String, api: Api, updates: SpaceUpdate?) {
        self.item = item
        self.space = space
        self.botId = botId
        self.api = api
        self.updates = updates
        _bridge = State(initialValue: space.map { SpaceBridge(botId: botId, space: $0.id, refresh: $0.refresh, preview: $0.preview, api: api, updates: updates) })
    }

    var body: some View {
        let title = space?.title ?? (item.fileName as NSString).deletingPathExtension
        let cached = { api.cachedArtifactText(botId, name: item.name, version: item.version) }
        let load = { try await api.artifactText(botId, name: item.name, version: item.version) }
        if item.isHTML {
            HTMLDocument(title: title, cached: cached, load: load, bridge: bridge, updates: updates, showUpdatesInitially: space?.showUpdates == true)
        } else {
            MarkdownDocument(title: title, cached: cached, load: load)
        }
    }
}

private struct ArtifactSource: ViewModifier {
    let id: String
    let radius: CGFloat
    @Environment(\.artifactZoom) private var zoom

    func body(content: Content) -> some View {
        if let zoom {
            content.matchedTransitionSource(id: id, in: zoom) { $0.clipShape(.rect(cornerRadius: radius, style: .continuous)) }
        } else {
            content
        }
    }
}

private struct ArtifactViewer: ViewModifier {
    let botId: String
    let api: Api
    let panel: PanelState
    @Namespace private var zoom
    @State private var opening: ArtifactOpening?
    @State private var preview: URL?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.openArtifact) { open($0, source: $1) }
            .environment(\.openSpace) { opening = ArtifactOpening(address: $0, source: $2, space: $1) }
            .environment(\.artifactZoom, zoom)
            .navigationDestination(item: $opening) { item in
                ArtifactPage(item: item.address, space: item.space, botId: botId, api: api, updates: item.space.flatMap { panel.spaceUpdates[$0.id] })
                    .navigationTransition(.zoom(sourceID: item.source, in: zoom))
            }
            .onReceive(NotificationCenter.default.publisher(for: .openSpaceUpdate)) { note in
                if let id = note.object as? String { openUpdates(id) }
            }
            .onChange(of: panel.order, initial: true) { _, _ in
                if let id = SpacePush.shared.pendingSpace { openUpdates(id) }
            }
            .quickLookPreview($preview)
            .alert("无法打开", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("好") {}
            } message: {
                Text(problem ?? "")
            }
    }

    private func openUpdates(_ id: String) {
        guard let widget = panel.widgets[id], case .space(let src, _, let refresh, _) = widget.body,
              let address = ArtifactAddress(src) else { return }
        opening = ArtifactOpening(address: address, source: "space-\(id)", space: SpaceOpening(id: id, title: widget.title, showUpdates: true, refresh: refresh))
        SpacePush.shared.opened(id)
    }

    private func open(_ item: ArtifactAddress, source: String) {
        if item.isMarkdown || item.isHTML {
            opening = ArtifactOpening(address: item, source: source)
            return
        }
        Task {
            do {
                preview = try await api.download(api.artifactURL(botId, item), as: item.fileName)
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

extension View {
    func artifactViewer(botId: String, api: Api, panel: PanelState) -> some View {
        modifier(ArtifactViewer(botId: botId, api: api, panel: panel))
    }

    func artifactSource(_ id: String, radius: CGFloat) -> some View {
        modifier(ArtifactSource(id: id, radius: radius))
    }
}
