import LuluKit
import QuickLookThumbnailing
import SwiftUI

struct AssetPage: View {
    let address: ArtifactAddress?
    let botId: String
    let api: Api
    var scale: CGFloat = 0.5
    @Environment(\.artifactDownloads) private var downloads
    @State private var excerpt: String?
    @State private var thumbnail: UIImage?

    var body: some View {
        Group {
            if let thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else if let excerpt {
                Color.clear.overlay(alignment: .topLeading) {
                    MarkdownText(text: excerpt, document: true)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: 272, alignment: .topLeading)
                        .padding(20)
                        .scaleEffect(scale, anchor: .topLeading)
                }
                .allowsHitTesting(false)
            } else {
                Color.clear
            }
        }
        .clipped()
        .mask(LinearGradient(stops: [.init(color: .black, location: 0.82), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
        .task(id: address?.id) { await load() }
    }

    private func load() async {
        guard !Task.isCancelled else { return }
        excerpt = nil
        thumbnail = nil
        guard let address else { return }
        if address.isMarkdown {
            let cached = await api.loadCachedArtifactText(botId, address: address)
            guard !Task.isCancelled else { return }
            excerpt = cached.map { String($0.prefix(1200)) }
            let loaded = try? await api.artifactText(botId, name: address.name, version: address.version)
            guard !Task.isCancelled else { return }
            if let loaded {
                let next = String(loaded.prefix(1200))
                if excerpt != next { excerpt = next }
            }
            return
        }
        guard let downloads, let file = try? await downloads.file(address, botId: botId, api: api) else { return }
        guard !Task.isCancelled else { return }
        let thumbnailScale = min(1, scale * 2)
        let size = CGSize(width: 320 * thumbnailScale, height: 400 * thumbnailScale)
        let request = QLThumbnailGenerator.Request(fileAt: file.url, size: size, scale: 2, representationTypes: .thumbnail)
        let image = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
        withExtendedLifetime(file) {}
        guard !Task.isCancelled else { return }
        thumbnail = image
    }
}
