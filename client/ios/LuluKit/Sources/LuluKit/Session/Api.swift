import Foundation
import CryptoKit

public enum ApiError: LocalizedError {
    case message(String)

    public var errorDescription: String? {
        switch self {
        case .message(let text): text
        }
    }
}

public struct BotSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct Api: Sendable {
    public let base: URL

    public init(base: URL) {
        self.base = base
    }

    public static func normalize(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let url = URL(string: trimmed.contains("://") ? trimmed : "https://\(trimmed)")
        return url?.host == nil ? nil : url
    }

    public static func socketURL(base: URL, botId: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/api/bots/\(botId)/ws"
        return components.url!
    }

    private func call(
        _ path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: Encodable? = nil,
        data raw: Data? = nil,
        contentType: String = "application/json",
        token: String = "",
        failure: String
    ) async throws -> Data {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if base.scheme == "https", !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        } else if let raw {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = raw
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ApiError.message("\(failure)（\(status)）") }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    public func memory(_ id: String) async throws -> MemoryListing {
        try decode(MemoryListing.self, try await call("/api/bots/\(id)/memory", failure: "加载记忆失败"))
    }

    struct Startup: Decodable {
        let panel: PanelState
        let assets: [AssetItem]
    }

    func startup(_ id: String, token: String) async throws -> Startup {
        try decode(Startup.self, try await call("/api/bots/\(id)/startup", token: token, failure: "加载视图失败"))
    }

    public func notes(_ bot: String, token: String) async throws -> NoteGallery {
        var cursor: NoteGallery.Cursor?
        var notes: [NoteRevision] = []
        var pinned: [String]?
        repeat {
            let query = cursor.map { [
                URLQueryItem(name: "updatedAt", value: String($0.updatedAt)),
                URLQueryItem(name: "id", value: $0.id.uuidString)
            ] } ?? []
            let page = try decode(NoteGallery.self, try await call("/api/bots/\(bot)/notes", query: query, token: token, failure: "加载笔记失败"))
            notes.append(contentsOf: page.notes)
            pinned = pinned ?? page.pinned
            cursor = page.next
        } while cursor != nil
        return NoteGallery(next: nil, notes: notes, pinned: pinned ?? [])
    }

    public func saveNote(_ bot: String, mutation: NoteMutation, token: String) async throws -> NoteRevision {
        try decode(NoteRevision.self, try await call("/api/bots/\(bot)/notes", method: "PUT", body: mutation, token: token, failure: "同步笔记失败"))
    }

    public func uploadNoteAttachment(_ bot: String, filename: String, data: Data, token: String) async throws -> String {
        struct Attachment: Decodable { let ref: String }
        let query = [URLQueryItem(name: "name", value: filename), URLQueryItem(name: "id", value: UUID().uuidString)]
        return try decode(Attachment.self, try await call("/api/bots/\(bot)/notes/attachment", method: "PUT",
            query: query, data: data, contentType: "application/octet-stream", token: token, failure: "上传附件失败")).ref
    }

    public func askNote(_ bot: String, note: NotePayload, question: String, previous: NoteExchange?, token: String) async throws -> NoteAnswer {
        struct Question: Encodable {
            let note: NotePayload
            let question: String
            let previous: NoteExchange?
        }
        return try decode(NoteAnswer.self, try await call("/api/bots/\(bot)/notes/ask", method: "POST",
            body: Question(note: note, question: question, previous: previous), token: token, failure: "笔记提问失败，请重试"))
    }

    public func pinNoteCard(_ bot: String, key: String, pinned: Bool, token: String) async throws {
        struct Pin: Encodable { let key: String; let pinned: Bool }
        _ = try await call("/api/bots/\(bot)/notes/pin", method: "PUT", body: Pin(key: key, pinned: pinned), token: token, failure: "同步置顶失败")
    }

    public func memoryFile(_ id: String, path: String) async throws -> String {
        let data = try await call("/api/bots/\(id)/memory/file", query: [URLQueryItem(name: "path", value: path)], failure: "加载文件失败")
        return String(decoding: data, as: UTF8.self)
    }

