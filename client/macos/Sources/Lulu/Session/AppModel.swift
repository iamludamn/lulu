import Foundation
import Observation
import PiStackKit

enum Page: Int, CaseIterable, Identifiable {
    case panel, chat, assets

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .panel: "视图"
        case .chat: "对话"
        case .assets: "资产"
        }
    }
}

@MainActor @Observable
final class AppModel {
    private static let serverKey = "server"
    static let botId = "main"
    static let botName = "lulu"
    static let defaultServer = "https://lulu.jiahaowu0322.workers.dev"

    var server: String {
        didSet { Keychain.write(Self.serverKey, server) }
    }
    var page = Page.chat
    var settings = false
    var stopping = 0

    init() {
        let stored = ProcessInfo.processInfo.environment["LULU_SERVER"] ?? Keychain.read(Self.serverKey) ?? ""
        server = stored.isEmpty ? Self.defaultServer : stored
    }

    var api: Api? { Api.normalize(server).map(Api.init) }
    var bot: BotSummary { BotSummary(id: Self.botId, name: Self.botName) }
}
