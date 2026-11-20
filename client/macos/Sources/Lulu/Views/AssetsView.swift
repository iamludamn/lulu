import AppKit
import PiStackKit
import QuickLookThumbnailing
import SwiftUI

struct AssetsView: View {
    let items: [AssetItem]
    let botId: String
    let api: Api
    let width: CGFloat
    let onDrop: (String) -> Void
    let onOrder: ([String]) -> Void
    @Environment(\.openArtifact) private var openArtifact
    @State private var target: String?

    var body: some View {
        ScrollView {
            Group {
                if items.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("资产").type(30, .semibold, line: 38).tracking(-0.4)
                        Text("bot 发来的文件卡片，选「收进资产」就会出现在这里。").type(15, line: 21).foregroundStyle(Color.muted)
                    }
                    .foregroundStyle(Color.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 40)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 168, maximum: 240), spacing: 16)], spacing: 16) {
                        ForEach(items) { item in
                            Button { ArtifactAddress(item.ref).map(openArtifact) } label: {
                                AssetCard(item: item, botId: botId, api: api)
                            }
                            .buttonStyle(.plain)
                            .scaleEffect(target == item.id ? 1.04 : 1)
                            .contextMenu {
                                Button("打开", systemImage: "arrow.up.forward.app") { ArtifactAddress(item.ref).map(openArtifact) }
                                Button("拷贝引用", systemImage: "link") { copy(item.ref) }
                                Divider()
                                Button("从资产移除", systemImage: "minus.circle", role: .destructive) { onDrop(item.origin) }
                            }
                            .draggable(item.id) {
                                AssetCard(item: item, botId: botId, api: api).frame(width: 180)
                            }
                            .dropDestination(for: String.self) { ids, _ in
                                defer { target = nil }
                                guard let moved = ids.first, moved != item.id else { return false }
                                withAnimation(.snappy) { onOrder(items.map(\.id).moved(moved, to: item.id)) }
                                return true
                            } isTargeted: { inside in
                                withAnimation(.snappy(duration: 0.18)) { target = inside ? item.id : (target == item.id ? nil : target) }
                            }
                        }
                    }
                    .animation(.snappy, value: items.map(\.id))
                }
            }
            .frame(width: width)
            .padding(.top, ChatView.topInset)
            .padding(.bottom, 40)
            .frame(maxWidth: .infinity)
        }
        .mask {
            LinearGradient(stops: [.init(color: .clear, location: 0.03), .init(color: .black, location: 0.09)], startPoint: .top, endPoint: .bottom)
        }
    }
}

private struct AssetCard: View {
    let item: AssetItem
    let botId: String
    let api: Api
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AssetPage(address: ArtifactAddress(item.ref), botId: botId, api: api)
                .frame(height: 176)
                .frame(maxWidth: .infinity)
                .background(Color.paper)
                .clipShape(.rect(cornerRadius: 16, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line.opacity(0.5), lineWidth: 0.5) }
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .type(13, .semibold, line: 18)
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 4) {
                    Image(systemName: fileSymbol(ArtifactAddress(item.ref))).font(.system(size: 10, weight: .semibold))
                    Text(Date(timeIntervalSince1970: item.savedAt / 1000), format: .dateTime.month().day())
                }
                .type(12, line: 16)
                .foregroundStyle(Color.muted)
            }
            .padding(.horizontal, 6)
        }
        .foregroundStyle(Color.ink)
        .padding(10)
        .frosted(24)
        .scaleEffect(hovering ? 1.015 : 1)
        .onHover { hovering = $0 }
        .animation(.snappy(duration: 0.2), value: hovering)
        .contentShape(.rect(cornerRadius: 24, style: .continuous))
    }
}

struct AssetPage: View {
    let address: ArtifactAddress?
    let botId: String
    let api: Api
    var scale: CGFloat = 0.5
    @State private var text: String?
    @State private var thumbnail: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let thumbnail {
                Color.clear.overlay { Image(nsImage: thumbnail).resizable().scaledToFill() }
            } else if let text {
                Color.clear.overlay(alignment: .topLeading) {
                    MarkdownText(text: String(text.prefix(1200)), size: 15, line: 22, document: true)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: 300, alignment: .topLeading)
                        .padding(24)
                        .scaleEffect(scale, anchor: .topLeading)
                }
                .allowsHitTesting(false)
            } else if failed {
                Image(systemName: fileSymbol(address)).font(.system(size: 34, weight: .light)).foregroundStyle(Color.faint)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .task(id: address?.id) { await load() }
    }

    private func load() async {
        guard let address else { failed = true; return }
        if address.isMarkdown {
            text = try? await api.artifactText(botId, name: address.name, version: address.version)
            failed = text == nil
            return
        }
        guard let file = try? await api.download(api.artifactURL(botId, address), as: address.fileName) else { failed = true; return }
        let request = QLThumbnailGenerator.Request(fileAt: file, size: CGSize(width: 360, height: 400), scale: 2, representationTypes: .thumbnail)
        thumbnail = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).nsImage
        failed = thumbnail == nil
    }
}

extension Array where Element: Equatable {
    func moved(_ item: Element, to target: Element) -> [Element] {
        guard let from = firstIndex(of: item), let to = firstIndex(of: target), from != to else { return self }
        var result = self
        result.insert(result.remove(at: from), at: to)
        return result
    }
}
