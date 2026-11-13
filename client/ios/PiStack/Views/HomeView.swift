import PiStackKit
import SwiftUI
import UIKit

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
    @State private var reading: ChatRow?
    @State private var readerFrame: ReaderFrame?
    @State private var bottomInset: CGFloat = 0
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var phase

    init(bot: BotSummary, api: Api) {
        self.bot = bot
        self.api = api
        _store = State(initialValue: BotStore(botId: bot.id, server: api.base))
        _draft = State(initialValue: UserDefaults.standard.string(forKey: "pistack.draft.\(bot.id)") ?? "")
    }

    var body: some View {
        ZStack {
            Wallpaper()
            TabView(selection: $page) {
                ForEach(Page.allCases) { item in
                    content(item).safeAreaPadding(.bottom, composing ? 0 : bottomInset).tag(item)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .opacity(veiled ? 0 : 1)
            .environment(\.keepTargets, targets)
            .environment(\.topInset, barBottom)
            .environment(\.keepPull) { page, progress in pull = progress > 0 ? (page, progress) : nil }
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            .safeAreaBar(edge: .top, spacing: 0) {
                topBar.onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { barBottom = $0 }
            }
            // Only the controls draw glass; suppress the bar's full-width scroll edge layer.
            .scrollEdgeEffectHidden(true, for: [.top, .bottom])
        }
        .background {
            WindowBottomInsetReader { bottomInset = $0 }
                .allowsHitTesting(false)
        }
        // Preserve the reference reader's original canvas while its backdrop covers the screen.
        .overlay {
            if let reading, let text = reading.body, let readerFrame, readerFrame.id == reading.id {
                GeometryReader { proxy in
                    let offset = proxy.frame(in: .global).origin
                    LongReader(summary: reading.text, text: text,
                               origin: readerFrame.origin.offsetBy(dx: -offset.x, dy: -offset.y),
                               canvas: CGSize(width: readerFrame.canvas.width,
                                              height: readerFrame.canvas.height - bottomInset)) {
                        self.reading = nil
                        self.readerFrame = nil
                    }
                    .id(reading.id)
                }
                .ignoresSafeArea()
            }
        }
        .overlay {
            if !store.snapshot.hasReceivedState && store.snapshot.link != .offline && store.snapshot.halt == nil {
                LoadingScreen()
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: store.snapshot.hasReceivedState)
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
            ChatView(bot: bot, store: store, api: api, draft: $draft, composing: $composing, onKept: land, bottomInset: bottomInset,
                     reading: $reading, onReaderFrame: { readerFrame = $0 })
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
        withAnimation(.snappy) { page = .chat }
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
        .ignoresSafeArea()
        .accessibilityElement(children: .combine)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { breathing = true }
        }
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

/// Preserve the chat page's original reader canvas while drawing its backdrop outside the pager.
struct ReaderFrame: Equatable {
    let id: String
    let origin: CGRect
    let canvas: CGSize
}


/// Read the container inset from the window so keyboard height is never counted as bottom padding.
private struct WindowBottomInsetReader: UIViewRepresentable {
    let onChange: (CGFloat) -> Void

    func makeUIView(context: Context) -> InsetView {
        let view = InsetView()
        view.onChange = onChange
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: InsetView, context: Context) { view.onChange = onChange }

    final class InsetView: UIView {
        var onChange: (CGFloat) -> Void = { _ in }
        private var last: CGFloat?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            publish()
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            publish()
        }

        private func publish() {
            guard let window else { return }
            let bottom = window.safeAreaInsets.bottom
            guard bottom != last else { return }
            last = bottom
            DispatchQueue.main.async { [weak self] in self?.onChange(bottom) }
        }
    }
}
