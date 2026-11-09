import Foundation
import PiStackKit

struct ChatRow: Identifiable, Equatable {
    enum Role { case user, assistant, system, stamp }

    enum Footer: Equatable {
        case read
        case generating
        case failed(requestId: String?)
    }

    let id: String
    let role: Role
    var text: String
    var card: SentCard?
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
private let noticeLabel: [String: String] = ["abort": "停止请求", "model": "切换模型", "keep": "收藏", "drop": "移除", "makeWidget": "做成组件", "order": "调整排布"]

func keptOrigins(_ snapshot: BotStore.Snapshot) -> Set<String> {
    var kept = Set(snapshot.panel.widgets.values.compactMap(\.origin) + snapshot.assets.map(\.origin))
    for request in snapshot.requests where request.state == .sending {
        switch request.command.kind {
        case .keep(let origin): kept.insert(origin)
        case .drop(let origin): kept.remove(origin)
        default: break
        }
    }
    return kept
}

private func awaiting(_ snapshot: BotStore.Snapshot, entries: [ChatEntry]) -> Bool {
    let sending = snapshot.requests.contains { request in
        guard snapshot.link == .online, request.state == .sending, case .submit = request.command.kind else { return false }
        return true
    }
    if sending { return true }
    let finals = entries.filter(\.final).map(\.position)
    let messages = snapshot.progress?.messages ?? []
    let busy = live(of: snapshot.view).busy
    return messages.contains { message in
        let latest = message.id == messages.last?.id
        guard message.error == nil, message.state != .done || (busy && latest) else { return false }
        guard let placed = message.entry.flatMap({ Double($0) }) else { return true }
        return !finals.contains { $0 > placed }
    }
}

func chatRows(_ snapshot: BotStore.Snapshot) -> [ChatRow] {
    var rows: [ChatRow] = []
    var last: Date?
    let kept = keptOrigins(snapshot)
    let making = Set(snapshot.requests.compactMap { request -> String? in
        guard request.state == .sending, case .makeWidget(let origin) = request.command.kind else { return nil }
        return origin
    })
    let entries = chatEntries(snapshot.view, hidden: snapshot.progress?.hiddenEntries ?? [])
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
            if entry.card != nil && kept.contains(entry.id) { continue }
            stamp(entry.time, before: entry.id)
            var row = ChatRow(id: entry.id, role: entry.role == .user ? .user : .assistant, text: entry.text)
            row.card = entry.card
            row.read = entry.role == .user
            if making.contains(entry.id) { row.footer = .generating }
            rows.append(row)
        case .prompt(let message):
            stamp(message.at.map { Date(timeIntervalSince1970: $0 / 1000) }, before: item.id)
            var row = ChatRow(id: item.id, role: .user, text: message.text)
            if message.error != nil {
                row.footer = .failed(requestId: nil)
            } else {
                row.read = message.state != .todo
            }
            rows.append(row)
        }
    }
    for request in snapshot.requests {
        switch request.command.kind {
        case .submit(let text):
            if request.state != .failed && submitted.contains(request.id) { continue }
            stamp(request.at, before: request.id)
            var row = ChatRow(id: request.id, role: .user, text: text)
            row.sending = request.state == .sending
            if request.state == .failed { row.footer = .failed(requestId: request.id) }
            rows.append(row)
        case .abort: rows.append(notice(request, "abort"))
        case .selectModel: rows.append(notice(request, "model"))
        case .keep: rows.append(notice(request, "keep"))
        case .drop: rows.append(notice(request, "drop"))
        case .makeWidget: rows.append(notice(request, "makeWidget"))
        case .order: rows.append(notice(request, "order"))
        }
    }
    rows = rows.filter { $0.role != .system || $0.notice != nil }
    if let last = rows.lastIndex(where: { $0.role == .user }), rows[last].footer == nil, rows[last].read {
        rows[last].footer = .read
    }
    if awaiting(snapshot, entries: entries) {
        let text = subtasks(of: snapshot.progress).first(where: \.running)?.description ?? ""
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

private func notice(_ request: BotStore.Request, _ kind: String) -> ChatRow {
    var row = ChatRow(id: request.id, role: .system, text: "\(noticeLabel[kind] ?? "操作")失败：\(request.error ?? "")")
    if request.state == .failed { row.notice = request.id }
    return row
}

private func stampText(_ date: Date) -> String {
    let time = date.formatted(date: .omitted, time: .shortened)
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return time }
    if calendar.isDateInYesterday(date) { return "昨天 \(time)" }
    return "\(date.formatted(date: .abbreviated, time: .omitted)) \(time)"
}
