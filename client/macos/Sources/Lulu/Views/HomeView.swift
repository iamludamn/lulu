import PiStackKit
import SwiftUI

struct HomeView: View {
    let bot: BotSummary
    let api: Api
    @Environment(AppModel.self) private var model
    @State private var store: BotStore
    @State private var draft: String
    @State private var focus = 0
    @State private var railHidden = false
    @Namespace private var pill

    static let wideBreak: CGFloat = 1024

    init(bot: BotSummary, api: Api) {
        self.bot = bot
        self.api = api
        _store = State(initialValue: BotStore(botId: bot.id, server: api.base))
        _draft = State(initialValue: UserDefaults.standard.string(forKey: "pistack.draft.\(bot.id)") ?? "")
    }

    var body: some View {
        GeometryReader { proxy in
            let rail = proxy.size.width >= Self.wideBreak && !railHidden
            let pages = rail ? [Page.chat, .assets] : Page.allCases
            let page = rail && model.page == .panel ? Page.chat : model.page
            let leading = rail ? PanelLayout.rail : 0
            let main = proxy.size.width - leading
            let column = min(512, main - 32)
            ZStack(alignment: .topLeading) {
                if rail {
                    panel
                        .frame(width: PanelLayout.rail)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                content(page, column: column, width: main)
                    .frame(width: main)
                    .offset(x: leading)
                topBar(pages: pages, page: page, rail: rail, center: leading + main / 2, width: proxy.size.width)
            }
            .animation(.snappy(duration: 0.32), value: rail)
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

    private func topBar(pages: [Page], page: Page, rail: Bool, center: CGFloat, width: CGFloat) -> some View {
        ZStack(alignment: .top) {
            HStack {
                CircleButton(symbol: leadingSymbol(rail: rail, width: width), help: leadingHelp(width: width)) { leadingAction(width: width) }
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
            switcher(pages: pages, page: page)
                .offset(x: center - width / 2)
        }
        .frame(width: width, height: 48, alignment: .top)
        .padding(.top, 14)
    }

    private func leadingSymbol(rail: Bool, width: CGFloat) -> String {
        width >= Self.wideBreak ? "sidebar.left" : "plus"
    }

    private func leadingHelp(width: CGFloat) -> String {
        width >= Self.wideBreak ? (railHidden ? "显示组件栏" : "收起组件栏") : "添加组件"
    }

    private func leadingAction(width: CGFloat) {
        if width >= Self.wideBreak {
            railHidden.toggle()
            if !railHidden && model.page == .panel { model.page = .chat }
        } else {
            compose("帮我在视图里加一个组件：")
        }
    }

    private func switcher(pages: [Page], page: Page) -> some View {
        HStack(spacing: 0) {
            ForEach(pages) { item in
                Button { withAnimation(.snappy) { model.page = item } } label: {
                    Text(item.title)
                        .type(14, .semibold, line: 18)
                        .foregroundStyle(item == page ? Color.sheetInk : Color.muted)
                        .frame(width: 68, height: 40)
                        .background {
                            if item == page {
                                Capsule()
                                    .fill(Color.thumb)
                                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            }
                        }
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
            }
        }
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
