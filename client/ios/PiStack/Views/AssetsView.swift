import PiStackKit
import QuickLookThumbnailing
import SwiftUI

struct AssetsView: View {
    let items: [AssetItem]
    let botId: String
    let api: Api
    let onDrop: (String) -> Void
    let onOrder: ([String]) -> Void
    @Environment(\.topInset) private var topInset
    @State private var editing = false
    @State private var opening: ArtifactAddress?

    private let columns = [GridItem(.adaptive(minimum: 156), spacing: 12)]

    var body: some View {
        ScrollView {
            Group {
                if items.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("资产").font(.largeTitle.weight(.bold))
                        Text("bot 发来的文件卡片，右滑就能收进这里。").font(.title3).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.top, 40)
                } else {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(items) { item in
                            Button { opening = ArtifactAddress(item.ref) } label: {
                                AssetCard(item: item, botId: botId, api: api)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("拷贝引用", systemImage: "link") { UIPasteboard.general.string = item.ref }
                                Button("调整排布", systemImage: "square.grid.2x2") { editing = true }
                                Button("从资产移除", systemImage: "minus.circle", role: .destructive) { onDrop(item.origin) }
                            }
                            .editable(editing, seed: abs(item.id.hashValue), radius: 24) { onDrop(item.origin) }
                            .reorderable(item.id, editing: editing) { dragged, target in
                                onOrder(items.map(\.id).moved(dragged, to: target))
                            }
                        }
                    }
                    .animation(.snappy, value: items.map(\.id))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .contentMargins(.top, topInset, for: .scrollContent)
        .doneBar(editing) { editing = false }
        .onChange(of: items.isEmpty) { _, empty in if empty { editing = false } }
        .artifactViewer($opening, botId: botId, api: api)
    }
}

private struct AssetCard: View {
    let item: AssetItem
    let botId: String
    let api: Api

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AssetPage(address: ArtifactAddress(item.ref), botId: botId, api: api)
                .frame(height: 176)
                .frame(maxWidth: .infinity)
                .background(Color.paper)
                .clipShape(.rect(cornerRadius: 14, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.06)) }
                .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.leading)
                Text(Date(timeIntervalSince1970: item.savedAt / 1000), format: .dateTime.month().day())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
        }
        .padding(10)
        .frosted(24)
        .contentShape(.rect(cornerRadius: 24, style: .continuous))
    }
}

struct AssetPage: View {
    let address: ArtifactAddress?
    let botId: String
    let api: Api
    var scale: CGFloat = 0.5
    @State private var text: String?
    @State private var thumbnail: UIImage?

    var body: some View {
        Group {
            if let thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else if let text {
                Color.clear.overlay(alignment: .topLeading) {
                    MarkdownText(text: String(text.prefix(1200)), document: true)
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
        guard let address else { return }
        if address.isMarkdown {
            text = try? await api.artifactText(botId, name: address.name, version: address.version)
            return
        }
        guard let file = try? await api.download(api.artifactURL(botId, address), as: address.fileName) else { return }
        let request = QLThumbnailGenerator.Request(fileAt: file, size: CGSize(width: 320, height: 400), scale: 2, representationTypes: .thumbnail)
        thumbnail = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
    }
}
