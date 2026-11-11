import Foundation

public struct ChatEntry: Identifiable, Sendable {
    public enum Role: Sendable { case user, assistant }

    public let id: String
    public let position: Double
    public let role: Role
    public let text: String
    public let body: String?
    public let card: SentCard?
    public let time: Date?
    public let final: Bool
}

public struct Live: Sendable {
    public let busy: Bool
}

public let sendTool = "send_to_user"

public enum TimelineItem: Identifiable, Sendable {
    case entry(ChatEntry)
    case prompt(MessageProgress)

    public var id: String {
        switch self {
        case .entry(let entry): entry.id
        case .prompt(let message): message.requestId ?? "prompt-\(message.id)"
        }
    }
}

func messageText(_ model: [JSONValue]?) -> String {
    var parts: [String] = []
    for message in model ?? [] {
        guard let content = message["content"] else { continue }
        if let text = content.string {
            parts.append(text)
        } else if let blocks = content.array {
            for block in blocks where block["type"]?.string == "text" {
                if let text = block["text"]?.string { parts.append(text) }
            }
        }
    }
    return parts.joined().trimmingCharacters(in: .whitespacesAndNewlines)
}

func messageTime(_ model: [JSONValue]?) -> Date? {
    for message in model ?? [] {
        if case .number(let milliseconds)? = message["timestamp"] { return Date(timeIntervalSince1970: milliseconds / 1000) }
    }
    return nil
}

func sentEntries(_ model: [JSONValue]?, position: Double, time: Date?, delivered: Set<String>) -> [ChatEntry] {
    var entries: [ChatEntry] = []
    for message in model ?? [] {
        for block in message["content"]?.array ?? [] where block["type"]?.string == "toolCall" && block["name"]?.string == sendTool {
            guard let id = block["id"]?.string, delivered.contains(id), let input = block["arguments"] else { continue }
            let final = input["end_turn"] == .bool(true)
            if input["type"]?.string == "text", let content = input["content"]?.string, !content.isEmpty {
                let body = input["body"]?.string.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
                entries.append(ChatEntry(id: id, position: position, role: .assistant, text: content, body: body, card: nil, time: time, final: final))
            } else if let card = sentCard(input["widget"]) {
                entries.append(ChatEntry(id: id, position: position, role: .assistant, text: "", body: nil, card: card, time: time, final: final))
            }
        }
    }
    return entries
}

func sentCard(_ widget: JSONValue?) -> SentCard? {
    switch widget?["kind"]?.string {
    case "panel":
        guard let data = try? JSONEncoder().encode(widget?["panel"]), let panel = try? JSONDecoder().decode(PanelWidget.self, from: data) else { return nil }
        return .panel(panel)
    case "asset":
        guard let ref = widget?["ref"]?.string, let title = widget?["title"]?.string else { return nil }
        return .asset(ref: ref, title: title, summary: widget?["summary"]?.string)
    default:
        return nil
    }
}

func deliveredCalls(_ view: ConversationView?) -> Set<String> {
    var delivered = Set<String>()
    for entry in view?.entries ?? [] where entry.kind == "pi.tool-result" {
        for message in entry.model ?? [] where message["role"]?.string == "toolResult" && message["isError"] != .bool(true) {
            if let id = message["toolCallId"]?.string { delivered.insert(id) }
        }
    }
    return delivered
}

public func chatEntries(_ view: ConversationView?, hidden: [String]) -> [ChatEntry] {
    let skipped = Set(hidden)
    let delivered = deliveredCalls(view)
    var result: [ChatEntry] = []
    var turn: [ConversationEntry] = []
    func close(fallback: Bool) {
        let sent = turn.flatMap { sentEntries($0.model, position: Double($0.id) ?? .infinity, time: messageTime($0.model), delivered: delivered) }
        if !sent.isEmpty {
            result += sent
        } else if fallback, let last = turn.last(where: { !messageText($0.model).isEmpty }) {
            result.append(ChatEntry(id: last.id, position: Double(last.id) ?? .infinity, role: .assistant, text: messageText(last.model), body: nil, card: nil, time: messageTime(last.model), final: false))
        }
        turn = []
    }
    for entry in view?.entries ?? [] where !skipped.contains(entry.id) {
        switch entry.kind {
        case "pi.user":
            close(fallback: true)
            let text = messageText(entry.model)
            if !text.isEmpty { result.append(ChatEntry(id: entry.id, position: Double(entry.id) ?? .infinity, role: .user, text: text, body: nil, card: nil, time: messageTime(entry.model), final: false)) }
        case "pi.assistant":
            turn.append(entry)
        default:
            break
        }
    }
    close(fallback: false)
    return result
}

public func timeline(_ entries: [ChatEntry], _ messages: [MessageProgress]) -> [TimelineItem] {
    let placed = Set(messages.compactMap(\.entry))
    var items: [TimelineItem] = []
    var next = 0
    func promptsBefore(_ limit: Double) {
        while next < messages.count, Double(messages[next].after ?? Int.min) < limit {
            items.append(.prompt(messages[next]))
            next += 1
        }
    }
    for entry in entries {
        if entry.role == .user, placed.contains(entry.id) { continue }
        promptsBefore(entry.position)
        items.append(.entry(entry))
    }
    promptsBefore(.infinity)
    return items
}

public func subtasks(of progress: SessionProgress?) -> [SubtaskProgress] {
    var unique: [String: SubtaskProgress] = [:]
    var order: [String] = []
    for message in progress?.messages ?? [] {
        for subtask in message.subtasks {
            if unique[subtask.id] == nil { order.append(subtask.id) }
            unique[subtask.id] = subtask
        }
    }
    return order.compactMap { unique[$0] }
}

public func live(of view: ConversationView?) -> Live {
    Live(busy: view?.docs[liveDoc]?["run"] != nil)
}
