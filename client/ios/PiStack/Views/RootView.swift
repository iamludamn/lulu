import PiStackKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var covers = StartupCovers()

    private var loadingLayout: Bool {
        if let connection = model.connection {
            let snapshot = connection.store.snapshot
            return !snapshot.hasLayout && snapshot.link == .connecting && snapshot.halt == nil
        }
        return model.api != nil
    }

    private var waitingForCovers: Bool {
        guard let snapshot = model.connection?.store.snapshot, snapshot.hasLayout, snapshot.halt == nil,
              snapshot.panel.list.contains(where: \.isSpace) else { return false }
        return covers.isWaiting(revision: model.connectionRevision, widgets: snapshot.panel.list)
    }

    private var loadingAnimation: Animation? {
        guard !reduceMotion else { return nil }
        if let snapshot = model.connection?.store.snapshot,
           snapshot.hasLayout, !snapshot.hasReceivedState {
            return nil
        }
        return .easeOut(duration: 0.12)
    }

    var body: some View {
        let revision = model.connectionRevision
        let waiting = waitingForCovers
        let loading = loadingLayout || waiting
        ZStack {
            if !loadingLayout, let connection = model.connection {
                NavigationStack {
                    HomeView(bot: connection.bot, api: connection.api, store: connection.store, onVisibleCovers: { visible in
                        covers.update(revision: revision) { $0.visible = visible }
                    }, onCoverSettled: { cover in
                        covers.update(revision: revision) { $0.settled.insert(cover) }
                    })
                        .toolbarVisibility(.hidden, for: .navigationBar)
                }
                .id(revision)
                .allowsHitTesting(!loading)
                .accessibilityHidden(loading)
            } else if model.api == nil {
                NavigationStack { SettingsView() }
            }
            ZStack {
                if loading {
                    LoadingScreen()
                        .transition(.opacity)
                }
            }
            .animation(loadingAnimation, value: loading)
            .zIndex(1)
        }
        .onChange(of: loading, initial: true) { _, value in
            ClientTiming.mark(value ? "startup.loading" : "startup.loading.cleared")
            if !value, model.connection != nil { covers.finish(revision: revision) }
        }
        .task(id: waiting ? revision : nil) {
            guard waiting else { return }
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            guard revision == model.connectionRevision else { return }
            ClientTiming.mark("startup.covers.timeout")
            covers.finish(revision: revision)
        }
        .task(id: loading) {
            guard loading else { return }
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            HTMLPage.preparePreview()
        }
        .task(id: model.connectionRevision) { await model.resolve() }
    }
}

private struct StartupCovers {
    private var revision: Int?
    private var finished = false
    var visible: Set<String>?
    var settled: Set<StartupSpaceCover> = []

    func isWaiting(revision: Int, widgets: [PanelWidget]) -> Bool {
        guard self.revision == revision else { return true }
        guard !finished else { return false }
        guard let visible else { return true }
        return widgets.contains { widget in
            guard visible.contains(widget.id), case .space(let src, _, _, let preview) = widget.body else { return false }
            return !settled.contains(StartupSpaceCover(id: widget.id, reference: preview ?? src))
        }
    }

    mutating func update(revision: Int, _ change: (inout Self) -> Void) {
        if let current = self.revision, current > revision { return }
        if self.revision != revision { self = Self(revision: revision) }
        if !finished { change(&self) }
    }

    mutating func finish(revision: Int) {
        update(revision: revision) { $0.finished = true }
    }
}

private struct LoadingScreen: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        ZStack {
            Wallpaper()
            ZStack {
                ForEach(0..<5) { index in
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .stroke(.white.opacity(0.9 - Double(index) * 0.13), lineWidth: 2)
                        .frame(width: 66 + CGFloat(index) * 13, height: 66 + CGFloat(index) * 13)
                        .rotationEffect(.degrees(Double(index) * 12))
                }
                Circle().fill(.white.opacity(0.8)).frame(width: 40, height: 40)
            }
            .scaleEffect(breathing && !reduceMotion ? 1.06 : (reduceMotion ? 1 : 0.94))
            .opacity(breathing || reduceMotion ? 1 : 0.7)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在加载 lulu")
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { breathing = true }
        }
        .onDisappear { ClientTiming.mark("startup.transition.disappeared") }
    }
}
