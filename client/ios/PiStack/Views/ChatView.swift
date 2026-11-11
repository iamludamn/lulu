import PiStackKit
import SwiftUI

struct ChatView: View {
    let bot: BotSummary
    let store: BotStore
    let api: Api
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding
    let onKept: (Page) -> Void
    @State private var pinned = true
    @State private var dragging = false
    @State private var sent = 0
    @State private var floor: String?
    @State private var position = ScrollPosition()
    @State private var metrics = Metrics()
    @State private var reading: ChatRow?
    @Environment(\.topInset) private var topInset
    @Environment(\.openArtifact) private var openArtifact

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
                    if start > 0 {
                        Button("更早的消息") { revealEarlier(rows, start) }
                            .buttonStyle(.plain)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .id("earlier")
                    }
                    ForEach(rows[start...]) { row in
                        MessageRow(row: row, store: store, botId: bot.id, api: api, onRead: { id in reading = rows.first { $0.id == id } }, onOpen: openArtifact, onKept: onKept)
                            .equatable()
                            .padding(.bottom, row.tail ? 12 : 0)
                            .transition(.opacity.animation(.easeOut(duration: 0.2)))
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(pinned ? .bottom : nil, for: .sizeChanges)
            .scrollPosition($position)
            .scrollClipDisabled()
            .contentMargins(.top, topInset, for: .scrollContent)
            .scrollDismissesKeyboard(.interactively)
            .onScrollPhaseChange { _, phase in
                dragging = phase == .interacting || phase == .decelerating
            }
            .onScrollGeometryChange(for: Bool.self) { $0.visibleRect.maxY > $0.contentSize.height - 24 } action: { _, near in
                if dragging || near { pinned = near }
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
            .onChange(of: sent) {
                Task {
                    try? await Task.sleep(for: .milliseconds(60))
                    proxy.scrollTo(Self.bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !pinned {
                    Button {
                        pinned = true
                        withAnimation { proxy.scrollTo(Self.bottom) }
                    } label: {
                        Image(systemName: "arrow.down").font(.headline).frame(width: 32, height: 32)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .padding(16)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.snappy, value: pinned)
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
                Composer(draft: $draft, busy: busy, placeholder: placeholder, focused: composing, onSend: send)
            }
        }
        .sheet(item: $reading) { row in
            if let text = row.body { LongReader(text: text) }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .light), trigger: reading?.id) { _, new in new != nil }
        .sensoryFeedback(.success, trigger: busy) { old, new in old && !new }
    }

    private func transition(_ row: ChatRow) -> AnyTransition {
        if row.card != nil { return .asymmetric(insertion: .scale(scale: 0.85).combined(with: .opacity), removal: .identity) }
        guard row.role == .user || row.typing else { return .identity }
        return .asymmetric(
            insertion: .scale(scale: 0.92, anchor: row.role == .user ? .bottomTrailing : .bottomLeading).combined(with: .opacity),
            removal: .identity
        )
    }

    private var placeholder: String { "给 \(bot.name) 发消息" }

    private func revealEarlier(_ rows: [ChatRow], _ start: Int) {
        metrics.reveal = metrics.extent
        floor = rows[max(0, start - Self.page)].id
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
}
