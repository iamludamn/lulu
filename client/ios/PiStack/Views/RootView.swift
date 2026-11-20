import PiStackKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var loading: Bool {
        if let connection = model.connection {
            let snapshot = connection.store.snapshot
            return !snapshot.hasLayout && snapshot.link == .connecting && snapshot.halt == nil
        }
        return model.api != nil
    }

    private var loadingAnimation: Animation? {
        guard !reduceMotion else { return nil }
        if let snapshot = model.connection?.store.snapshot,
           snapshot.hasLayout, !snapshot.hasReceivedState {
            return nil
        }
        return .easeInOut(duration: 0.3)
    }

    var body: some View {
        let loading = self.loading
        ZStack {
            if !loading, let connection = model.connection {
                NavigationStack {
                    HomeView(bot: connection.bot, api: connection.api, store: connection.store)
                        .toolbarVisibility(.hidden, for: .navigationBar)
                }
                .id(model.connectionRevision)
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
        }
        .task(id: model.connectionRevision) { await model.resolve() }
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
