import Observation
import PiStackKit
import QuickLook
import SwiftUI

extension EnvironmentValues {
    @Entry var openArtifact: (ArtifactAddress, String) -> Void = { _, _ in }
    @Entry var openSpace: (ArtifactAddress, SpaceOpening, String) -> Void = { _, _, _ in }
    @Entry var artifactDownloads: ArtifactDownloads? = nil
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
        let cached = { await api.loadCachedArtifactText(botId, address: item) }
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

final class DownloadedArtifact: Sendable {
    let url: URL

    init(_ url: URL) { self.url = url }

    deinit { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

@MainActor
@Observable
final class ArtifactDownloads {
    private struct Selection: Equatable {
        let source: String
        let token = UUID()
    }

    private var selection: Selection?
    private var waiting = false
    @ObservationIgnored private var transfers: [URL: Task<DownloadedArtifact, Error>] = [:]
    @ObservationIgnored private let files = NSCache<NSURL, DownloadedArtifact>()

    init() {
        files.countLimit = 12
    }

    func isWaiting(_ source: String) -> Bool {
        waiting && selection?.source == source
    }

    func cancel(source: String? = nil) {
        guard source == nil || selection?.source == source else { return }
        selection = nil
        waiting = false
    }

    func open(_ item: ArtifactAddress, source: String, botId: String, api: Api, finish: @escaping (Result<DownloadedArtifact, Error>) -> Void) {
        guard selection?.source != source else { return }
        let selection = Selection(source: source)
        self.selection = selection
        waiting = false
        let feedback = Task {
            try await Task.sleep(for: .milliseconds(180))
            if self.selection == selection { waiting = true }
        }
        Task {
            let result: Result<DownloadedArtifact, Error>
            do {
                result = .success(try await file(item, botId: botId, api: api))
            } catch {
                result = .failure(error)
            }
            feedback.cancel()
            guard self.selection == selection else { return }
            cancel()
            finish(result)
        }
    }

    func file(_ item: ArtifactAddress, botId: String, api: Api) async throws -> DownloadedArtifact {
        let key = api.artifactURL(botId, item)
        if item.version != nil, let cached = files.object(forKey: key as NSURL) {
            return cached
        }
        if let transfer = transfers[key] { return try await transfer.value }
        let transfer = Task { DownloadedArtifact(try await api.download(key, as: item.fileName)) }
        transfers[key] = transfer
        defer { transfers[key] = nil }
        let file = try await transfer.value
        if item.version != nil { files.setObject(file, forKey: key as NSURL) }
        return file
    }
}

private struct ArtifactDownloadFeedback: ViewModifier {
    let source: String
    @Environment(\.artifactDownloads) private var downloads

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if downloads?.isWaiting(source) == true {
                    ProgressView()
                        .accessibilityLabel("正在下载")
                        .padding(10)
                        .background(.regularMaterial, in: Circle())
                        .padding(8)
                        .allowsHitTesting(false)
                }
            }
            .onDisappear { downloads?.cancel(source: source) }
    }
}

@MainActor
private struct ArtifactViewer: ViewModifier {
    let botId: String
    let api: Api
    let panel: PanelState
    @Namespace private var zoom
    @State private var downloads = ArtifactDownloads()
    @State private var opening: ArtifactOpening?
    @State private var preview: URL?
    @State private var previewFile: DownloadedArtifact?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.openArtifact) { open($0, source: $1) }
            .environment(\.openSpace) {
                downloads.cancel()
                problem = nil
                opening = ArtifactOpening(address: $0, source: $2, space: $1)
            }
            .environment(\.artifactDownloads, downloads)
            .onDisappear { downloads.cancel() }
            .onChange(of: botId) { downloads.cancel() }
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
        downloads.cancel()
        problem = nil
        opening = ArtifactOpening(address: address, source: "space-\(id)", space: SpaceOpening(id: id, title: widget.title, showUpdates: true, refresh: refresh))
        SpacePush.shared.opened(id)
    }

    private func open(_ item: ArtifactAddress, source: String) {
        problem = nil
        if item.isMarkdown || item.isHTML {
            downloads.cancel()
            opening = ArtifactOpening(address: item, source: source)
            return
        }
        downloads.open(item, source: source, botId: botId, api: api) { result in
            switch result {
            case .success(let file):
                previewFile = file
                preview = file.url
            case .failure(let error): problem = error.localizedDescription
            }
        }
    }
}

extension View {
    @MainActor
    func artifactViewer(botId: String, api: Api, panel: PanelState) -> some View {
        modifier(ArtifactViewer(botId: botId, api: api, panel: panel))
    }

    func artifactDownloadFeedback(_ source: String) -> some View {
        modifier(ArtifactDownloadFeedback(source: source))
    }

    func artifactSource(_ id: String, radius: CGFloat) -> some View {
        modifier(ArtifactSource(id: id, radius: radius))
    }
}

extension Api {
    func loadCachedArtifactText(_ botId: String, address: ArtifactAddress) async -> String? {
        await Task.detached(priority: .userInitiated) {
            cachedArtifactText(botId, name: address.name, version: address.version)
        }.value
    }
}
