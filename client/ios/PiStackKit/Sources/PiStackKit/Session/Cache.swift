import Foundation

struct Cache: Codable, Sendable {
    let view: ConversationView
    let progress: SessionProgress
    var state: Data? = nil
    // Older caches can contain the server's initial placeholder layout.
    var layoutConfirmed: Bool? = nil

    struct Surfaces: Decodable {
        let panel: PanelState?
        let assets: [AssetItem]?
    }

    static func url(for socket: URL) -> URL {
        let name = socket.absoluteString.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
        return URL.cachesDirectory.appending(path: "conversation-\(name).json")
    }

    static func load(_ url: URL) -> Cache? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Cache.self, from: data)
    }

    func write(to url: URL) {
        var compact = self
        if let state, let frame = try? JSONSerialization.jsonObject(with: state) as? [String: Any] {
            let surfaces = frame.filter { $0.key == "panel" || $0.key == "assets" }
            compact.state = try? JSONSerialization.data(withJSONObject: surfaces)
        }
        guard let data = try? JSONEncoder().encode(compact) else { return }
        try? data.write(to: url, options: .atomic)
    }

    var offline: Cache {
        var docs = view.docs
        docs[liveDoc] = nil
        return Cache(view: ConversationView(entries: view.entries, docs: docs, before: view.before, conversation: view.conversation),
                     progress: progress, state: state, layoutConfirmed: layoutConfirmed)
    }
}
