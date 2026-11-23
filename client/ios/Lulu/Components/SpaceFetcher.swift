import CryptoKit
import Foundation
import LuluKit

/// Answers the network requests a space page makes. Every GET is cached per space; the refresh setting decides
/// whether a request reaches the network or is answered from the cache. `refresh` nil is a card face, which never
/// refreshes and only fills a cache that is empty.
actor SpaceFetcher {
    private struct Entry: Codable {
        let status: Int
        let headers: [String: String]
        let body: Data
        let at: Double
    }

    private static let entryLimit = 2 << 20
    private static let spaceLimit = 16 << 20
    private static let dropped: Set<String> = ["content-encoding", "content-length", "transfer-encoding"]

    private let directory: URL
    private let dayKey: String
    private let daily: Bool
    private var generation = 0
    private var stale: Bool
    private var fresh: Set<String> = []

    init(botId: String, space: String, refresh: SpaceRefresh?) {
        directory = URL.cachesDirectory.appending(path: "spaces/\(botId)/\(space)", directoryHint: .isDirectory)
        dayKey = "space.refreshed.\(botId).\(space)"
        daily = refresh == .daily
        switch refresh {
        case .open: stale = true
        case .daily: stale = !((UserDefaults.standard.object(forKey: "space.refreshed.\(botId).\(space)") as? Date).map(Calendar.current.isDateInToday) ?? false)
        case .manual, nil: stale = false
        }
    }

    func invalidate() {
        generation += 1
        stale = true
        fresh.removeAll()
    }

    func respond(to request: URLRequest) async throws -> [String: Any] {
        guard let url = request.url else { throw URLError(.badURL) }
        let cacheable = request.httpMethod == "GET"
        let key = Self.key(url)
        let cached = cacheable ? read(key) : nil
        if let cached, !stale || fresh.contains(key) { return Self.reply(cached) }
        let generation = self.generation
        var request = request
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            let entry = Entry(status: http.statusCode, headers: Self.headers(http), body: data, at: Date().timeIntervalSince1970 * 1000)
            if cacheable {
                guard (200..<300).contains(http.statusCode) else {
                    if let cached { return Self.reply(cached) }
                    return Self.reply(entry)
                }
                if self.generation == generation {
                    if write(entry, key: key) { fresh.insert(key) }
                    if daily { UserDefaults.standard.set(Date(), forKey: dayKey) }
                }
            }
            return Self.reply(entry)
        } catch {
            if let cached { return Self.reply(cached) }
            throw error
        }
    }

    private static func key(_ url: URL) -> String {
        SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func headers(_ response: HTTPURLResponse) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            guard let name = name as? String, let value = value as? String, !dropped.contains(name.lowercased()) else { continue }
            result[name] = value
        }
        return result
    }

    private static func reply(_ entry: Entry) -> [String: Any] {
        [
            "status": entry.status,
            "text": HTTPURLResponse.localizedString(forStatusCode: entry.status),
            "headers": entry.headers,
            "body": entry.body.base64EncodedString(),
            "at": entry.at,
        ]
    }

    private func read(_ key: String) -> Entry? {
        (try? Data(contentsOf: directory.appending(path: key))).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) }
    }

    private func write(_ entry: Entry, key: String) -> Bool {
        let file = directory.appending(path: key)
        guard entry.body.count <= Self.entryLimit else {
            try? FileManager.default.removeItem(at: file)
            return false
        }
        guard let data = try? JSONEncoder().encode(entry) else { return false }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard (try? data.write(to: file, options: .atomic)) != nil else { return false }
        prune()
        return true
    }

    private func prune() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let files = ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []).compactMap { file -> (URL, Int, Date)? in
            guard let values = try? file.resourceValues(forKeys: Set(keys)), let size = values.fileSize, let date = values.contentModificationDate else { return nil }
            return (file, size, date)
        }
        var total = files.reduce(0) { $0 + $1.1 }
        for (file, size, _) in files.sorted(by: { $0.2 < $1.2 }) where total > Self.spaceLimit {
            try? FileManager.default.removeItem(at: file)
            total -= size
        }
    }
}
