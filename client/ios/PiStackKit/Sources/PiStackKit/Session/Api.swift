import Foundation

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
        failure: String
    ) async throws -> Data {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        } else if let raw {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
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

    public func artifactText(_ id: String, name: String, version: Int?) async throws -> String {
        String(decoding: try await fetch(artifactURL(id, name: name, version: version)), as: UTF8.self)
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
