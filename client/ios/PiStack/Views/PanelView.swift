import PiStackKit
import SwiftUI

struct PanelView: View {
    let widgets: [PanelWidget]
    let botName: String
    let botId: String
    let api: Api
    let onPrompt: (String) -> Void
    let onDraft: (String) -> Void
    let onDrop: (String) -> Void
    let onOrder: ([String]) -> Void
    let onCompose: () -> Void
    @Environment(\.topInset) private var topInset
    @State private var editing = false

    private static let ideas = ["把今天的日程做成一个组件", "每天早上给我一份简报", "追踪一个我关心的数字"]

    var body: some View {
        ScrollView {
            if widgets.isEmpty {
                empty
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(rows(widgets), id: \.first!.id) { row in
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(row) { widget in
                                WidgetCard(widget: widget, botId: botId, api: api, editing: editing, onPrompt: onPrompt, onDrop: onDrop, onEdit: { editing = true })
                                    .reorderable(widget.id, editing: editing) { dragged, target in
                                        onOrder(widgets.map(\.id).moved(dragged, to: target))
                                    }
                            }
                            if row.count == 1 && row[0].size == .s { Color.clear.frame(maxWidth: .infinity) }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
                .animation(.snappy, value: widgets.map(\.id))
            }
        }
        .contentMargins(.top, topInset, for: .scrollContent)
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .doneBar(editing) { editing = false }
        .onChange(of: widgets.isEmpty) { _, empty in if empty { editing = false } }
    }

    private var composer: some View {
        Button(action: onCompose) {
            Text("给 \(botName) 发消息")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18)
                .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .composerChrome()
    }

    private func rows(_ widgets: [PanelWidget]) -> [[PanelWidget]] {
        var result: [[PanelWidget]] = []
        for widget in widgets {
            if widget.size == .s, let last = result.last, last.count == 1, last[0].size == .s {
                result[result.count - 1].append(widget)
            } else {
                result.append([widget])
            }
        }
        return result
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("你的看板").font(.largeTitle.weight(.bold))
                Text("在对话里告诉 \(botName) 想关注什么。它发来的组件卡片，左滑就能放到这里。")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Self.ideas, id: \.self) { idea in
                    Button { onDraft(idea) } label: {
                        Label(idea, systemImage: "plus").font(.subheadline.weight(.medium)).padding(.horizontal, 4).padding(.vertical, 4)
                    }
                    .buttonStyle(.glass)
                    .tint(.primary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.top, 40)
    }
}

struct WidgetFace: View {
    let widget: PanelWidget
    let botId: String
    let api: Api
    var interactive = false
    var onPrompt: (String) -> Void = { _ in }

    private var height: CGFloat? {
        switch widget.size {
        case .s, .m: 158
        case .l: nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            WidgetBody(widget: widget, botId: botId, api: api, interactive: interactive, onPrompt: onPrompt)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: widget.size == .l ? 300 : nil, maxHeight: height, alignment: .topLeading)
        .clipShape(.rect(cornerRadius: 26, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 6) {
            if let icon = widget.icon {
                Image(systemName: icon).foregroundStyle(widget.tone?.color ?? .secondary)
            }
            Text(widget.title).lineLimit(1)
            Spacer(minLength: 4)
            if widget.size != .s, let updatedAt = widget.updatedAt {
                Text(Date(timeIntervalSince1970: updatedAt / 1000), format: .relative(presentation: .named))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
    }
}

private struct WidgetCard: View {
    let widget: PanelWidget
    let botId: String
    let api: Api
    let editing: Bool
    let onPrompt: (String) -> Void
    let onDrop: (String) -> Void
    let onEdit: () -> Void

    var body: some View {
        WidgetFace(widget: widget, botId: botId, api: api, interactive: true, onPrompt: onPrompt)
            .frosted(26)
            .contentShape(.rect(cornerRadius: 26, style: .continuous))
            .contextMenu {
                if let ask = widget.ask {
                    Button("询问", systemImage: "bubble.left") { onPrompt(ask) }
                }
                Button("让 bot 刷新", systemImage: "arrow.clockwise") { onPrompt("刷新视图组件 \(widget.id)") }
                Button("调整排布", systemImage: "square.grid.2x2", action: onEdit)
                if let origin = widget.origin {
                    Button("从视图移除", systemImage: "trash", role: .destructive) { onDrop(origin) }
                }
            }
            .editable(editing, seed: abs(widget.id.hashValue), radius: 26) {
                if let origin = widget.origin { onDrop(origin) }
            }
    }
}
