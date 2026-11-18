import PiStackKit
import SwiftUI

struct ChatView: View {
    let bot: BotSummary
    let store: BotStore
    let transcription: VoiceTranscription
    let api: Api
    let containerBottomInset: CGFloat
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding
    let onKept: (Page) -> Void
    let onVoiceConversation: () -> Void
    @Binding var reading: ChatRow?
    let onReaderFrame: (ReaderFrame) -> Void
    @State private var bottomState = ChatBottomState()
    @State private var composerBottom: CGFloat?
    @State private var sent = 0
    @State private var fetchingEarlier = false
    @State private var floor: String?
    @State private var position = ScrollPosition()
    @State private var metrics = Metrics()
    @Environment(\.topInset) private var topInset
    @Environment(\.openArtifact) private var openArtifact
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let bottom = "bottom"
    private static let page = 40
    private static let suggestions = ["今天有什么安排？", "把我关心的数据做成组件", "总结一下你记住了我什么"]

    private var snapshot: BotStore.Snapshot { store.snapshot }
    private var busy: Bool { live(of: snapshot.view).busy }
    private var reconnecting: Bool { snapshot.link == .offline && snapshot.halt == nil }

    var body: some View {
        let rows = chatRows(snapshot)
        let start = floor.flatMap { id in rows.firstIndex { $0.id == id } } ?? max(0, rows.count - Self.page)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 4) {
                    if start > 0 || snapshot.view?.before != nil {
                        Button {
                            if start > 0 { revealEarlier(rows, start) } else {
                                floor = rows.first?.id
                                fetchingEarlier = true
                                store.loadEarlier()
                            }
                        } label: {
                            Text("更早的消息")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id("earlier")
                        .disabled(store.loadingHistory)
                    }
                    ForEach(rows[start...]) { row in
                        MessageRow(row: row, store: store, botId: bot.id, api: api, expanded: row.id == reading?.id, onRead: { id in reading = rows.first { $0.id == id } }, onOpen: openArtifact, onKept: onKept)
                            .equatable()
                            .padding(.bottom, row.tail && row.id != rows.last?.id ? 12 : 0)
                            .transition(.opacity.animation(.easeOut(duration: 0.2)))
                    }
                    Color.clear.frame(height: 1)
                        .id(Self.bottom)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { metrics.bottomMarkerY = $0; updateBottomState() }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(bottomState.pinned ? .bottom : nil, for: .sizeChanges)
            .scrollPosition($position)
            .scrollClipDisabled()
            .contentMargins(.top, topInset, for: .scrollContent)
            .contentMargins(.bottom, 0, for: .scrollContent)
            .scrollDismissesKeyboard(.interactively)
            .onScrollPhaseChange { _, phase in
                metrics.dragging = phase == .interacting || phase == .decelerating
            }
            .onScrollGeometryChange(for: Extent.self) { Extent(offset: $0.contentOffset.y + $0.contentInsets.top, height: $0.contentSize.height) } action: { _, extent in
                if let reveal = metrics.reveal, extent.height != reveal.height {
                    metrics.reveal = nil
                    position.scrollTo(y: reveal.offset + extent.height - reveal.height)
                }
                metrics.extent = extent
            }
            .onChange(of: rows.count > Self.page, initial: true) { _, long in
                if long, floor == nil { floor = rows[rows.count - Self.page].id }
            }
            .onChange(of: snapshot.view?.entries.first?.id) {
                guard fetchingEarlier else { return }
                fetchingEarlier = false
                let start = floor.flatMap { id in rows.firstIndex { $0.id == id } } ?? 0
                if start > 0 { revealEarlier(rows, start) }
            }
            .onChange(of: sent) {
                Task {
                    try? await Task.sleep(for: .milliseconds(60))
                    guard bottomState.pinned else { return }
                    proxy.scrollTo(Self.bottom, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if bottomState.showJump {
                    Button {
                        bottomState.pinned = true
                        if reduceMotion { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                        else { withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) } }
                    } label: {
                        Image(systemName: "arrow.down").font(.headline).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("回到最新消息")
                    .accessibilityHint("滚动到对话最底部")
                    .padding(.horizontal, 16)
                    .padding(.bottom, 40)
                    .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .snappy, value: bottomState.showJump)
        }
        .overlay { gate(rows) }
        .overlay(alignment: .top) {
            if reconnecting {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("正在重连…")
                }
                .font(.caption.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .glassEffect(.regular, in: .capsule)
                .padding(.top, topInset + 4)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: reconnecting)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if snapshot.halt == nil {
                Composer(draft: $draft, store: store, transcription: transcription, onTranscribed: transcribed, busy: busy, placeholder: placeholder, focused: composing, onSend: send, onVoiceConversation: onVoiceConversation)
                    .background {
                        GeometryReader { proxy in
                            let bottom = max(containerBottomInset, proxy.safeAreaInsets.bottom)
                            ChatEdgeBackdrop(edge: .bottom, fade: 96)
                                .frame(height: proxy.size.height + bottom + 40)
                                .offset(y: -40)
                        }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    }
                    .background {
                        ChatInputShield()
                            .ignoresSafeArea(.container, edges: .bottom)
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                        metrics.composerTop = frame.minY
                        composerBottom = frame.maxY
                        updateBottomState()
                    }
            }
        }
        .overlay {
            if snapshot.halt == nil, let composerBottom {
                GeometryReader { proxy in
                    let height = max(0, proxy.frame(in: .global).maxY - composerBottom)
                    ChatInputShield()
                        .frame(height: height)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                }
                .ignoresSafeArea(.container, edges: .bottom)
            }
        }
        .overlayPreferenceValue(LongBubbleBounds.self) { bounds in
            GeometryReader { proxy in
                if let row = reading, row.body != nil, let anchor = bounds[row.id] {
                    Color.clear
                        .onGeometryChange(for: ReaderFrame.self) { _ in
                            let offset = proxy.frame(in: .global).origin
                            return ReaderFrame(id: row.id,
                                               origin: proxy[anchor].offsetBy(dx: offset.x, dy: offset.y),
                                               canvas: proxy.size)
                        } action: { onReaderFrame($0) }
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .light), trigger: reading?.id) { _, new in new != nil }
        .sensoryFeedback(.success, trigger: busy) { old, new in old && !new }
    }

    private func updateBottomState() {
        let distance = metrics.composerTop > 0 ? max(0, metrics.bottomMarkerY - metrics.composerTop + 8) : 0
        var next = bottomState
        next.update(distance: distance, userScrolling: metrics.dragging)
        if bottomState != next { bottomState = next }
    }

    private var placeholder: String { "给 \(bot.name) 发消息" }

    private func revealEarlier(_ rows: [ChatRow], _ start: Int) {
        metrics.reveal = metrics.extent
        floor = rows[max(0, start - Self.page)].id
    }

    private func transcribed(_ text: String, sendImmediately: Bool) {
        if sendImmediately {
            bottomState.pinned = true
            sent += 1
            store.submit(text)
        } else {
            draft += text
            composing.wrappedValue = true
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        bottomState.pinned = true
        sent += 1
        store.submit(text)
        draft = ""
    }

    @ViewBuilder
    private func gate(_ rows: [ChatRow]) -> some View {
        switch snapshot.halt {
        case .notFound:
            ContentUnavailableView("bot 不存在", systemImage: "questionmark.bubble")
        case nil:
            if snapshot.view == nil {
                ProgressView()
            } else if rows.isEmpty {
                welcome
            }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("你好，我是 \(bot.name)").font(.largeTitle.weight(.bold))
                Text("交给我的事，我会记住并替你跟进。").font(.title3).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Self.suggestions, id: \.self) { text in
                    Button {
                        draft = text
                        composing.wrappedValue = true
                    } label: {
                        Text(text).font(.subheadline.weight(.medium)).padding(.horizontal, 4).padding(.vertical, 4)
                    }
                    .buttonStyle(.glass)
                    .tint(.primary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
    }
}

private struct Extent: Equatable {
    var offset: CGFloat = 0
    var height: CGFloat = 0
}

private final class Metrics {
    var extent = Extent()
    var reveal: Extent?
    var bottomMarkerY: CGFloat = 0
    var composerTop: CGFloat = 0
    var dragging = false
}