    public func artifactURL(_ id: String, _ address: ArtifactAddress) -> URL {
        artifactURL(id, name: address.name, version: address.version)
    }

    public func artifactURL(_ id: String, name: String, version: Int?) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/api/bots/\(id)/artifacts/file"
        components.queryItems = [URLQueryItem(name: "name", value: name)] + (version.map { [URLQueryItem(name: "version", value: String($0))] } ?? [])
        return components.url!
    }

    private func artifactCache(_ url: URL) -> URL {
        let key = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.cachesDirectory.appending(path: "artifact-\(key)")
    }

    public func cachedArtifactText(_ id: String, name: String, version: Int?) -> String? {
        let url = artifactCache(artifactURL(id, name: name, version: version))
        return (try? Data(contentsOf: url)).map { String(decoding: $0, as: UTF8.self) }
    }

    public func artifactText(_ id: String, name: String, version: Int?) async throws -> String {
        let url = artifactURL(id, name: name, version: version)
        let data = try await fetch(url)
        try? data.write(to: artifactCache(url), options: .atomic)
        return String(decoding: data, as: UTF8.self)
    }

    private func fetch(_ url: URL) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ApiError.message("下载失败（\(status)）") }
        return data
    }

    public func download(_ url: URL, as name: String) async throws -> URL {
        let data = try await fetch(url)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent((name as NSString).lastPathComponent)
        try data.write(to: file)
        return file
    }

    public func spaceState(_ botId: String, space: String) async throws -> String? {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/api/bots/\(botId)/spaces/state"
        components.queryItems = [URLQueryItem(name: "id", value: space)]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200..<300: return String(decoding: data, as: UTF8.self)
        case 404: return nil
        case let status: throw ApiError.message("读取状态失败（\(status)）")
        }
    }

    public func setSpaceState(_ botId: String, space: String, json: String) async throws {
        _ = try await call("/api/bots/\(botId)/spaces/state", method: "PUT", query: [URLQueryItem(name: "id", value: space)], data: Data(json.utf8), failure: "保存状态失败")
    }

    private func spaceDataCache(_ botId: String, space: String) -> URL {
        let key = SHA256.hash(data: Data("\(base.absoluteString)/\(botId)/\(space)".utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.cachesDirectory.appending(path: "space-data-\(key)")
    }

    public func spaceContent(_ botId: String, space: String) async throws -> Data {
        let cache = spaceDataCache(botId, space: space)
        let data: Data
        do {
            data = try await call("/api/bots/\(botId)/spaces/refresh", query: [URLQueryItem(name: "id", value: space)], failure: "加载更新失败")
        } catch let error as URLError {
            if let saved = try? Data(contentsOf: cache) { return saved }
            throw error
        }
        try? data.write(to: cache, options: .atomic)
        return data
    }

    public func spaceDevice(_ botId: String, token: String, enabled: Bool) async throws {
        _ = try await call("/api/bots/\(botId)/spaces/device", method: "POST",
                           body: ["token": token, "action": enabled ? "register" : "remove"], failure: "无法注册更新通知")
    }

    public func spaceAction(_ botId: String, space: String, action: String, mode: SpaceUpdate.Mode? = nil, notify: Bool? = nil, version: Int? = nil) async throws {
        struct Action: Encodable {
            let action: String
            let mode: SpaceUpdate.Mode?
            let notify: Bool?
            let version: Int?
        }
        _ = try await call("/api/bots/\(botId)/spaces/refresh", method: "POST",
                           query: [URLQueryItem(name: "id", value: space)],
                           body: Action(action: action, mode: mode, notify: notify, version: version), failure: "无法保存更新设置")
    }

    public func schedules(_ id: String) async throws -> [ScheduleEntry] {
        try decode([ScheduleEntry].self, try await call("/api/bots/\(id)/schedules", failure: "加载定时任务失败"))
    }

}

private struct AnyEncodable: Encodable {
    let value: Encodable

    init(_ value: Encodable) {
        self.value = value
    }

    func encode(to encoder: Encoder) throws {
        try value.encode(to: encoder)
    }
}
