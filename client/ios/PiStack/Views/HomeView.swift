import PiStackKit
import SwiftUI

enum Page: Int, CaseIterable, Identifiable {
    case panel, chat, assets

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .panel: "视图"
        case .chat: "对话"
        case .assets: "资产"
        }
    }
}

struct HomeView: View {
    let bot: BotSummary
    let api: Api
    @State private var store: BotStore
    @State private var page = Page.panel
    @State private var draft: String
    @State private var inspector = false
    @State private var landed: Page?
    @State private var targets: [Page: CGPoint] = [:]
    @State private var pull: (page: Page, progress: CGFloat)?
    @State private var barBottom: CGFloat = 0
    @State private var veiled = false
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var phase

    init(bot: BotSummary, api: Api) {
        self.bot = bot
        self.api = api
        _store = State(initialValue: BotStore(botId: bot.id, server: api.base))
        _draft = State(initialValue: UserDefaults.standard.string(forKey: "pistack.draft.\(bot.id)") ?? "")
    }

    var body: some View {
        // Keep this container in the safe area so the floating controls avoid the status bar.
        ZStack {
            TabView(selection: $page) {
                ForEach(Page.allCases) { item in
                    content(item).tag(item)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .opacity(veiled ? 0 : 1)
            .environment(\.keepTargets, targets)
            .environment(\.topInset, barBottom)
            .environment(\.keepPull) { page, progress in pull = progress > 0 ? (page, progress) : nil }
            .ignoresSafeArea(.container, edges: .top)
        }
        .background { Wallpaper() }
        // Only the controls draw glass; a safe-area bar adds a full-width scroll edge effect.
        .overlay(alignment: .top) {
            topBar.onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { barBottom = $0 }
        }
        .artifactViewer(botId: bot.id, api: api)
        .sheet(isPresented: $inspector) { InspectorView(store: store, botId: bot.id, api: api) }
        .sensoryFeedback(.selection, trigger: page)
        .task { store.start() }
        .onDisappear { store.stop() }
        .onChange(of: phase) { _, next in
            if next == .active { store.start() } else if next == .background { store.stop() }
        }
        .onChange(of: draft) { _, text in
            let key = "pistack.draft.\(bot.id)"
            if text.isEmpty { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set(text, forKey: key) }
        }
    }

    @ViewBuilder
    private func content(_ item: Page) -> some View {
        switch item {
        case .panel:
            PanelView(widgets: store.snapshot.panel.list, botName: bot.name, botId: bot.id, api: api, onPrompt: send, onDraft: compose, onDrop: store.drop, onCheck: store.check, onCompose: fadeToChat)
        case .chat:
            ChatView(bot: bot, store: store, api: api, draft: $draft, composing: $composing, onKept: land)
        case .assets:
            AssetsView(items: store.snapshot.assets, botId: bot.id, api: api, onDrop: store.drop, onOrder: store.reorderAssets)
        }
    }

    private var topBar: some View {
        HStack {
            Button {
                compose("帮我在视图里加一个组件：")
            } label: {
                Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 32, height: 32)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .opacity(page == .panel ? 1 : 0)
            .disabled(page != .panel)
            .accessibilityLabel("添加组件")
            Spacer()
            PageSwitcher(page: page, landed: landed, pull: pull, onTarget: { targets[$0] = $1 }) { next in
                withAnimation(.snappy) { page = next }
            }
            Spacer()
            Button { inspector = true } label: {
                Avatar(name: bot.name, id: bot.id, size: 38)
                    .padding(3)
                    .background { Circle().fill(.clear).glassEffect(.regular, in: .circle) }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("设置")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func land(_ target: Page) {
        landed = target
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            if landed == target { landed = nil }
        }
    }

    private func fadeToChat() {
        Task {
            withAnimation(.easeOut(duration: 0.15)) { veiled = true }
            try? await Task.sleep(for: .milliseconds(150))
            withTransaction(Transaction(animation: nil)) { page = .chat }
            composing = true
            withAnimation(.easeIn(duration: 0.25)) { veiled = false }
        }
    }

    private func send(_ text: String) {
        withAnimation(.snappy) { page = .chat }
        store.submit(text)
    }

    private func compose(_ text: String) {
        withAnimation(.snappy) { page = .chat }
        if draft.isEmpty { draft = text }
        composing = true
    }
}

private struct PageSwitcher: View {
    let page: Page
    let landed: Page?
    let pull: (page: Page, progress: CGFloat)?
    let onTarget: (Page, CGPoint) -> Void
    let select: (Page) -> Void
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Page.allCases) { item in
                let drawn = pull?.page == item ? pull?.progress ?? 0 : 0
                Button { select(item) } label: {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(item == page ? Color(.systemBackground) : drawn > 0.5 ? .primary : .secondary)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .background {
                            if item == page {
                                Capsule().fill(Color.primary).matchedGeometryEffect(id: "pill", in: pill)
                            } else if drawn > 0 {
                                Capsule()
                                    .fill(Color.lift.opacity(0.3 + 0.7 * drawn))
                                    .shadow(color: .black.opacity(0.12 * drawn), radius: 6, y: 2)
                            }
                        }
                        .contentShape(.capsule)
                        .scaleEffect(item == landed ? 1.18 : 1 + 0.1 * drawn)
                        .animation(.spring(duration: 0.35, bounce: 0.55), value: landed)
                        .animation(.snappy(duration: 0.15), value: drawn >= 1)
                        .onGeometryChange(for: CGPoint.self) { proxy in
                            let frame = proxy.frame(in: .global)
                            return CGPoint(x: frame.midX, y: frame.midY)
                        } action: { onTarget(item, $0) }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(item == page ? .isSelected : [])
            }
        }
        .padding(4)
        .background { Capsule().fill(.clear).glassEffect(.regular, in: .capsule) }
        .animation(.snappy(duration: 0.3), value: page)
    }
}
