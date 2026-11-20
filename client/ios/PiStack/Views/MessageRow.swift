import PiStackKit
import SwiftUI

struct MessageRow: View, Equatable {
    let row: ChatRow
    let store: BotStore
    let botId: String
    let api: Api
    let expanded: Bool
    let onRead: (ChatRow) -> Void
    let onOpen: (ArtifactAddress, String) -> Void
    let onKept: (Page) -> Void
    let onSaveNote: () -> Void
    let holdKeepRow: (Bool) -> Void
    @Environment(\.openSpace) private var openSpace
    @State private var showsSchedules = false
    @State private var submittingOffer: (state: ViewOfferState, error: String?)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool { lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.botId == rhs.botId && lhs.api.base == rhs.api.base }

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
                if mine { Spacer(minLength: 56) }
                bubble(mine: mine)
                if !mine { Spacer(minLength: 56) }
            }
            if mine {
                userFooter
            } else {
                footer
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private var userFooter: some View {
        let isRead = row.footer == .read
        return ZStack(alignment: .trailing) {
            Text("已读")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .offset(y: isRead || reduceMotion ? 0 : 10)
                .opacity(isRead ? 1 : 0)
                .clipped()
                .accessibilityHidden(!isRead)
                .animation(.easeOut(duration: reduceMotion ? 0.15 : 0.45), value: isRead)
            if !isRead { status }
        }
    }

    @ViewBuilder
    private func bubble(mine: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        let content = Group {
            if mine {
                Text(linkified(AttributedString(row.text)))
            } else if let full = row.body {
                VStack(alignment: .leading, spacing: 8) {
                    MarkdownText(text: row.text, airy: true).equatable()
                    LongHint(length: readingLength(full))
                }
            } else {
                MarkdownText(text: row.text, airy: true).equatable()
            }
        }
        .lineSpacing(3)
        .padding(.horizontal, 15)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "我" : "助手")：\(row.text)\(row.body == nil ? "" : "。含全文")")
        .accessibilityAddTraits(row.body == nil ? [] : .isButton)
        Group {
            if mine {
                content.background { shape.fill(.clear).glassEffect(.clear, in: shape) }
            } else if row.body != nil {
                content.frosted(20)
                    .longReplyHighlight(radius: 20, key: "pistack.longReply.read.\(api.base.absoluteString).\(botId).\(row.id)") { onRead(row) }
                    .contentShape(shape)
                    .opacity(expanded ? 0 : 1)
                    .anchorPreference(key: LongBubbleBounds.self, value: .bounds) { expanded ? [row.id: $0] : [:] }
            } else {
                content.frosted(20)
            }
        }
        .contentShape(.contextMenuPreview, shape)
        .contextMenu {
            Button("拷贝", systemImage: "doc.on.doc") { UIPasteboard.general.string = row.body.map { row.text + "\n\n" + $0 } ?? row.text }
            if row.widgetSource {
                Button("存入 Note", systemImage: "note.text.badge.plus", action: onSaveNote)
                Button("做成视图组件", systemImage: "square.grid.2x2") { store.makeWidget(origin: row.id) }
            }
            if case .failed(let requestId?) = row.footer {
                Button("删除", systemImage: "trash", role: .destructive) { store.dismiss(requestId) }
            }
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
            if case .space(let src, _, _, _) = widget.body {
                let source = "chat-\(row.id)"
                let state = row.viewOffer ?? .add
                if let offer = submittingOffer?.state ?? (state.actionable ? state : nil) {
                    viewOfferSwipe(offer) {
                        Button { ArtifactAddress(src).map { openSpace($0, SpaceOpening(id: widget.id, title: widget.title, preview: true), source) } } label: { face }
                            .buttonStyle(.plain)
                            .artifactSource(source, radius: 26)
                    }
                } else if case .accepted = state {
                    offerCaption(state.caption) {
                        guard let current = store.snapshot.panel.widgets[widget.id],
                              case .space(let ref, _, let refresh, _) = current.body,
                              let address = ArtifactAddress(ref) else { return }
                        openSpace(address, SpaceOpening(id: current.id, title: current.title, refresh: refresh), source)
                    }
                    .accessibilityHint("打开\(widget.title)的当前版本")
                    .artifactSource(source, radius: 8)
                } else {
                    HStack(spacing: 10) {
                        Image(systemName: "clock.arrow.circlepath")
                            .foregroundStyle(.secondary)
                        Text(widget.title).font(.subheadline).lineLimit(1)
                        Text(state.caption).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(14).frame(maxWidth: 360).frosted(18)
                    .artifactSource(source, radius: 18)
                    .padding(.vertical, 8)
                }
            } else if case .schedules(_, let rows) = widget.body {
                let state = row.viewOffer ?? .superseded
                Group {
                    if let offer = submittingOffer?.state ?? (state.actionable ? state : nil) {
                        viewOfferSwipe(offer) { schedulesButton(face) }
                    } else if case .accepted = state {
                        offerCaption(state.caption) { showsSchedules = true }
                            .accessibilityHint("查看全部定时任务")
                    } else {
                        VStack(spacing: 8) {
                            schedulesButton(face)
                            Label(state.caption, systemImage: state == .superseded ? "clock.arrow.circlepath" : "checkmark.circle")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 10)
                    }
                }
                .sheet(isPresented: $showsSchedules) { ScheduleOverview(rows: rows) }
            } else {
                kept(destination: .panel, label: "放入视图", symbol: "square.grid.2x2") { face }
            }
        case .asset(let ref, let title, let summary):
            let address = ArtifactAddress(ref)
            let source = "chat-\(row.id)"
            kept(destination: .notes, label: "收进 Note", symbol: "tray.and.arrow.down") {
                Button { address.map { onOpen($0, source) } } label: { assetFace(address, title: title, summary: summary) }
                    .buttonStyle(.plain)
                    .artifactDownloadFeedback(source)
                    .artifactSource(source, radius: 22)
            }
        }
    }

    private func offerCaption(_ caption: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(caption)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }

    private func schedulesButton<Content: View>(_ face: Content) -> some View {
        Button { showsSchedules = true } label: { face }
            .buttonStyle(.plain)
            .accessibilityHint("查看全部定时任务")
    }

    private func viewOfferSwipe<Content: View>(_ state: ViewOfferState, @ViewBuilder face: () -> Content) -> some View {
        let label = state == .update ? "更新视图" : "加入视图"
        let confirmed = if case .accepted? = row.viewOffer { true } else { row.keepConfirmed }
        let failed = !row.offerAvailable || row.offerError != nil || row.viewOffer == .superseded
        let enabled = !row.sending && row.offerAvailable && !confirmed && row.viewOffer?.actionable != false
        let showsSending = row.sending && submittingOffer == nil
        // Keep the card at the same height when retry clears the error.
        let displayedError = if let submittingOffer { submittingOffer.error } else { row.offerError }
        let card = face()
        return SwipeToKeep(
            destination: .panel,
            onLand: { onKept(.panel) },
            onKeep: { store.keep(row.id) },
            holdRow: { hold in
                submittingOffer = hold ? (state, row.offerError) : nil
                holdKeepRow(hold)
            },
            sending: row.sending,
            confirmed: confirmed,
            horizontalExit: true,
            failed: failed,
            pendingLabel: state == .update ? "正在更新…" : "正在加入…",
            enabled: enabled
        ) { send, armed in
            VStack(spacing: 8) {
                card.contextMenu {
                    Button(label, systemImage: "square.stack.3d.up", action: send).disabled(!enabled)
                }
                .accessibilityAction(named: label) { if enabled { send() } }
                HStack(spacing: 5) {
                    if showsSending { ProgressView().controlSize(.mini) }
                    else { Image(systemName: "arrow.left") }
                    Text(showsSending ? "正在提交…" : row.offerAvailable ? (armed ? "松手\(label)" : state.caption) : "连接后可滑动")
                }
                .font(.caption).foregroundStyle(.secondary)
                if let error = displayedError {
                    Text("\(error) · \(row.offerAvailable ? "滑动重试" : "连接后重试")")
                        .font(.caption).foregroundStyle(.red)
                }
            }
            .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity)
    }

    private func kept<Content: View>(destination: Page, label: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        let card = content()
        let enabled = row.offerAvailable && !row.sending && !row.keepConfirmed
        return SwipeToKeep(
            destination: destination,
            onLand: { onKept(destination) },
            onKeep: { store.keep(row.id) },
            holdRow: holdKeepRow,
            sending: row.sending,
            confirmed: row.keepConfirmed,
            enabled: enabled
        ) { send, _ in
            VStack(spacing: 8) {
                card.contextMenu {
                    Button(label, systemImage: symbol, action: send)
                        .disabled(!enabled)
                }
                .accessibilityAction(named: label) { if enabled { send() } }
                if let error = row.offerError, !row.keepConfirmed {
                    Text("\(error) · \(row.offerAvailable ? "滑动重试" : "连接后重试")")
                        .font(.caption).foregroundStyle(.red)
                } else if destination == .panel {
                    Label(row.offerAvailable ? "滑动加入视图" : "连接后可滑动", systemImage: "arrow.left")
                        .font(.caption).foregroundStyle(.secondary)
                }
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
        TypingBubble(text: row.text)
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
        case .queued, .sending, .delivered:
            let label = row.footer == .queued ? "等待连接后发送" : row.footer == .sending ? "正在发送…" : "已送达"
            Text(label).font(.caption2.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 8)
        case .generating, nil:
            EmptyView()
        case .failed(let requestId):
            failedStatus("未送达", requestId: requestId)
        case .unconfirmed(let requestId):
            failedStatus("发送未确认", requestId: requestId)
        }
    }

    private func failedStatus(_ label: String, requestId: String?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill")
            Text(label)
            if let requestId {
                Button("重试") { store.retry(requestId) }.fontWeight(.semibold)
            }
        }
        .font(.caption)
        .foregroundStyle(.red)
        .padding(.horizontal, 8)
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
