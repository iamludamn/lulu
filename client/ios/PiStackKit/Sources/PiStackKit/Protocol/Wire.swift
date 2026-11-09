import Foundation

public struct ConversationEntry: Codable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let model: [JSONValue]?

    private enum Keys: String, CodingKey { case id, kind, model }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if let text = try? container.decode(String.self, forKey: .id) {
            id = text
        } else {
            id = String(try container.decode(Int.self, forKey: .id))
        }
        kind = try container.decode(String.self, forKey: .kind)
        model = try container.decodeIfPresent([JSONValue].self, forKey: .model)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(model, forKey: .model)
    }
}

public struct ConversationView: Codable, Sendable {
    public let entries: [ConversationEntry]
    public let docs: [String: JSONValue]
}

public struct ViewFrame: Decodable, Sendable {
    let entries: [ConversationEntry]
    let order: [String]
    let docs: [String: JSONValue]

    func applied(to view: ConversationView?) -> ConversationView? {
        var known = Dictionary(uniqueKeysWithValues: (view?.entries ?? []).map { ($0.id, $0) })
        for entry in entries { known[entry.id] = entry }
        let merged = order.compactMap { known[$0] }
        guard merged.count == order.count else { return nil }
        return ConversationView(entries: merged, docs: docs)
    }
}

public enum ServerMessage: Decodable, Sendable {
    case state(view: ViewFrame, progress: SessionProgress, mcp: [McpStatus], panel: PanelState, assets: [AssetItem])
    case models(ModelConfig)
    case voice
    case result(requestId: String, error: String?)

    private enum Keys: String, CodingKey { case type, view, progress, mcp, panel, assets, config, requestId, ok, error }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "state":
            self = .state(
                view: try container.decode(ViewFrame.self, forKey: .view),
                progress: try container.decode(SessionProgress.self, forKey: .progress),
                mcp: try container.decode([McpStatus].self, forKey: .mcp),
                panel: (try? container.decodeIfPresent(PanelState.self, forKey: .panel)) ?? PanelState(),
                assets: (try? container.decodeIfPresent([AssetItem].self, forKey: .assets)) ?? []
            )
        case "models": self = .models(try container.decode(ModelConfig.self, forKey: .config))
        case "result":
            let ok = try container.decode(Bool.self, forKey: .ok)
            self = .result(requestId: try container.decode(String.self, forKey: .requestId), error: ok ? nil : (try container.decodeIfPresent(String.self, forKey: .error) ?? "Command failed"))
        default: self = .voice
        }
    }
}

public struct Command: Sendable {
    public enum Kind: Sendable {
        case submit(String)
        case abort
        case selectModel(ModelRef)
        case keep(origin: String)
        case drop(origin: String)
        case makeWidget(origin: String)
        case order([String])
        case check(id: String, index: Int, done: Bool)
    }

    public let requestId: String
    public let kind: Kind

    public init(_ kind: Kind) {
        requestId = newId()
        self.kind = kind
    }

    var frame: [String: Any] {
        switch kind {
        case .submit(let content): ["type": "prompt.submit", "requestId": requestId, "content": content, "whenBusy": "followUp"]
        case .abort: ["type": "prompt.abort", "requestId": requestId]
        case .selectModel(let model): ["type": "model.select", "requestId": requestId, "model": ["provider": model.provider, "id": model.id]]
        case .keep(let origin): ["type": "widget.keep", "requestId": requestId, "origin": origin]
        case .drop(let origin): ["type": "widget.drop", "requestId": requestId, "origin": origin]
        case .makeWidget(let origin): ["type": "widget.make", "requestId": requestId, "origin": origin]
        case .order(let ids): ["type": "layout.order", "requestId": requestId, "target": "assets", "ids": ids]
        case .check(let id, let index, let done): ["type": "widget.check", "requestId": requestId, "id": id, "index": index, "done": done]
        }
    }
}

public let maxClientFrameCharacters = 64_000

func newId() -> String {
    UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
}
