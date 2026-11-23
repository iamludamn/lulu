import LuluKit
import SwiftUI
import UIKit

struct ChatView: View {
    let bot: BotSummary
    let store: BotStore
    let noteStore: NoteStore
    let noteFiles: [NoteFile]
    let transcription: VoiceTranscription
    let api: Api
    let containerBottomInset: CGFloat
    @Binding var draft: String
    @Binding var sent: Int
    var composing: FocusState<Bool>.Binding
    let onKept: (Page) -> Void
    let onVoiceConversation: () -> Void
    @Binding var reading: ChatRow?
    let onReaderFrame: (ReaderFrame) -> Void
    @State private var bottomState = ChatBottomState()
    @State private var composerBottom: CGFloat?
    @State private var syncingReference = false
    @State private var referenceError: String?
    @State private var preventedAccept: String?
    @State private var keeping: Set<String> = []
    @State private var floor: String?
    @State private var revealAnchor: RevealAnchor?
    @State private var metrics = Metrics()
    @Environment(\.topInset) private var topInset
    @Environment(\.openArtifact) private var openArtifact
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let bottom = "bottom"
    private static let page = 40
    private static let suggestions = ["今天有什么安排？", "把我关心的数据做成组件", "总结一下你记住了我什么"]

    private var snapshot: BotStore.Snapshot { store.snapshot }
    private var busy: Bool { snapshot.link == .online && live(of: snapshot.view).busy }
    private var reconnecting: Bool { snapshot.link == .offline }

