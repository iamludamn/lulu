import PiStackKit
import SwiftUI

struct SpacePreview: View {
    let preview: String
    let id: String
    let botId: String
    let api: Api
    @State private var html: String?
    @State private var refreshes = 0
    @State private var failed = false

    var body: some View {
        ZStack {
            if let html {
                HTMLPage(html: html, bridge: nil, interactive: false)
                    .id("\(preview)#\(refreshes)")
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
        .task(id: "\(preview)#\(refreshes)") { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .spaceRefresh)) { if $0.object as? String == id { refreshes += 1 } }
    }

    private func load() async {
        html = nil
        failed = false
        guard let address = ArtifactAddress(preview) else {
            failed = true
            return
        }
        do {
            html = try await api.artifactText(botId, name: address.name, version: address.version)
            failed = false
        } catch {
            failed = true
        }
    }
}
