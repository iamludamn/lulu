import PiStackKit
import WebKit

final class SpaceBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "state"

    private static let script = """
    (function(){var h=window.webkit.messageHandlers.state;window.lulu={state:{\
    get:function(){return h.postMessage({op:"get"}).then(function(t){return t==null?null:JSON.parse(t)})},\
    set:function(v){return h.postMessage({op:"set",value:JSON.stringify(v)})}}};})();
    """

    /// What a previewed page saved, held here instead of being written to the saved state.
    private final class Draft: @unchecked Sendable {
        var value: String?
    }

    let botId: String
    let space: String
    let preview: Bool
    let api: Api
    private let draft = Draft()

    init(botId: String, space: String, preview: Bool = false, api: Api) {
        self.botId = botId
        self.space = space
        self.preview = preview
        self.api = api
    }

    func install(in controller: WKUserContentController) {
        controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.name)
        controller.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return (nil, "bad message") }
        do {
            switch body["op"] as? String {
            case "get":
                if preview, let value = draft.value { return (value, nil) }
                return (try await api.spaceState(botId, space: space), nil)
            case "set":
                guard let value = body["value"] as? String else { return (nil, "state must be JSON-serializable") }
                if preview {
                    draft.value = value
                    return (nil, nil)
                }
                try await api.setSpaceState(botId, space: space, json: value)
                return (nil, nil)
            default:
                return (nil, "unknown op")
            }
        } catch {
            return (nil, error.localizedDescription)
        }
    }
}
