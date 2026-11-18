import Foundation
import Observation
import PiStackKit
import Security

@MainActor @Observable
final class AppModel {
    private static let serverKey = "pistack.server"
    private static let botId = "main"
    private static let defaultName = "lulu"

    private(set) var server: String {
        didSet { UserDefaults.standard.set(server, forKey: Self.serverKey) }
    }
    private(set) var connectionRevision = 0
    var bot: BotSummary?
    var error: String?

    init() {
        server = UserDefaults.standard.string(forKey: Self.serverKey) ?? ""
    }

    var api: Api? { Api.normalize(server).map(Api.init) }

    func chatToken(for server: URL) -> String {
        var query = chatTokenQuery(for: server)
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    func saveConnection(server address: String, token: String) -> Bool {
        guard let url = Api.normalize(address) else { return false }
        if token != chatToken(for: url) {
            let query = chatTokenQuery(for: url)
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
        server = address
        connectionRevision += 1
        return true
    }

    private func chatTokenQuery(for server: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "lulu.chat",
            kSecAttrAccount as String: Api.socketURL(base: server, botId: Self.botId).absoluteString,
        ]
    }

    func resolve() async {
        bot = nil
        error = nil
        guard api != nil else { return }
        bot = BotSummary(id: Self.botId, name: Self.defaultName)
    }
}
