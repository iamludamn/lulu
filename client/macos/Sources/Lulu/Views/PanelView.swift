import PiStackKit
import SwiftUI

enum PanelLayout {
    static let width: CGFloat = 388
    static let gap: CGFloat = 16
    static let small: CGFloat = (width - gap) / 2
    static let rail: CGFloat = 16 + width + 16
}

struct PanelView: View {
    let widgets: [PanelWidget]
    let botName: String
    let botId: String
    let api: Api
    let onPrompt: (String) -> Void
    let onDraft: (String) -> Void
    let onDrop: (String) -> Void
    let onCheck: (String, Int, Bool) -> Void

    private static let ideas = ["把今天的日程做成一个组件", "每天早上给我一份简报", "追踪一个我关心的数字"]

    var body: some View {
        ScrollView {
            VStack(spacing: PanelLayout.gap) {
                ForEach(rows(widgets), id: \.first!.id) { row in
                    HStack(alignment: .top, spacing: PanelLayout.gap) {
                        ForEach(row) { widget in
                            WidgetCard(widget: widget, botId: botId, api: api, onPrompt: onPrompt, onDrop: onDrop, onCheck: { onCheck(widget.id, $0, $1) })
                                .frame(width: widget.size == .s ? PanelLayout.small : PanelLayout.width)
                                .transition(.scale(scale: 0.92).combined(with: .opacity))
                        }
                    }
                    .frame(width: PanelLayout.width, alignment: .leading)
                }
                if widgets.isEmpty { empty }
                Button { onDraft("帮我在视图里加一个组件：") } label: {
                    Label("添加一个组件", systemImage: "plus")
                        .type(15, .medium, line: 19)
                        .foregroundStyle(Color.ink)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .contentShape(.capsule)
                }
                .buttonStyle(Glassy(shape: Capsule(), tint: .pane))
            }
            .frame(width: PanelLayout.width)
            .padding(.top, ChatView.topInset)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
            .animation(.snappy, value: widgets.map(\.id))
        }
        .scrollIndicators(.never)
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 76)
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 28)
            }
        }
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
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("你的看板").type(22, .semibold, line: 28)
                Text("在对话里告诉 \(botName) 想关注什么。它发来的组件卡片，选「放入视图」就会出现在这里。")
                    .type(13, line: 19)
                    .foregroundStyle(Color.muted)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Self.ideas, id: \.self) { idea in
                    Button { onDraft(idea) } label: {
                        Label(idea, systemImage: "plus").type(13, .medium, line: 18).padding(.horizontal, 14).frame(height: 36)
                    }
                    .buttonStyle(Glassy(shape: Capsule()))
                }
            }
        }
        .foregroundStyle(Color.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .pane(28)
    }
}

struct WidgetFace: View {
    let widget: PanelWidget
    let botId: String
    let api: Api
    var interactive = false
    var onPrompt: (String) -> Void = { _ in }
    var onCheck: (Int, Bool) -> Void = { _, _ in }

    private var height: CGFloat? {
        switch widget.size {
        case .s, .m: 176
        case .l: nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            WidgetBody(widget: widget, botId: botId, api: api, interactive: interactive, onPrompt: onPrompt, onCheck: onCheck)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: widget.size == .l ? 300 : nil, maxHeight: height, alignment: .topLeading)
        .clipShape(.rect(cornerRadius: 28, style: .continuous))
        .foregroundStyle(Color.ink)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if let icon = widget.icon {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(widget.tone?.color ?? Color.ink)
                    .frame(width: 22, height: 22)
                    .background(Color.veil, in: .circle)
            }
            Text(widget.title).type(15, .medium, line: 19).lineLimit(1)
            Spacer(minLength: 4)
            if widget.size != .s, let updatedAt = widget.updatedAt {
                Text(Date(timeIntervalSince1970: updatedAt / 1000), format: .relative(presentation: .named))
                    .type(12, line: 16)
                    .foregroundStyle(Color.faint)
            }
        }
    }
}

private struct WidgetCard: View {
    let widget: PanelWidget
    let botId: String
    let api: Api
    let onPrompt: (String) -> Void
    let onDrop: (String) -> Void
    let onCheck: (Int, Bool) -> Void
    @Environment(\.openSpace) private var openSpace
    @State private var hovering = false

    var body: some View {
        let card = WidgetFace(widget: widget, botId: botId, api: api, interactive: true, onPrompt: onPrompt, onCheck: onCheck)
            .pane(28)
            .contentShape(.rect(cornerRadius: 28, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if hovering, let origin = widget.origin {
                    Button { onDrop(origin) } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).frame(width: 24, height: 24)
                    }
                    .buttonStyle(Glassy(shape: Circle()))
                    .padding(14)
                    .help("删除组件")
                    .transition(.opacity)
                }
            }
            .onHover { hovering = $0 }
            .animation(.snappy(duration: 0.18), value: hovering)
            .contextMenu {
                if let page { Button("打开", systemImage: "safari") { openSpace(page, widget.id) } }
                if let origin = widget.origin {
                    Button("删除组件", systemImage: "trash", role: .destructive) { onDrop(origin) }
                }
            }
        if let page {
            Button { openSpace(page, widget.id) } label: { card }
                .buttonStyle(.plain)
        } else {
            card
        }
    }

    private var page: ArtifactAddress? {
        guard case .web(let src) = widget.body else { return nil }
        return ArtifactAddress(src)
    }
}
