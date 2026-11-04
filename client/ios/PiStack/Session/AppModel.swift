import Foundation
import Observation
import PiStackKit

@MainActor @Observable
final class AppModel {
    private static let serverKey = "pistack.server"
    private static let botId = "main"
    private static let defaultName = "lulu"
    private static let defaultServer = "https://lulu.jiahaowu0322.workers.dev"

    var server: String {
        didSet { UserDefaults.standard.set(server, forKey: Self.serverKey) }
    }
    var bot: BotSummary?
    var error: String?

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.serverKey) ?? ""
        server = stored.isEmpty ? Self.defaultServer : stored
    }

    var api: Api? { Api.normalize(server).map(Api.init) }

    func resolve() async {
        bot = nil
        error = nil
        guard api != nil else { return }
        bot = BotSummary(id: Self.botId, name: Self.defaultName)
    }
}
