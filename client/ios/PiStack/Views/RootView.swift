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

    var body: some View {
        let loading = self.loading
        ZStack {
            if let connection = model.connection {
                NavigationStack {
                    HomeView(bot: connection.bot, api: connection.api, store: connection.store)
                        .toolbarVisibility(.hidden, for: .navigationBar)
                }
                .id(model.connectionRevision)
                .allowsHitTesting(!loading)
                .accessibilityHidden(loading)
            } else if model.api == nil {
                NavigationStack { SettingsView() }
            }
            if loading {
                LoadingScreen()
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: loading)
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
    }
}
