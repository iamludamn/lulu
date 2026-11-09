import PiStackKit
import SwiftUI

struct MessageRow: View, Equatable {
    let row: ChatRow
    let store: BotStore
    let botId: String
    let api: Api
    let onOpen: (ArtifactAddress, String) -> Void
    let onKept: (Page) -> Void
    @Environment(\.openSpace) private var openSpace

    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool { lhs.row == rhs.row }

    var body: some View {
        switch row.role {
        case .stamp:
            Text(row.text)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        case .system:
            notice
        case .user, .assistant:
            if row.typing {
                live
            } else {
                if let card = row.card {
                    cardRow(card)
                } else {
                    messageStack(mine: row.role == .user)
                }
            }
        }
    }

    private func messageStack(mine: Bool) -> some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            HStack(spacing: 0) {
                if mine { Spacer(minLength: 48) }
                bubble(mine: mine)
                if !mine { Spacer(minLength: 32) }
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    @ViewBuilder
    private func bubble(mine: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        let content = Group {
            if mine {
                Text(linkified(AttributedString(row.text)))
            } else {
                MarkdownText(text: row.text)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 10)
        .opacity(row.sending ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "我" : "助手")：\(row.text)")
        .contentShape(.contextMenuPreview, shape)
        .contextMenu {
            Button("拷贝", systemImage: "doc.on.doc") { UIPasteboard.general.string = row.text }
            if row.widgetSource {
                Button("做成视图组件", systemImage: "square.grid.2x2") { store.makeWidget(origin: row.id) }
            }
            if case .failed(let requestId?) = row.footer {
                Button("删除", systemImage: "trash", role: .destructive) { store.dismiss(requestId) }
            }
        }
        if mine {
            content.background { shape.fill(.clear).glassEffect(.clear, in: shape) }
        } else {
            content.frosted(20)
        }
    }

    @ViewBuilder
    private func cardRow(_ card: SentCard) -> some View {
        switch card {
        case .panel(let widget):
            let face = WidgetFace(widget: widget, botId: botId, api: api)
                .frame(maxWidth: widget.size == .s && !widget.isSpace ? 176 : 360)
                .frosted(26)
                .contentShape(.rect(cornerRadius: 26, style: .continuous))
            if case .space(let src, _, _) = widget.body {
                let source = "chat-\(row.id)"
                kept(destination: .panel, label: "添加 Space", symbol: "square.stack.3d.up") {
                    Button { ArtifactAddress(src).map { openSpace($0, SpaceOpening(id: widget.id, title: widget.title, preview: true), source) } } label: { face }
                        .buttonStyle(.plain)
                        .artifactSource(source, radius: 26)
                }
            } else {
                kept(destination: .panel, label: "放入视图", symbol: "square.grid.2x2") { face }
            }
        case .asset(let ref, let title, let summary):
            let address = ArtifactAddress(ref)
            let source = "chat-\(row.id)"
            kept(destination: .assets, label: "收进资产", symbol: "tray.and.arrow.down") {
                Button { address.map { onOpen($0, source) } } label: { assetFace(address, title: title, summary: summary) }
                    .buttonStyle(.plain)
                    .artifactSource(source, radius: 22)
            }
        }
    }

    private func kept<Content: View>(destination: Page, label: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        let card = content()
        return SwipeToKeep(destination: destination, onLand: { onKept(destination) }, onKeep: { store.keep(row.id) }) { send in
            card
                .contextMenu {
                    Button(label, systemImage: symbol, action: send)
                }
                .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity)
    }

    private func assetFace(_ address: ArtifactAddress?, title: String, summary: String?) -> some View {
        HStack(spacing: 12) {
            AssetPage(address: address, botId: botId, api: api, scale: 0.16)
                .frame(width: 46, height: 58)
                .background(Color.paper)
                .clipShape(.rect(cornerRadius: 6, style: .continuous))
                .shadow(color: .black.opacity(0.1), radius: 3, y: 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(summary ?? address?.fileName ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: 320, alignment: .leading)
        .frosted(22)
        .contentShape(.rect(cornerRadius: 22, style: .continuous))
    }

    private var live: some View {
        HStack(spacing: 8) {
            TypingDots()
            if !row.text.isEmpty {
                Text(row.text).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frosted(20)
            .background(alignment: .bottomLeading) {
                ZStack(alignment: .bottomLeading) {
                    Circle().fill(.ultraThinMaterial).overlay { Circle().fill(Color.frost) }.frame(width: 12, height: 12).offset(x: 2, y: 2)
                    Circle().fill(.ultraThinMaterial).overlay { Circle().fill(Color.frost) }.frame(width: 6, height: 6).offset(x: -4, y: 9)
                }
            }
            .padding(.leading, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.snappy, value: row.text)
            .accessibilityLabel("助手正在输入")
    }

    private var generating: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("生成中…")
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .opacity(row.footer == .generating ? 1 : 0)
        .animation(.snappy, value: row.footer)
        .accessibilityHidden(row.footer != .generating)
    }

    @ViewBuilder
    private var footer: some View {
        if row.widgetSource {
            generating
        } else {
            status
        }
    }

    @ViewBuilder
    private var status: some View {
        switch row.footer {
        case .read:
            Text("已读").font(.caption2.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 8)
        case .generating, nil:
            EmptyView()
        case .failed(let requestId):
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill")
                Text("未送达")
                if let requestId {
                    Button("重试") { store.retry(requestId) }.fontWeight(.semibold)
                }
            }
            .font(.caption)
            .foregroundStyle(.red)
            .padding(.horizontal, 8)
        }
    }

    private var notice: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(row.text).lineLimit(2)
            if let requestId = row.notice {
                Button("重试") { store.retry(requestId) }.fontWeight(.semibold)
                Button("关闭") { store.dismiss(requestId) }.foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .glassEffect(.regular, in: .capsule)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}