    var body: some View {
        let realRows = chatRows(snapshot, entries: store.transcriptEntries, keeping: keeping)
        let rows = noteStore.transcript(realRows)
        let start = startIndex(in: rows)
        let firstMessage = firstHistoryRowID(in: rows, startingAt: start)
        let measuredRow = revealAnchor?.id ?? firstMessage
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 4) {
                    if start > 0 || snapshot.view?.before != nil {
                        historyControl(rows, start: start, firstMessage: firstMessage)
                    }
                    ForEach(rows[start...]) { row in
                        Group {
                            if let offer = noteStore.offers[row.id] {
                                let requests = snapshot.requests.filter {
                                    if case .acceptNote(let origin) = $0.command.kind { origin == offer.id } else { false }
                                }
                                NoteOfferRow(offer: offer, files: noteFiles,
                                             sending: requests.contains { $0.state == .sending },
                                             error: preventedAccept == offer.id ? "原笔记有未同步的修改，请同步后重新生成" : requests.last?.error,
                                             onLand: { onKept(.notes) }, onAccept: { accept(offer) })
                            } else {
                                MessageRow(row: row, store: store, botId: bot.id, api: api, expanded: row.id == reading?.id,
                                           onRead: { reading = $0 }, onOpen: openArtifact, onKept: onKept,
                                           onSaveNote: { proposeNote(from: row) }) { hold in
                                    if hold { keeping.insert(row.id) }
                                    else { keeping.remove(row.id) }
                                }
                                .equatable()
                            }
                        }
                            .padding(.bottom, row.tail && row.id != rows.last?.id ? 12 : 0)
                            .background {
                                if row.id == measuredRow {
                                    Color.clear
                                        .allowsHitTesting(false)
                                        .onGeometryChange(for: RevealAnchor.self) { proxy in
                                            RevealAnchor(id: row.id, y: proxy.frame(in: .global).minY)
                                        } action: { anchor in updateRevealAnchor(anchor) }
                                }
                            }
                            .transition(reduceMotion ? .identity : .opacity.animation(.easeOut(duration: 0.2)))
                    }
                    if noteStore.generating {
                        HStack(spacing: 7) {
                            ProgressView().controlSize(.small)
                            Text("Lulu 正在整理笔记…").font(.footnote)
                        }
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                    }
                    Color.clear.frame(height: 1)
                        .id(Self.bottom)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { metrics.bottomMarkerY = $0; updateBottomState() }
                }
                .padding(.horizontal, 16)
                .padding(.top, topInset + 8)
                .padding(.bottom, 8)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
                .background { ChatScrollAnchor(metrics: metrics) }
            }
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(revealAnchor == nil && bottomState.pinned ? .bottom : nil, for: .sizeChanges)
            .scrollClipDisabled()
            .scrollDismissesKeyboard(.interactively)
            .onScrollPhaseChange { _, phase in
                metrics.dragging = phase == .interacting || phase == .decelerating
                if phase == .interacting { revealAnchor = nil }
            }
            .onChange(of: composing.wrappedValue) { _, _ in revealAnchor = nil }
            .onChange(of: rows.count > Self.page, initial: true) { _, long in
                if long, floor == nil { floor = firstMessage }
            }
            .onChange(of: store.historyLoad) { previous, current in
                guard previous == .loading else { return }
                if current == .idle, start > 0 { revealEarlier(rows, start) }
                if case .failed = current { revealAnchor = nil }
            }
            .onChange(of: sent) {
                followLatest()
                Task {
                    try? await Task.sleep(for: .milliseconds(60))
                    guard bottomState.pinned else { return }
                    proxy.scrollTo(Self.bottom, anchor: .bottom)
                }
            }
            .onChange(of: noteStore.offers.count) {
                followLatest()
                proxy.scrollTo(Self.bottom, anchor: .bottom)
            }
            .task(id: noteStore.requestedRow) {
                guard let id = noteStore.requestedRow else { return }
                if let index = rows.firstIndex(where: { $0.id == id }) {
                    if index < start { floor = id }
                    await Task.yield()
                    proxy.scrollTo(id, anchor: .center)
                }
                if noteStore.requestedRow == id { noteStore.requestedRow = nil }
            }
            .overlay(alignment: .bottom) {
                if bottomState.showJump {
                    Button {
                        let scrollView = metrics.scrollView
                        scrollView?.stopScrollingAndZooming()
                        let viewportHeight = scrollView?.bounds.height ?? 0
                        let animate = !reduceMotion && distanceFromLatest <= viewportHeight
                        followLatest()
                        withAnimation(animate ? .easeOut(duration: 0.26) : nil) {
                            proxy.scrollTo(Self.bottom, anchor: .bottom)
                        }
                    } label: {
                        Image(systemName: "arrow.down").font(.headline).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("回到最新消息")
                    .accessibilityHint("滚动到对话最底部")
                    .padding(.bottom, 12)
                    .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: bottomState.showJump)
        }
        .overlay { gate(rows) }
        .alert("无法带回笔记", isPresented: Binding(get: { referenceError != nil }, set: { if !$0 { referenceError = nil } })) {
            Button("好", role: .cancel) { referenceError = nil }
        } message: {
            Text(referenceError ?? "")
        }
        .overlay(alignment: .top) {
            if reconnecting && (snapshot.view != nil || !rows.isEmpty) {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.exclamationmark")
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
        .animation(reduceMotion ? nil : .snappy, value: reconnecting)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if snapshot.halt == nil {
                VStack(alignment: .leading, spacing: 0) {
                    if let note = noteStore.context { noteReference(note) }
                    Composer(draft: $draft, store: store, transcription: transcription, onTranscribed: transcribed, busy: busy, placeholder: placeholder, focused: composing, onSend: send, onVoiceConversation: onVoiceConversation)
                }
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
                    .modifier(ComposerKeyboardAvoidance(focused: composing.wrappedValue))
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

    private func followLatest() {
        revealAnchor = nil
        metrics.dragging = false
        bottomState.followLatest()
    }

    private var distanceFromLatest: CGFloat {
        guard metrics.composerTop > 0 else { return 0 }
        return max(0, metrics.bottomMarkerY - metrics.composerTop + 8)
    }

    private func updateBottomState() {
        var next = bottomState
        next.update(distance: distanceFromLatest, userScrolling: metrics.dragging)
        if bottomState != next { bottomState = next }
    }

    private var placeholder: String { "给 \(bot.name) 发消息" }

    private func startIndex(in rows: [ChatRow]) -> Int {
        guard let floor, let index = rows.firstIndex(where: { $0.id == floor }) else {
            return max(0, rows.count - Self.page)
        }
        return index > 0 && rows[index - 1].role == .stamp ? index - 1 : index
    }

    private func firstHistoryRowID(in rows: [ChatRow], startingAt index: Int) -> String? {
        rows[index...].first { $0.role != .stamp && !$0.typing }?.id
    }

    private func revealEarlier(_ rows: [ChatRow], _ start: Int) {
        floor = firstHistoryRowID(in: rows, startingAt: max(0, start - Self.page))
    }

    private func preserveMessage(_ id: String?) {
        guard let anchor = metrics.visibleAnchor, anchor.id == id else { return }
        metrics.scrollView?.stopScrollingAndZooming()
        revealAnchor = anchor
    }

    private func updateRevealAnchor(_ anchor: RevealAnchor) {
        metrics.visibleAnchor = anchor
        guard let revealAnchor, revealAnchor.id == anchor.id, let scroll = metrics.scrollView else { return }
        let shift = anchor.y - revealAnchor.y
        guard abs(shift) >= 0.5 else { return }
        let minimum = -scroll.adjustedContentInset.top
        let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let offset = scroll.contentOffset
        let target = min(maximum, max(minimum, offset.y + shift))
        guard abs(target - offset.y) >= 0.5 else { return }
        scroll.setContentOffset(CGPoint(x: offset.x, y: target), animated: false)
    }

    private func transcribed(_ text: String, sendImmediately: Bool) {
        if sendImmediately {
            submit(text, clearDraft: false)
        } else {
            draft += text
            composing.wrappedValue = true
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        submit(text, clearDraft: true)
    }

    private func submit(_ text: String, clearDraft: Bool) {
        guard !text.isEmpty, !syncingReference else { return }
        let anchor = store.transcriptEntries.last?.id
        if noteStore.mockData {
            _ = noteStore.handleSend(text, anchor: anchor)
            composing.wrappedValue = false
            didSend(clearDraft: clearDraft)
        } else if let reference = noteStore.context {
            let draftAtSend = draft
            syncingReference = true
            Task {
                defer { syncingReference = false }
                do {
                    let synced = try await noteStore.synchronizedReference(reference)
                    guard store.snapshot.link == .online else { throw ApiError.message("当前未连接，请联网后重试") }
                    guard noteStore.context?.id == synced.id else {
                        throw ApiError.message("笔记引用已变化，请确认后重新发送")
                    }
                    store.submit(text, noteId: synced.id, revision: synced.revision)
                    didSend(clearDraft: clearDraft && draft == draftAtSend)
                } catch {
                    if !clearDraft {
                        draft += draft.isEmpty ? text : "\n" + text
                    }
                    referenceError = error.localizedDescription
                }
            }
        } else {
            store.submit(text)
            didSend(clearDraft: clearDraft)
        }
    }

    private func didSend(clearDraft: Bool) {
        sent += 1
        if clearDraft { draft = "" }
    }

    private func accept(_ offer: NoteStore.Offer) {
        if noteStore.mockData {
            noteStore.accept(offer.id)
        } else if let id = UUID(uuidString: offer.id) {
            if let original = offer.original, noteStore.hasLocalEdits(original.id) {
                preventedAccept = offer.id
            } else {
                preventedAccept = nil
                store.acceptNote(id)
            }
        }
    }

    private func proposeNote(from row: ChatRow) {
        if !noteStore.mockData {
            store.generateNote(from: row.id)
            return
        }
        let realRows = chatRows(snapshot, entries: store.transcriptEntries, keeping: keeping)
        let anchor = realRows.last { $0.isBubble && !$0.typing }?.id
        let earlier = noteStore.transcript(realRows).prefix { $0.id != row.id }
        noteStore.propose(from: row, context: Array(earlier), anchor: anchor)
    }

    private func noteReference(_ note: Note) -> some View {
        NoteThumbnail(note: note, inComposer: true)
            .frame(width: 116, height: 68)
            .noteThumbnailSurface()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("引用笔记，\(note.displayTitle)")
            .overlay(alignment: .topTrailing) {
                Button { noteStore.attach(nil) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(7)
                        .frame(width: 44, height: 44, alignment: .topTrailing)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("移除笔记引用")
            }
            .padding(.leading, 16)
            .padding(.bottom, 7)
    }

    private func historyControl(_ rows: [ChatRow], start: Int, firstMessage: String?) -> some View {
        let history = store.historyLoad
        let remote = start == 0
        return VStack(spacing: 6) {
            Button {
                if remote {
                    store.loadEarlier()
                    guard store.historyLoad == .loading else { return }
                    preserveMessage(firstMessage)
                    floor = firstMessage
                } else {
                    preserveMessage(firstMessage)
                    revealEarlier(rows, start)
                }
            } label: {
                HStack(spacing: 6) {
                    if remote, history == .loading {
                        ProgressView().controlSize(.mini)
                        Text("正在加载更早的消息…")
                    } else if remote, case .failed = history {
                        Text("重试加载更早的消息")
                    } else {
                        Text("更早的消息")
                    }
                }
                .font(.caption.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .buttonStyle(.glass)
            .tint(.primary)
            .disabled(remote && history == .loading)
            if remote, case .failed(let reason) = history {
                Text("早期消息加载失败：\(reason)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    @ViewBuilder
    private func gate(_ rows: [ChatRow]) -> some View {
        if rows.isEmpty {
            if snapshot.view != nil {
                welcome
            } else if reconnecting {
                ContentUnavailableView {
                    Label("暂时无法连接 lulu", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("正在尝试重新连接。")
                }
                .allowsHitTesting(false)
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

private struct RevealAnchor: Equatable {
    let id: String
    let y: CGFloat
}

private final class Metrics {
    weak var scrollAnchor: UIView?

    var scrollView: UIScrollView? {
        var ancestor = scrollAnchor?.superview
        while let view = ancestor {
            if let scrollView = view as? UIScrollView { return scrollView }
            ancestor = view.superview
        }
        return nil
    }

    var visibleAnchor: RevealAnchor?
    var bottomMarkerY: CGFloat = 0
    var composerTop: CGFloat = 0
    var dragging = false
}

private struct ChatScrollAnchor: UIViewRepresentable {
    let metrics: Metrics

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        metrics.scrollAnchor = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}
}
