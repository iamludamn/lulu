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
    public var noteProposal: NoteProposal? = nil
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

func sentEntries(_ model: [JSONValue]?, position: Double, time: Date?, delivered: [String: JSONValue]) -> [ChatEntry] {
    var entries: [ChatEntry] = []
    for message in model ?? [] {
        for block in message["content"]?.array ?? [] where block["type"]?.string == "toolCall" && block["name"]?.string == sendTool {
            guard let id = block["id"]?.string, let result = delivered[id], let input = block["arguments"] else { continue }
            let final = input["end_turn"] == .bool(true)
            if input["type"]?.string == "text", let content = input["content"]?.string, !content.isEmpty {
                let body = input["body"]?.string.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
                entries.append(ChatEntry(id: id, position: position, role: .assistant, text: content, body: body, card: nil, time: time, final: final))
            } else if input["type"]?.string == "widget", let card = sentCard(result["details"]?["widget"] ?? input["widget"]) {
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

func deliveredCalls(_ view: ConversationView?) -> [String: JSONValue] {
    var delivered: [String: JSONValue] = [:]
    for entry in view?.entries ?? [] where entry.kind == "pi.tool-result" {
        for message in entry.model ?? [] where message["role"]?.string == "toolResult" && message["toolName"]?.string == sendTool {
            if let id = message["toolCallId"]?.string {
                delivered[id] = message["isError"] == .bool(true) ? nil : message
            }
        }
    }
    return delivered
}

public func chatEntries(_ view: ConversationView?, hidden: [String]) -> [ChatEntry] {
    let skipped = Set(hidden)
    let delivered = deliveredCalls(view)
    return (view?.entries ?? []).flatMap { entry -> [ChatEntry] in
        guard !skipped.contains(entry.id) else { return [] }
        let position = Double(entry.id) ?? .infinity
        switch entry.kind {
        case "pi.user":
            let text = messageText(entry.model)
            guard !text.isEmpty else { return [] }
            return [ChatEntry(id: entry.id, position: position, role: .user, text: text, body: nil, card: nil, time: messageTime(entry.model), final: false)]
        case "pi.assistant":
            return sentEntries(entry.model, position: position, time: messageTime(entry.model), delivered: delivered)
        case "lulu.note.proposal":
            guard let proposal = entry.noteData(NoteProposal.self) else { return [] }
            return [ChatEntry(id: proposal.id.uuidString.lowercased(), position: position, role: .assistant, text: "", body: nil,
                              card: nil, time: Date(timeIntervalSince1970: proposal.at / 1000), final: false, noteProposal: proposal)]
        case "lulu.note.failed":
            return [ChatEntry(id: entry.id, position: position, role: .assistant, text: "笔记生成失败，请从原消息重试。", body: nil, card: nil, time: nil, final: false)]
        case scheduleOfferKind:
            guard case .panel(let widget)? = sentCard(entry.data?["widget"]), case .schedules = widget.body else { return [] }
            let time: Date?
            if case .number(let milliseconds)? = entry.data?["at"] { time = Date(timeIntervalSince1970: milliseconds / 1000) }
            else { time = nil }
            return [ChatEntry(id: scheduleOriginPrefix + entry.id, position: position, role: .assistant, text: "", body: nil, card: .panel(widget), time: time, final: false)]
        default:
            return []
        }
    }
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
