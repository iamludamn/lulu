import PiStackKit
import QuickLook
import SwiftUI

private struct ArtifactViewer: ViewModifier {
    @Binding var address: ArtifactAddress?
    let botId: String
    let api: Api
    @State private var reading: ArtifactAddress?
    @State private var preview: URL?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .onChange(of: address) { _, next in
                guard let next else { return }
                address = nil
                open(next)
            }
            .sheet(item: $reading) { item in
                NavigationStack {
                    let title = (item.fileName as NSString).deletingPathExtension
                    let load = { try await api.artifactText(botId, name: item.name, version: item.version) }
                    if item.isHTML {
                        HTMLDocument(title: title, load: load)
                    } else {
                        MarkdownDocument(title: title, load: load)
                    }
                }
            }
            .quickLookPreview($preview)
            .alert("无法打开", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("好") {}
            } message: {
                Text(problem ?? "")
            }
    }

    private func open(_ item: ArtifactAddress) {
        if item.isMarkdown || item.isHTML {
            reading = item
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
    func artifactViewer(_ address: Binding<ArtifactAddress?>, botId: String, api: Api) -> some View {
        modifier(ArtifactViewer(address: address, botId: botId, api: api))
    }
}
