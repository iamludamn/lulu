import PiStackKit
import SwiftUI

struct SpacePreview: View {
    let src: String
    let preview: String?
    let id: String
    let botId: String
    let api: Api
    @State private var page: Page?

    private struct Page {
        let html: String
        let bridge: SpaceBridge?
    }

    private var reference: String { preview ?? src }
    @State private var refreshes = 0
    @State private var failed = false

    var body: some View {
        ZStack {
            if let page {
                HTMLPage(html: page.html, bridge: page.bridge, interactive: false)
                    .id("\(reference)#\(refreshes)")
            } else if failed {
                Label("页面无法加载", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottomTrailing) {
            Label("打开 Space", systemImage: "arrow.up.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.regularMaterial, in: Capsule())
                .padding(12)
                .allowsHitTesting(false)
        }
        .task(id: "\(reference)#\(refreshes)") { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .spaceRefresh)) { if $0.object as? String == id { refreshes += 1 } }
    }

    private func load() async {
        page = nil
        failed = false
        guard let address = ArtifactAddress(reference) else {
            failed = true
            return
        }
        do {
            let html = try await api.artifactText(botId, name: address.name, version: address.version)
            // Legacy pages need the same read-only preview bridge as before covers
            // existed. Dedicated static covers deliberately have no bridge.
            let bridge = preview == nil
                ? SpaceBridge(botId: botId, space: id, refresh: refreshes > 0 ? .open : nil, preview: true, api: api)
                : nil
            page = Page(html: html, bridge: bridge)
            failed = false
        } catch {
            failed = true
        }
    }
}
