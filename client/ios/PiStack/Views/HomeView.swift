import Observation
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
    let store: BotStore
    @State private var page = Page.panel
    @State private var draft: ChatDraft
    @State private var inspector = false
    @State private var landed: Page?
    @State private var targets: [Page: CGPoint] = [:]
    @State private var keepFeedback = KeepFeedback()
    @State private var barBottom: CGFloat = 0
    @State private var veiled = false
    @State private var reading: ChatRow?
    @State private var readerFrame: ReaderFrame?
    @State private var bottomInset: CGFloat = 0
    @State private var voiceOpen = false
    @State private var voice = VoiceCall()
    @State private var transcription = VoiceTranscription()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var phase

    init(bot: BotSummary, api: Api, store: BotStore) {
        self.bot = bot
        self.api = api
        self.store = store
        _draft = State(initialValue: ChatDraft(botId: bot.id))
    }

    var body: some View {
        ZStack {
            Wallpaper()
            TabView(selection: $page) {
                ForEach(Page.allCases) { item in
                    content(item).tag(item)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .opacity(veiled ? 0 : 1)
            .environment(\.keepTargets, targets)
            .environment(\.topInset, barBottom)
            .environment(\.keepPull, keepFeedback.update)
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            .scrollEdgeEffectHidden(true, for: [.top, .bottom])
            .allowsHitTesting(!voiceOpen)
            .accessibilityHidden(voiceOpen)
            if page == .chat {
                GeometryReader { proxy in
                    let controlsBottom = max(0, barBottom - proxy.frame(in: .global).minY)
                    ChatEdgeBackdrop(edge: .top, fade: 80)
                        .frame(height: controlsBottom + 32)
                }
                .ignoresSafeArea(.container, edges: .top)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            topBar
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { barBottom = $0 }
                .frame(maxHeight: .infinity, alignment: .top)
                .allowsHitTesting(!voiceOpen)
                .accessibilityHidden(voiceOpen)
            VoicePresentation(
                isPresented: voiceOpen,
                duration: reduceMotion ? 0.15 : 0.22,
                atmosphere: voiceOpen ? VoiceAtmosphere(muted: voice.muted, audioLevel: { voice.audioLevel(at: $0) }) : nil,
                controls: voiceOpen ? voiceTranscript : nil
            )
            .ignoresSafeArea()
            .allowsHitTesting(voiceOpen)
            .accessibilityHidden(!voiceOpen)
            .zIndex(1)
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
        .artifactViewer(botId: bot.id, api: api, panel: store.snapshot.panel)
        .sheet(isPresented: $inspector) { InspectorView(store: store, botId: bot.id, api: api) }
        .sensoryFeedback(.selection, trigger: page)
        .task { store.start(); await SpacePush.shared.connect(api: api, botId: bot.id) }
        .task(id: voiceOpen) {
            if voiceOpen { await voice.start(store) }
        }
        .onDisappear { draft.flush(); transcription.cancel(); voice.stop(); store.stop() }
        .onChange(of: store.snapshot.halt) { _, halt in
            guard halt != nil else { return }
            composing = false
            reading = nil
            readerFrame = nil
        }
        .onChange(of: phase) { _, next in
            if next == .active {
                store.start()
            } else if next == .background {
                draft.flush()
                voice.stop()
                voiceOpen = false
                store.stop()
                if transcription.recording { transcription.cancel() }
            }
        }
    }

    @ViewBuilder
    private func content(_ item: Page) -> some View {
        if store.snapshot.halt == .notFound {
            ContentUnavailableView("lulu 不存在", systemImage: "questionmark.bubble")
        } else {
            pageContent(item)
        }
    }

    @ViewBuilder
    private func pageContent(_ item: Page) -> some View {
        switch item {
        case .panel:
            if store.snapshot.view == nil && store.snapshot.link == .offline {
                connectionUnavailable
            } else {
                PanelView(widgets: store.snapshot.panel.list, spaceUpdates: store.snapshot.panel.spaceUpdates, botName: bot.name, botId: bot.id, api: api, onPrompt: send, onDraft: compose, onDrop: store.drop, onCheck: store.check, onCompose: fadeToChat)
            }
        case .chat:
            ChatView(bot: bot, store: store, transcription: transcription, api: api, containerBottomInset: bottomInset, draft: Binding(get: { draft.text }, set: { draft.text = $0 }), composing: $composing, onKept: land, onVoiceConversation: {
                composing = false
                voiceOpen = true
            },
                     reading: $reading, onReaderFrame: { readerFrame = $0 })
        case .assets:
            if store.snapshot.view == nil && store.snapshot.link == .offline {
                connectionUnavailable
            } else {
                AssetsView(items: store.snapshot.assets, botId: bot.id, api: api, onDrop: store.drop, onOrder: store.reorderAssets)
            }
        }
    }

    private var connectionUnavailable: some View {
        ContentUnavailableView {
            Label("暂时无法连接 lulu", systemImage: "wifi.exclamationmark")
        } description: {
            Text("连接恢复后会自动加载你的视图和资产。")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            PageSwitcher(page: page, landed: landed, keepFeedback: keepFeedback, onTarget: { targets[$0] = $1 }, select: selectPage)
            .opacity(transcription.recording ? 0 : 1)
            .allowsHitTesting(!transcription.recording)
            .accessibilityHidden(transcription.recording)
            .overlay {
                if transcription.recording {
                    RecordingWaveform(levels: transcription.levels)
                        .background { Capsule().fill(.clear).glassEffect(.regular, in: .capsule) }
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: transcription.recording)
            Spacer()
            Button { inspector = true } label: {
                Avatar(name: bot.name, id: bot.id, size: 38)
                    .padding(3)
                    .background { Circle().fill(.clear).glassEffect(.regular, in: .circle) }
            }
            .buttonStyle(PressHighlight(shape: Circle(), amount: 0.24))
            .accessibilityLabel("设置")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var voiceStatus: String { voice.muted && voice.ready ? "已静音" : voice.status }

    private var voiceTranscript: some View {
        GeometryReader { proxy in
            VStack {
                Text("lu")
                    .font(.system(size: 27, weight: .medium, design: .rounded))
                    .tracking(0.5)
                    .foregroundStyle(Color(red: 0.18, green: 0.29, blue: 0.38))
                    .padding(.top, 16)
                    .frame(maxWidth: .infinity)
                Spacer()
            }
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(voice.lines) { line in
                            CallTranscriptRow(mine: line.mine, text: line.text)
                                .id(line.id)
                        }
                    }
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: voice.lines.count) { _, _ in
                    if let last = voice.lines.last { scroll.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .padding(.horizontal, 28)
            .frame(height: proxy.size.height * 0.36)
            .position(x: proxy.size.width / 2, y: proxy.size.height * 0.36)
            Text(voiceStatus)
                .font(.system(size: 20, weight: .regular))
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.18), value: voiceStatus)
                .foregroundStyle(Color(red: 0.20, green: 0.32, blue: 0.40))
                .position(x: proxy.size.width / 2, y: proxy.size.height * 0.655)
            VStack {
                Spacer()
                HStack(spacing: 48) {
                    Button { voice.setMuted(!voice.muted) } label: {
                        Image(systemName: voice.muted ? "mic.fill" : "mic.slash")
                            .font(.system(size: 28, weight: .light))
                            .frame(width: 72, height: 72)
                            .modifier(VoiceGlassCircle())
                    }
                    .accessibilityLabel(voice.muted ? "取消静音" : "静音")
                    .disabled(!voice.ready)
                    Button { voice.stop(); voiceOpen = false } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 25, weight: .light))
                            .frame(width: 72, height: 72)
                            .modifier(VoiceGlassCircle())
                    }
                    .buttonStyle(PressHighlight(shape: Circle(), amount: 0.24))
                    .accessibilityLabel("关闭语音对话")
                }
                .frame(maxWidth: .infinity)
                .foregroundStyle(Color(red: 0.22, green: 0.34, blue: 0.43))
                .buttonStyle(.plain)
                .padding(.bottom, 70)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private func land(_ target: Page) {
        landed = target
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            if landed == target { landed = nil }
        }
    }

    private func selectPage(_ next: Page) {
        guard page != next else { return }
        withAnimation(reduceMotion ? nil : .snappy) { page = next }
    }

    private func fadeToChat() {
        selectPage(.chat)
    }

    private func send(_ text: String) {
        selectPage(.chat)
        store.submit(text)
    }

    private func compose(_ text: String) {
        selectPage(.chat)
        if draft.text.isEmpty { draft.text = text }
        composing = true
    }
}

@Observable
private final class KeepFeedback {
    private(set) var pull: (page: Page, progress: CGFloat)?

    func update(_ page: Page, _ progress: CGFloat) {
        if progress > 0 {
            guard pull?.page != page || pull?.progress != progress else { return }
            pull = (page, progress)
        } else if pull != nil {
            pull = nil
        }
    }
}

private struct PageSwitcher: View {
    let page: Page
    let landed: Page?
    let keepFeedback: KeepFeedback
    let onTarget: (Page, CGPoint) -> Void
    let select: (Page) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var pill

    var body: some View {
        let pull = keepFeedback.pull
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
                                if reduceMotion {
                                    Capsule().fill(Color.primary.opacity(0.72))
                                } else {
                                    Capsule().fill(Color.primary.opacity(0.72)).matchedGeometryEffect(id: "pill", in: pill)
                                }
                            } else if drawn > 0 {
                                Capsule()
                                    .fill(Color.lift.opacity(0.3 + 0.7 * drawn))
                                    .shadow(color: .black.opacity(0.12 * drawn), radius: 6, y: 2)
                            }
                        }
                        .contentShape(.capsule)
                        .scaleEffect(reduceMotion ? 1 : item == landed ? 1.18 : 1 + 0.1 * drawn)
                        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.55), value: landed)
                        .animation(reduceMotion ? nil : .snappy(duration: 0.15), value: drawn >= 1)
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
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: page)
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
