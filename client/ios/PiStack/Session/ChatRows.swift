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

func chatRows(_ snapshot: BotStore.Snapshot) -> [ChatRow] {
    var rows: [ChatRow] = []
    var last: Date?
    let kept = keptOrigins(snapshot)
    let making = Set(snapshot.requests.compactMap { request -> String? in
        guard request.state == .sending, case .makeWidget(let origin) = request.command.kind else { return nil }
        return origin
    })
    for item in timeline(chatEntries(snapshot.view, hidden: snapshot.progress?.hiddenEntries ?? []), snapshot.progress?.messages ?? []) {
        switch item {
        case .entry(let entry):
            if entry.card != nil && kept.contains(entry.id) { continue }
            if let time = entry.time {
                if last == nil || time.timeIntervalSince(last!) > stampGap {
                    rows.append(ChatRow(id: "stamp-\(entry.id)", role: .stamp, text: stampText(time)))
                }
                last = time
            }
            var row = ChatRow(id: entry.id, role: entry.role == .user ? .user : .assistant, text: entry.text)
            row.card = entry.card
            row.read = entry.role == .user
            if making.contains(entry.id) { row.footer = .generating }
            rows.append(row)
        case .prompt(let message):
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
    let state = live(of: snapshot.view)
    if state.busy {
        var row = ChatRow(id: "live", role: .assistant, text: liveStatus(of: snapshot.view) ?? "")
        row.typing = true
        rows.append(row)
    }
    rows = rows.filter { $0.role != .system || $0.notice != nil }
    if let last = rows.lastIndex(where: { $0.role == .user }), rows[last].footer == nil, rows[last].read {
        rows[last].footer = .read
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
