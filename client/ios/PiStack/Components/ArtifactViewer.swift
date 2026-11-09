import PiStackKit
import QuickLook
import SwiftUI

extension EnvironmentValues {
    @Entry var openArtifact: (ArtifactAddress, String) -> Void = { _, _ in }
    @Entry var artifactZoom: Namespace.ID? = nil
}

private struct ArtifactOpening: Hashable {
    let address: ArtifactAddress
    let source: String
}

private struct ArtifactPage: View {
    let item: ArtifactAddress
    let botId: String
    let api: Api

    var body: some View {
        let title = (item.fileName as NSString).deletingPathExtension
        let load = { try await api.artifactText(botId, name: item.name, version: item.version) }
        if item.isHTML {
            HTMLDocument(title: title, load: load)
        } else {
            MarkdownDocument(title: title, load: load)
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
    @Namespace private var zoom
    @State private var opening: ArtifactOpening?
    @State private var preview: URL?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.openArtifact) { open($0, source: $1) }
            .environment(\.artifactZoom, zoom)
            .navigationDestination(item: $opening) { item in
                ArtifactPage(item: item.address, botId: botId, api: api)
                    .navigationTransition(.zoom(sourceID: item.source, in: zoom))
            }
            .quickLookPreview($preview)
            .alert("无法打开", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("好") {}
            } message: {
                Text(problem ?? "")
            }
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
    func artifactViewer(botId: String, api: Api) -> some View {
        modifier(ArtifactViewer(botId: botId, api: api))
    }

    func artifactSource(_ id: String, radius: CGFloat) -> some View {
        modifier(ArtifactSource(id: id, radius: radius))
    }
}
