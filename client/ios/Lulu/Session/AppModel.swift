import Foundation
import Observation
import LuluKit
import Security

@MainActor @Observable
final class AppModel {
    private nonisolated static let botId = "main"
    private static let defaultName = "lulu"

    private(set) var server: String {
        didSet { UserDefaults.standard.set(server, forKey: AppPreferences.server) }
    }
    struct Connection {
        let api: Api
        let bot: BotSummary
        let store: BotStore
    }

    private(set) var connectionRevision = 0
    private(set) var connection: Connection?

    init() {
        let defaults = UserDefaults.standard
        if let domain = Bundle.main.bundleIdentifier {
            AppPreferences.migrateLegacyKeys(in: defaults, domain: domain)
        }
        server = defaults.string(forKey: AppPreferences.server) ?? ""
    }

    var api: Api? { Api.normalize(server).map(Api.init) }

    func chatToken(for server: URL) -> String {
        Self.readChatToken(for: server)
    }

    private nonisolated static func readChatToken(for server: URL) -> String {
        var query = chatTokenQuery(for: server)
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    func saveConnection(server address: String, token: String) -> Bool {
        guard let url = Api.normalize(address) else { return false }
        if token != chatToken(for: url) {
            let query = Self.chatTokenQuery(for: url)
            let status: OSStatus
            if token.isEmpty {
                status = SecItemDelete(query as CFDictionary)
            } else {
                let attributes = [kSecValueData as String: Data(token.utf8)]
                let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
                status = updated == errSecItemNotFound
                    ? SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
                    : updated
            }
            guard status == errSecSuccess || (token.isEmpty && status == errSecItemNotFound) else { return false }
        }
        connection = nil
        server = address
        connectionRevision += 1
        return true
    }

    private nonisolated static func chatTokenQuery(for server: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "lulu.chat",
            kSecAttrAccount as String: Api.socketURL(base: server, botId: Self.botId).absoluteString,
        ]
    }

    func resolve() async {
        guard connection == nil, let api else { return }
        let revision = connectionRevision
        let server = api.base
        let token = await Task.detached(priority: .userInitiated) { Self.readChatToken(for: server) }.value
        guard !Task.isCancelled, revision == connectionRevision, connection == nil else { return }
        let bot = BotSummary(id: Self.botId, name: Self.defaultName)
        connection = Connection(api: api, bot: bot, store: BotStore(botId: bot.id, server: server, token: token))
    }
}
