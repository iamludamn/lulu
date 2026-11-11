import PiStackKit
import SwiftUI

/// The card face of a space: the live page itself, shown as a still window. Opening the card opens the page full screen.
struct SpacePreview: View {
    let src: String
    let id: String
    let summary: String?
    let botId: String
    let api: Api
    @State private var page: Page?
    @State private var refreshes = 0
    @State private var failed = false

    private struct Page {
        let html: String
        let bridge: SpaceBridge
    }

    var body: some View {
        ZStack {
            if let page {
                HTMLPage(html: page.html, bridge: page.bridge, interactive: false)
                    .id(ObjectIdentifier(page.bridge))
                    .mask(LinearGradient(stops: [.init(color: .black, location: 0.78), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
            } else if failed {
                Label("页面无法加载", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.ultraThinMaterial)
        .clipShape(.rect(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.35), lineWidth: 1) }
        .overlay(alignment: .bottomLeading) {
            Label(summary ?? "打开 Space", systemImage: "arrow.up.forward.app")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .glassEffect(.regular, in: .capsule)
                .padding(8)
        }
        .task(id: "\(src)#\(refreshes)") { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .spaceRefresh)) { if $0.object as? String == id { refreshes += 1 } }
    }

    private func load() async {
        guard let address = ArtifactAddress(src) else {
            failed = true
            return
        }
        do {
            let html = try await api.artifactText(botId, name: address.name, version: address.version)
            page = Page(html: html, bridge: SpaceBridge(botId: botId, space: id, refresh: refreshes > 0 ? .open : nil, preview: true, api: api))
            failed = false
        } catch {
            failed = true
        }
    }
}
