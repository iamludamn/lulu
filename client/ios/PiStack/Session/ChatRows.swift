import Foundation
import PiStackKit

struct ChatRow: Identifiable, Equatable {
    enum Role { case user, assistant, system, stamp }

    enum Footer: Equatable {
        case read
        case queued, sending, delivered
        case unconfirmed(requestId: String)
        case generating
        case failed(requestId: String?)
    }

    let id: String
    let role: Role
    var text: String
    var body: String?
    var card: SentCard?
    var viewOffer: ViewOfferState?
    var keepConfirmed = false
    var offerError: String?
    var offerAvailable = true
    var footer: Footer?
    var sending = false
    var read = false
    var typing = false
    var notice: String?
    var tail = false

    var isBubble: Bool { role == .user || role == .assistant }
    var widgetSource: Bool { role == .assistant && !typing && card == nil && !text.isEmpty }
}

private let stampGap: TimeInterval = 15 * 60
private let noticeLabel: [String: String] = ["abort": "停止请求", "model": "切换模型", "keep": "收藏", "drop": "移除", "makeWidget": "做成组件", "order": "调整排布", "check": "勾选"]

private func keptOrigins(_ snapshot: BotStore.Snapshot) -> Set<String> {
    var kept = Set(snapshot.panel.widgets.values.compactMap(\.origin) + snapshot.assets.map(\.origin))
    for request in snapshot.requests where request.state == .sending {
        switch request.command.kind {
        case .drop(let origin): kept.remove(origin)
        default: break
        }
    }
    return kept
}

private func awaiting(_ snapshot: BotStore.Snapshot, entries: [ChatEntry]) -> Bool {
    guard snapshot.link == .online else { return false }
    if snapshot.requests.contains(where: { request in
        guard request.state == .acknowledged, case .submit = request.command.kind else { return false }
        return true
    }) { return true }
    let messages = snapshot.progress?.messages ?? []
    let busy = live(of: snapshot.view).busy
    var latestPlaced: Double?
    for message in messages {
        let latest = message.id == messages.last?.id
        guard message.error == nil, message.state != .done || (busy && latest) else { continue }
        guard let placed = message.entry.flatMap({ Double($0) }), !placed.isNaN else { return true }
        latestPlaced = max(latestPlaced ?? placed, placed)
    }
    guard let latestPlaced else { return false }
    let latestFinal = entries.lazy.filter(\.final).map(\.position).filter { !$0.isNaN }.max()
    return latestFinal.map { !($0 > latestPlaced) } ?? true
}

func chatRows(_ snapshot: BotStore.Snapshot, entries: [ChatEntry], keeping: Set<String>) -> [ChatRow] {
    var rows: [ChatRow] = []
    var last: Date?
    let kept = keptOrigins(snapshot)
    let making = Set(snapshot.requests.compactMap { request -> String? in
        guard request.state == .sending, case .makeWidget(let origin) = request.command.kind else { return nil }
        return origin
    })
    var keepRequests: [String: (sending: Bool, error: String?)] = [:]
    for request in snapshot.requests {
        guard case .keep(let origin) = request.command.kind else { continue }
        var status = keepRequests[origin] ?? (sending: false, error: nil)
        if request.state == .sending { status.sending = true }
        if request.state == .failed { status.error = request.error }
        keepRequests[origin] = status
    }
    let cardOrigins = Set(entries.lazy.filter { $0.card != nil }.map(\.id))
    let spaceStates = spaceOfferStates(entries, panel: snapshot.panel)
    let messages = snapshot.progress?.messages ?? []
    let submitted = Set(messages.compactMap(\.requestId))
    func stamp(_ time: Date?, before id: String) {
        guard let time else { return }
        if last == nil || time.timeIntervalSince(last!) > stampGap {
            rows.append(ChatRow(id: "stamp-\(id)", role: .stamp, text: stampText(time)))
        }
        last = time
    }
    for item in timeline(entries, messages) {
        switch item {
        case .entry(let entry):
            let viewOffer = spaceStates[entry.id] ?? scheduleOfferState(entry, panel: snapshot.panel)
            if entry.card != nil && viewOffer == nil && kept.contains(entry.id) && !keeping.contains(entry.id) { continue }
            stamp(entry.time, before: entry.id)
            var row = ChatRow(id: entry.id, role: entry.role == .user ? .user : .assistant, text: entry.text)
            row.body = entry.body
            row.card = entry.card
            row.viewOffer = viewOffer
            if row.card != nil {
                row.keepConfirmed = row.viewOffer == nil && kept.contains(entry.id)
                row.offerAvailable = snapshot.link == .online
                row.sending = keepRequests[entry.id]?.sending ?? false
                row.offerError = keepRequests[entry.id]?.error
            }
            row.read = entry.role == .user
            if making.contains(entry.id) { row.footer = .generating }
            rows.append(row)
        case .prompt(let message):
            stamp(message.at.map { Date(timeIntervalSince1970: $0 / 1000) }, before: item.id)
            var row = ChatRow(id: item.id, role: .user, text: message.text)
            if message.error != nil {
                row.footer = .failed(requestId: nil)
            } else if message.state == .todo {
                row.footer = .delivered
            } else {
                row.read = true
            }
            rows.append(row)
        }
    }
    func appendNotice(_ request: BotStore.Request, _ kind: String) {
        guard request.state == .failed else { return }
        var row = ChatRow(id: request.id, role: .system, text: "\(noticeLabel[kind] ?? "操作")失败：\(request.error ?? "")")
        row.notice = request.id
        rows.append(row)
    }
    for request in snapshot.requests {
        switch request.command.kind {
        case .submit(let text):
            if request.state != .failed && submitted.contains(request.id) { continue }
            stamp(request.at, before: request.id)
            var row = ChatRow(id: request.id, role: .user, text: text)
            switch request.state {
            case .sending: row.footer = snapshot.link == .online ? .sending : .queued
            case .acknowledged: row.footer = .delivered
            case .failed:
                row.footer = request.error == nil ? .unconfirmed(requestId: request.id) : .failed(requestId: request.id)
            }
            rows.append(row)
        case .abort: appendNotice(request, "abort")
        case .selectModel: appendNotice(request, "model")
        case .keep(let origin):
            if !cardOrigins.contains(origin) && !kept.contains(origin) { appendNotice(request, "keep") }
        case .drop: appendNotice(request, "drop")
        case .makeWidget: appendNotice(request, "makeWidget")
        case .order: appendNotice(request, "order")
        case .check: appendNotice(request, "check")
        }
    }
    if let last = rows.lastIndex(where: { $0.role == .user }), rows[last].footer == nil, rows[last].read {
        rows[last].footer = .read
    }
    if awaiting(snapshot, entries: entries) {
        let running = subtasks(of: snapshot.progress).filter(\.running)
        let description = running.first?.description ?? ""
        let text = running.count > 1 ? "\(running.count) 个任务进行中" : description.isEmpty ? "正在准备回复…" : description
        var row = ChatRow(id: "live", role: .assistant, text: text)
        row.typing = true
        rows.append(row)
    }
    for index in rows.indices where rows[index].isBubble {
        let next = index + 1 < rows.count ? rows[index + 1].role : nil
        rows[index].tail = next != rows[index].role
    }
    return rows
}

private func stampText(_ date: Date) -> String {
    let time = date.formatted(date: .omitted, time: .shortened)
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return time }
    if calendar.isDateInYesterday(date) { return "昨天 \(time)" }
    return "\(date.formatted(date: .abbreviated, time: .omitted)) \(time)"
}
