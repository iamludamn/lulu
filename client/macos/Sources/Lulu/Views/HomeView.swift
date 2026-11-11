import PiStackKit
import SwiftUI

struct HomeView: View {
    let bot: BotSummary
    let api: Api
    @Environment(AppModel.self) private var model
    @State private var store: BotStore
    @State private var draft: String
    @State private var focus = 0
    @State private var lead = 0

    static let wideBreak: CGFloat = 1024
    static let sideChat: CGFloat = 480

    init(bot: BotSummary, api: Api) {
        self.bot = bot
        self.api = api
        _store = State(initialValue: BotStore(botId: bot.id, server: api.base))
        _draft = State(initialValue: UserDefaults.standard.string(forKey: "pistack.draft.\(bot.id)") ?? "")
    }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let wide = width >= Self.wideBreak
            ZStack(alignment: .topLeading) {
                if wide {
                    wideLayout(width: width)
                } else {
                    content(model.page, column: min(512, width - 32), width: width)
                        .frame(width: width)
                }
                topBar(wide: wide, width: width)
            }
            .animation(.snappy(duration: 0.34), value: lead)
            .accessibilityHidden(model.settings)
        }
        .background { Backdrop() }
        .ignoresSafeArea()
        .overlay {
            if model.settings {
                SettingsView(store: store, bot: bot, api: api) { withAnimation(.snappy) { model.settings = false } }
                    .transition(.opacity.combined(with: .scale(scale: 1.02)))
            }
        }
        .animation(.snappy(duration: 0.28), value: model.settings)
        .artifactViewer(botId: bot.id, api: api)
        .task { store.start() }
        .onDisappear { store.stop() }
        .onChange(of: draft) { _, text in
            let key = "pistack.draft.\(bot.id)"
            if text.isEmpty { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set(text, forKey: key) }
        }
        .onChange(of: model.stopping) { store.abort() }
        .onChange(of: chatRows(store.snapshot), initial: true) { _, rows in
            Notifier.shared.observe(rows, online: store.snapshot.link == .online, name: bot.name)
        }
    }

    private var panel: some View {
        PanelView(widgets: store.snapshot.panel.list, botName: bot.name, botId: bot.id, api: api, onPrompt: send, onDraft: compose, onDrop: store.drop, onCheck: store.check)
    }

    @ViewBuilder
    private func content(_ page: Page, column: CGFloat, width: CGFloat) -> some View {
        ZStack {
            switch page {
            case .panel:
                panel.transition(.opacity)
            case .chat:
                ChatView(bot: bot, store: store, api: api, column: column, draft: $draft, focus: focus, onFocus: { focus += 1 })
                    .transition(.opacity)
            case .assets:
                AssetsView(items: store.snapshot.assets, botId: bot.id, api: api, width: min(860, width - 64), onDrop: store.drop, onOrder: store.reorderAssets)
                    .transition(.opacity)
            }
        }
        .animation(.snappy(duration: 0.25), value: page)
    }

    private func shelf(inner: Edge.Set) -> some View {
        let r: CGFloat = 36
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: inner == .leading ? r : 0,
            bottomLeadingRadius: inner == .leading ? r : 0,
            bottomTrailingRadius: inner == .trailing ? r : 0,
            topTrailingRadius: inner == .trailing ? r : 0,
            style: .continuous)
        return Color.clear
            .glassEffect(.regular, in: shape)
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }

    private func wideLayout(width: CGFloat) -> some View {
        let rail = PanelLayout.rail
        let side = Self.sideChat
        let first = lead == 0
        let chatWidth = first ? width - rail : side
        let assetsWidth = width - side
        return ZStack(alignment: .topLeading) {
            panel
                .frame(width: rail)
                .background { shelf(inner: .trailing) }
                .offset(x: first ? 0 : -rail)
                .opacity(first ? 1 : 0)
                .allowsHitTesting(first)
                .accessibilityHidden(!first)
            ChatView(bot: bot, store: store, api: api, column: min(512, chatWidth - 32), draft: $draft, focus: focus, onFocus: { focus += 1 })
                .frame(width: chatWidth)
                .offset(x: first ? rail : 0)
            AssetsView(items: store.snapshot.assets, botId: bot.id, api: api, width: min(860, assetsWidth - 64), onDrop: store.drop, onOrder: store.reorderAssets)
                .frame(width: assetsWidth)
                .background { shelf(inner: .leading) }
                .offset(x: first ? width : side)
                .opacity(first ? 0 : 1)
                .allowsHitTesting(!first)
                .accessibilityHidden(first)
        }
        .frame(width: width, alignment: .topLeading)
        .clipped()
        .onChange(of: model.page, initial: true) { _, page in
            if page == .panel { lead = 0 } else if page == .assets { lead = 1 }
        }
    }

    private func topBar(wide: Bool, width: CGFloat) -> some View {
        ZStack(alignment: .top) {
            HStack {
                CircleButton(symbol: "plus", help: "添加组件") { compose("帮我在视图里加一个组件：") }
                    .padding(.leading, 80)
                    .opacity(width < 600 ? 0 : 1)
                    .disabled(width < 600)
                Spacer()
                Button { withAnimation(.snappy) { model.settings = true } } label: {
                    Avatar(size: 42).contentShape(.circle)
                }
                .buttonStyle(.plain)
                .help("设置（⌘,）")
                .padding(.trailing, 16)
                .padding(.top, 3)
            }
            switcher(wide: wide)
        }
        .frame(width: width, height: 48, alignment: .top)
        .padding(.top, 14)
    }

    private func switcher(wide: Bool) -> some View {
        let span = wide ? 2 : 1
        let start = wide ? lead : model.page.rawValue
        return ZStack(alignment: .leading) {
            Capsule()
                .fill(Color.thumb)
                .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                .frame(width: 68 * CGFloat(span), height: 40)
                .offset(x: 68 * CGFloat(start))
            HStack(spacing: 0) {
                ForEach(Page.allCases) { item in
                    let active = item.rawValue >= start && item.rawValue < start + span
                    Button { withAnimation(.snappy(duration: 0.34)) { model.page = item } } label: {
                        Text(item.title)
                            .type(14, .semibold, line: 18)
                            .foregroundStyle(active ? Color.sheetInk : Color.muted)
                            .frame(width: 68, height: 40)
                            .contentShape(.capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .animation(.snappy(duration: 0.34), value: start)
        .animation(.snappy(duration: 0.34), value: span)
        .padding(4)
        .glass(Capsule(), tint: .pane)
    }

    private func send(_ text: String) {
        withAnimation(.snappy) { model.page = .chat }
        store.submit(text)
    }

    private func compose(_ text: String) {
        withAnimation(.snappy) { model.page = .chat }
        if draft.isEmpty { draft = text }
        focus += 1
    }
}
