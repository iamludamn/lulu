import AppKit
import PiStackKit
import SwiftUI

struct MessageRow: View, Equatable {
    let row: ChatRow
    let store: BotStore
    let botId: String
    let api: Api
    let tasks: [String]
    let onOpen: (ArtifactAddress) -> Void
    let onRead: (String) -> Void
    @State private var hovering = false

    static let bubbleWidth: CGFloat = 424

    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool { lhs.row == rhs.row && lhs.tasks == rhs.tasks }

    var body: some View {
        switch row.role {
        case .stamp:
            VStack(spacing: 10) {
                Rectangle().fill(Color.veil).frame(height: 1)
                Text(row.text).type(12, .medium, line: 16).foregroundStyle(Color.ink.opacity(0.3))
            }
            .padding(.top, 8)
            .padding(.bottom, 4)
        case .system:
            notice
        case .user, .assistant:
            if row.typing {
                TypingBubble(tasks: tasks)
            } else if let card = row.card {
                cardRow(card)
            } else {
                messageStack(mine: row.role == .user)
            }
        }
    }

    private func messageStack(mine: Bool) -> some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            bubble(mine: mine)
                .frame(maxWidth: Self.bubbleWidth, alignment: mine ? .trailing : .leading)
            footer
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    @ViewBuilder
    private func bubble(mine: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
        let content = Group {
            if mine {
                Text(linkified(AttributedString(row.text)))
                    .type(15, line: 19)
                    .foregroundStyle(Color.ink)
            } else if let full = row.body {
                VStack(alignment: .leading, spacing: 10) {
                    MarkdownText(text: row.text)
                    HStack(spacing: 4) {
                        Text(verbatim: "阅读全文 · 约 \(readingLength(full)) 字")
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                    }
                    .type(12, .medium, line: 16)
                    .foregroundStyle(hovering ? Color.ink : Color.muted)
                }
            } else {
                MarkdownText(text: row.text)
            }
        }
        .textSelection(.enabled)
        .padding(.horizontal, 16)
        .padding(.vertical, 14.5)
        .opacity(row.sending ? 0.55 : 1)
        content
            .pane(24, tint: mine ? .mine : .reply)
            .contentShape(shape)
            .onHover { hovering = $0 }
            .onTapGesture { if row.body != nil { onRead(row.id) } }
            .pointerStyle(row.body != nil ? .link : nil)
            .contextMenu {
                Button("拷贝", systemImage: "doc.on.doc") { copy(row.body.map { row.text + "\n\n" + $0 } ?? row.text) }
                if row.body != nil {
                    Button("阅读全文", systemImage: "doc.plaintext") { onRead(row.id) }
                }
                if row.widgetSource {
                    Button("做成视图组件", systemImage: "square.grid.2x2") { store.makeWidget(origin: row.id) }
                }
                if case .failed(let requestId?) = row.footer {
                    Divider()
                    Button("删除", systemImage: "trash", role: .destructive) { store.dismiss(requestId) }
                }
            }
    }

    @ViewBuilder
    private func cardRow(_ card: SentCard) -> some View {
        switch card {
        case .panel(let widget):
            kept(label: "放入视图", symbol: "square.grid.2x2") {
                WidgetFace(widget: widget, botId: botId, api: api)
                    .frame(width: widget.size == .s ? PanelLayout.small : PanelLayout.width)
                    .pane(28)
            }
        case .asset(let ref, let title, _):
            let address = ArtifactAddress(ref)
            kept(label: "收进资产", symbol: "tray.and.arrow.down") {
                Button { address.map(onOpen) } label: { FileCard(address: address, title: title) }
                    .buttonStyle(.plain)
                    .help(title)
            }
        }
    }

    private func kept<Content: View>(label: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 12) {
            content()
                .contextMenu { Button(label, systemImage: symbol) { keep() } }
            Button(action: keep) {
                Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).frame(width: 36, height: 36)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .help(label)
            .opacity(hovering ? 1 : 0)
        }
        .onHover { hovering = $0 }
        .animation(.snappy(duration: 0.2), value: hovering)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    private func keep() {
        withAnimation(.snappy) { store.keep(row.id) }
    }

    @ViewBuilder
    private var footer: some View {
        switch row.footer {
        case .read:
            Text("已读").type(12, .medium, line: 16).foregroundStyle(Color.faint).padding(.horizontal, 10)
        case .generating:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("生成组件中…")
            }
            .type(12, .medium, line: 16)
            .foregroundStyle(Color.muted)
            .padding(.horizontal, 10)
        case nil:
            EmptyView()
        case .failed(let requestId):
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill")
                Text("未送达")
                if let requestId {
                    Button("重试") { store.retry(requestId) }.buttonStyle(.plain).fontWeight(.semibold)
                }
            }
            .type(12, .medium, line: 16)
            .foregroundStyle(Color.failure)
            .padding(.horizontal, 10)
        }
    }

    private var notice: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.failure)
            Text(row.text).lineLimit(2)
            if let requestId = row.notice {
                Button("重试") { store.retry(requestId) }.buttonStyle(.plain).fontWeight(.semibold)
                Button("关闭") { store.dismiss(requestId) }.buttonStyle(.plain).foregroundStyle(Color.muted)
            }
        }
        .type(12, .medium, line: 16)
        .foregroundStyle(Color.ink)
        .padding(.horizontal, 16)
        .frame(height: 36)
        .pane(18)
        .frame(maxWidth: .infinity)
    }
}

struct FileCard: View {
    let address: ArtifactAddress?
    let title: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: fileSymbol(address)).font(.system(size: 17, weight: .medium))
            Text(title).type(15, .medium, line: 19).lineLimit(1)
        }
        .foregroundStyle(Color.sheetInk)
        .padding(.horizontal, 22)
        .frame(height: 68)
        .background(Color.sheet, in: .rect(cornerRadius: 24, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.line.opacity(0.6), lineWidth: 0.5) }
        .contentShape(.rect(cornerRadius: 24, style: .continuous))
    }
}

func fileSymbol(_ address: ArtifactAddress?) -> String {
    guard let address else { return "doc" }
    if address.isMarkdown { return "doc.text" }
    if address.isHTML { return "globe" }
    switch (address.name as NSString).pathExtension.lowercased() {
    case "png", "jpg", "jpeg", "gif", "webp", "heic": return "photo"
    case "pdf": return "doc.richtext"
    case "csv", "xlsx", "numbers": return "tablecells"
    default: return "doc"
    }
}

func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
