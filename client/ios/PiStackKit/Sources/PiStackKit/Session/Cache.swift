import Foundation

struct Cache: Codable, Sendable {
    let view: ConversationView
    let progress: SessionProgress

    static func url(for socket: URL) -> URL {
        let name = socket.absoluteString.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
        return URL.cachesDirectory.appending(path: "conversation-\(name).json")
    }

    static func load(_ url: URL) -> Cache? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Cache.self, from: data)
    }

    func write(to url: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }

    var offline: Cache {
        var docs = view.docs
        docs[liveDoc] = nil
        return Cache(view: ConversationView(entries: view.entries, docs: docs), progress: progress)
    }
}
