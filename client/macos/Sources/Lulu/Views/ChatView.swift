import PiStackKit
import SwiftUI

struct ChatView: View {
    let bot: BotSummary
    let store: BotStore
    let api: Api
    let column: CGFloat
    @Binding var draft: String
    let focus: Int
    let onFocus: () -> Void
    @State private var pinned = true
    @State private var scrolling = false
    @State private var floor: String?
    @State private var sent = 0
    @State private var composerHeight = Composer.minHeight
    @Environment(\.openArtifact) private var openArtifact
    @Environment(\.openText) private var openText

    private static let bottom = "bottom"
    private static let page = 40
    private static let suggestions = ["今天有什么安排？", "把我关心的数据做成组件", "总结一下你记住了我什么"]
    static let topInset: CGFloat = 84
    static let bottomGap: CGFloat = 32

    private var snapshot: BotStore.Snapshot { store.snapshot }
    private var busy: Bool { live(of: snapshot.view).busy }
    private var reconnecting: Bool { snapshot.link == .offline && snapshot.halt == nil }

    var body: some View {
        let rows = chatRows(snapshot)
        let tasks = subtasks(of: snapshot.progress).filter(\.running).map(\.description)
        let start = floor.flatMap { id in rows.firstIndex { $0.id == id } } ?? max(0, rows.count - Self.page)
        ZStack(alignment: .bottom) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 4) {
                        if start > 0 {
                            Button("更早的消息") { floor = rows[max(0, start - Self.page)].id }
                                .buttonStyle(.plain)
                                .type(12, .medium, line: 16)
                                .foregroundStyle(Color.muted)
                                .padding(.vertical, 8)
                        }
                        ForEach(rows[start...]) { row in
                            MessageRow(row: row, store: store, botId: bot.id, api: api, tasks: row.typing ? tasks : [], onOpen: openArtifact, onRead: { id in
                                if let body = rows.first(where: { $0.id == id })?.body { openText(body) }
                            })
                            .equatable()
                            .padding(.bottom, row.tail ? 10 : 0)
                            .transition(transition(row))
                        }
                        Color.clear.frame(height: composerHeight + Self.bottomGap + 8).id(Self.bottom)
                    }
                    .frame(width: column)
                    .padding(.top, Self.topInset)
                    .frame(maxWidth: .infinity)
                    .animation(.snappy, value: rows.map(\.id))
                }
                .defaultScrollAnchor(.bottom)
                .defaultScrollAnchor(pinned ? .bottom : nil, for: .sizeChanges)
                .onScrollPhaseChange { _, phase in scrolling = phase != .idle }
                .onScrollGeometryChange(for: Bool.self) { $0.visibleRect.maxY > $0.contentSize.height - 40 } action: { _, near in
                    if scrolling || near { pinned = near }
                }
                .onChange(of: rows.last?.id) {
                    guard pinned else { return }
                    Task {
                        try? await Task.sleep(for: .milliseconds(30))
                        withAnimation(.snappy) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                    }
                }
                .onChange(of: rows.count > Self.page, initial: true) { _, long in
                    if long, floor == nil { floor = rows[rows.count - Self.page].id }
                }
                .onChange(of: sent) {
                    Task {
                        try? await Task.sleep(for: .milliseconds(60))
                        withAnimation(.snappy) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                    }
                }
                .mask { fade }
                .overlay(alignment: .bottom) {
                    if !pinned && !rows.isEmpty {
                        Button {
                            pinned = true
                            withAnimation(.snappy) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                        } label: {
                            Image(systemName: "chevron.down").font(.system(size: 14, weight: .semibold)).frame(width: 40, height: 40)
                        }
                        .buttonStyle(Glassy(shape: Circle(), tint: .pane))
                        .padding(.bottom, composerHeight + Self.bottomGap + 12)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                        .help("滚动到底部")
                    }
                }
                .animation(.snappy, value: pinned)
            }
            if snapshot.halt == nil {
                Composer(draft: $draft, busy: busy, placeholder: "给 \(bot.name) 发消息", focus: focus, onSend: send, onStop: store.abort)
                    .frame(width: column)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerHeight = $0 }
                    .padding(.bottom, Self.bottomGap)
            }
        }
        .overlay { gate(rows) }
        .overlay(alignment: .top) {
            if reconnecting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text("正在重连…")
                }
                .type(12, .medium, line: 16)
                .foregroundStyle(Color.ink)
                .padding(.horizontal, 14)
                .frame(height: 32)
                .glass(Capsule())
                .padding(.top, 70)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: reconnecting)
    }

    private var fade: some View {
        GeometryReader { proxy in
            let height = max(proxy.size.height, 1)
            let edge = height - Self.bottomGap - composerHeight
            LinearGradient(stops: [
                .init(color: .clear, location: 44 / height),
                .init(color: .black, location: 88 / height),
                .init(color: .black, location: max(88, edge - 28) / height),
                .init(color: .black.opacity(0.25), location: max(89, edge + 8) / height),
                .init(color: .clear, location: max(90, edge + composerHeight) / height),
            ], startPoint: .top, endPoint: .bottom)
        }
    }

    private func transition(_ row: ChatRow) -> AnyTransition {
        if row.card != nil { return .asymmetric(insertion: .scale(scale: 0.9).combined(with: .opacity), removal: .scale(scale: 0.9).combined(with: .opacity)) }
        guard row.role == .user || row.typing else { return .opacity }
        return .asymmetric(
            insertion: .scale(scale: 0.94, anchor: row.role == .user ? .bottomTrailing : .bottomLeading).combined(with: .opacity),
            removal: .opacity
        )
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        pinned = true
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
                ProgressView().controlSize(.small)
            } else if rows.isEmpty {
                welcome
            }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("你好，我是 \(bot.name)").type(30, .semibold, line: 38).tracking(-0.4)
                Text("交给我的事，我会记住并替你跟进。").type(15, line: 21).foregroundStyle(Color.muted)
            }
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Self.suggestions, id: \.self) { text in
                    Button {
                        draft = text
                        onFocus()
                    } label: {
                        Text(text).type(13, .medium, line: 18).padding(.horizontal, 16).frame(height: 36)
                    }
                    .buttonStyle(Glassy(shape: Capsule(), tint: .pane))
                }
            }
        }
        .foregroundStyle(Color.ink)
        .frame(width: column, alignment: .leading)
        .padding(.bottom, 80)
    }
}
