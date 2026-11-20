import PiStackKit
import SwiftUI

struct StartupSpaceCover: Hashable {
    let id: String
    let reference: String
}

extension EnvironmentValues {
    @Entry var startupSpaceSettled: (StartupSpaceCover) -> Void = { _ in }
}

struct SpacePreview: View {
    let src: String
    let preview: String?
    let id: String
    let botId: String
    let api: Api
    @State private var page: Page?
    @State private var refreshes = 0
    @State private var failed: Request?
    @State private var loading: Request?
    @Environment(\.startupSpaceSettled) private var settleCover

    private struct Source: Hashable {
        let reference: String
        let legacy: Bool
    }

    private struct Request: Hashable {
        let source: Source
        let refresh: Int
    }

    private struct Page {
        var source: Source
        var html: String
        let bridge: SpaceBridge?
    }

    private var request: Request {
        Request(source: Source(reference: preview ?? src, legacy: preview == nil), refresh: refreshes)
    }

    var body: some View {
        let request = self.request
        ZStack {
            if let page {
                let refreshing = loading == request && request.refresh > 0
                HTMLPage(html: page.html, bridge: page.bridge, interactive: false, showLoading: !refreshing, onSettled: {
                    settleCover(StartupSpaceCover(id: id, reference: page.source.reference))
                })
                    .id(page.source)
                    .overlay(alignment: .topTrailing) {
                        if refreshing {
                            ProgressView().padding(10).background(.regularMaterial, in: Circle()).padding(12)
                        } else if failed == request && (request.refresh > 0 || page.source != request.source) {
                            Image(systemName: "exclamationmark.triangle")
                                .accessibilityLabel("刷新失败")
                                .padding(10).background(.regularMaterial, in: Circle()).padding(12)
                        }
                    }
            } else if failed == request {
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
        .task(id: request) { await load(request) }
        .onReceive(NotificationCenter.default.publisher(for: .spaceRefresh)) {
            guard $0.object as? String == id, loading != request || refreshes == 0 else { return }
            refreshes += 1
        }
    }

    private func load(_ request: Request) async {
        guard !Task.isCancelled, request == self.request else { return }
        loading = request
        failed = nil
        defer { if loading == request { loading = nil } }
        guard let address = ArtifactAddress(request.source.reference) else {
            failed = request
            settleCover(StartupSpaceCover(id: id, reference: request.source.reference))
            return
        }
        if page?.source != request.source && (page == nil || request.refresh == 0) {
            let cached = await api.loadCachedArtifactText(botId, address: address)
            guard !Task.isCancelled, request == self.request else { return }
            if let cached {
                page = makePage(cached, source: request.source)
                ClientTiming.mark("space.cover.cached")
            }
        }
        if request.refresh == 0, address.version != nil, page?.source == request.source { return }
        do {
            let html = try await api.artifactText(botId, name: address.name, version: address.version)
            guard !Task.isCancelled, request == self.request else { return }
            ClientTiming.mark("space.cover.downloaded")
            if page?.source.legacy == request.source.legacy {
                page?.source = request.source
                if page?.html != html {
                    if request.refresh > 0 { await page?.bridge?.invalidateFetches() }
                    guard !Task.isCancelled, request == self.request else { return }
                    page?.html = html
                } else if request.refresh > 0 {
                    await page?.bridge?.refresh()
                }
            } else {
                page = makePage(html, source: request.source, fresh: request.refresh > 0)
            }
        } catch {
            guard !Task.isCancelled, request == self.request else { return }
            failed = request
            if page?.source != request.source {
                settleCover(StartupSpaceCover(id: id, reference: request.source.reference))
            }
            if request.refresh > 0, page?.source == request.source { await page?.bridge?.refresh() }
        }
    }

    private func makePage(_ html: String, source: Source, fresh: Bool = false) -> Page {
        let bridge = source.legacy
            ? SpaceBridge(botId: botId, space: id, refresh: fresh ? .open : nil, preview: true, api: api)
            : nil
        return Page(source: source, html: html, bridge: bridge)
    }
}
