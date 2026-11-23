import CryptoKit
import LuluKit
import WebKit

extension Notification.Name {
    static let spaceRefresh = Notification.Name("spaceRefresh")
}

final class SpaceBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "lulu"

    private static let script = #"""
    (function(){
    var h=window.webkit.messageHandlers.lulu,native=window.fetch.bind(window);
    var refreshRequests = null;
    function post(message) {
    var pending = h.postMessage(message);
    if (refreshRequests) refreshRequests.push(pending);
    return pending;
    }
    function dec(t){var s=atob(t),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
    var lulu=window.lulu={fetchedAt:null,
    state:{get:function(){return h.postMessage({op:"get"}).then(function(t){return t==null?null:JSON.parse(t)});},
    set:function(v){return h.postMessage({op:"set",value:JSON.stringify(v)});}},
    data:{get:function(){return post({op:"data"}).then(function(t){return JSON.parse(t);});},
    presented:function(v){return h.postMessage({op:"seen",value:v});}},
    refresh:function(){return h.postMessage({op:"refresh"});},
    _refreshData:async function(){
    var pending = refreshRequests = [];
    try {
    window.dispatchEvent(new Event("luludatachange"));
    for (var i = 0; i < pending.length; i++) {
    try { await pending[i]; } catch (_) {}
    }
    return pending.length > 0;
    } finally { refreshRequests = null; }
    }};
    window.fetch=function(input,init){
    var req;
    try{req=new Request(input,init);}catch(e){return Promise.reject(e);}
    var u=new URL(req.url);
    if(u.protocol!=="http:"&&u.protocol!=="https:")return native(input,init);
    var headers={};req.headers.forEach(function(v,k){headers[k]=v;});
    return post({op:"fetch",url:req.url,method:req.method,headers:headers}).then(function(r){
    lulu.fetchedAt=r.at;
    var empty=r.status===204||r.status===205||r.status===304;
    var res=new Response(empty?null:dec(r.body),{status:r.status,statusText:r.text,headers:r.headers});
    try{Object.defineProperty(res,"url",{value:req.url});}catch(e){}
    return res;
    },function(e){throw new TypeError((e&&e.message)||"Network request failed");});
    };
    })();
    """#

    private final class Draft: @unchecked Sendable {
        var value: String?
    }

    let botId: String
    let space: String
    let preview: Bool
    let api: Api
    private let draft = Draft()
    private let fetcher: SpaceFetcher
    private weak var view: WKWebView?
    private var html = ""
    @MainActor private var managedDigest: SHA256.Digest?
    @MainActor private var requests: [URLRequest: Data] = [:]
    @MainActor private var document = UUID()
    @MainActor private var refreshing = false
    @MainActor private var providedVersion = 0
    @MainActor private var scheduledURL: String?

    @MainActor
    func invalidateManagedData(_ status: SpaceUpdate?) {
        scheduledURL = status?.mode.kind == "scheduled" ? status?.mode.url : nil
        guard !preview, status != nil else { return }
        view?.evaluateJavaScript("window.dispatchEvent(new Event('luludatachange'))")
    }

    @MainActor
    private func managed() async throws -> [String: Any] {
        let raw = try await api.spaceContent(botId, space: space)
        let body = try JSONSerialization.jsonObject(with: raw) as? [String: Any] ?? [:]
        let data = body["data"] as? [String: Any]
        providedVersion = max(providedVersion, data?["version"] as? Int ?? 0)
        return body
    }

    @MainActor
    private func seen(_ version: Int) async throws {
        guard !preview, version > 0, version <= providedVersion else { return }
        try await api.spaceAction(botId, space: space, action: "seen", version: version)
    }

    @MainActor
    private func managedResponse(_ url: URL) async throws -> [String: Any]? {
        guard !preview, scheduledURL == url.absoluteString else { return nil }
        let body = try await managed()
        let status = body["status"] as? [String: Any]
        let mode = status?["mode"] as? [String: Any]
        guard mode?["kind"] as? String == "scheduled", mode?["url"] as? String == url.absoluteString else { return nil }
        guard let data = body["data"] as? [String: Any], let value = data["value"] else {
            throw ApiError.message("等待首次定时更新")
        }
        let encoded = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        return ["status": 200, "text": "OK", "headers": ["Content-Type": "application/json"], "body": encoded.base64EncodedString(), "at": data["updatedAt"] ?? NSNull()]
    }

    @MainActor
    init(botId: String, space: String, refresh: SpaceRefresh?, preview: Bool = false, api: Api, updates: SpaceUpdate? = nil) {
        self.botId = botId
        self.space = space
        self.preview = preview
        self.api = api
        scheduledURL = updates?.mode.kind == "scheduled" ? updates?.mode.url : nil
        fetcher = SpaceFetcher(botId: botId, space: space, refresh: updates == nil ? refresh : .manual)
    }

    func install(in controller: WKUserContentController) {
        controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.name)
        controller.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    @MainActor
    func attach(_ view: WKWebView, html: String) {
        self.view = view
        self.html = html
        document = UUID()
        requests.removeAll()
        managedDigest = nil
    }

    @MainActor
    func invalidateFetches() async { await fetcher.invalidate() }

    @MainActor
    func refresh() async {
        guard !refreshing, let view else { return }
        refreshing = true
        defer { refreshing = false }
        let document = self.document
        let previous = requests
        let previousData = managedDigest
        await fetcher.invalidate()
        guard !Task.isCancelled, self.document == document else { return }
        let handled = (try? await view.callAsyncJavaScript("return await window.lulu._refreshData()", arguments: [:], in: nil, contentWorld: .page)) as? Bool
        guard handled != true else { return }

        var changed = false
        if let previousData, !Task.isCancelled, self.document == document,
           let data = try? await managedValue(), SHA256.hash(data: data) != previousData {
            changed = true
        }
        for (request, old) in previous {
            guard !Task.isCancelled, self.document == document else { return }
            if let response = try? await fetch(request),
               let next = fingerprint(response), next != old {
                changed = true
            }
        }
        guard changed, !Task.isCancelled, self.document == document else { return }
        attach(view, html: html)
        view.loadHTMLString(html, baseURL: nil)
    }

    @MainActor
    private func managedValue() async throws -> Data {
        let body = try await managed()
        return try JSONSerialization.data(withJSONObject: body["data"] ?? NSNull(), options: [.fragmentsAllowed, .sortedKeys])
    }

    @MainActor
    private func fetch(_ request: URLRequest) async throws -> [String: Any] {
        if let url = request.url, let snapshot = try await managedResponse(url) { return snapshot }
        return try await fetcher.respond(to: request)
    }

    private func fingerprint(_ response: [String: Any]) -> Data? {
        guard let status = response["status"] as? Int, let body = response["body"] as? String else { return nil }
        var digest = SHA256()
        digest.update(data: Data("\(status):".utf8))
        digest.update(data: Data(body.utf8))
        return Data(digest.finalize())
    }

    @MainActor
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
            case "data":
                if preview { return ("null", nil) }
                let document = self.document
                let bytes = try await managedValue()
                if self.document == document { managedDigest = SHA256.hash(data: bytes) }
                return (String(decoding: bytes, as: UTF8.self), nil)
            case "seen":
                if let version = body["value"] as? Int { try await seen(version) }
                return (nil, nil)
            case "fetch":
                guard let address = body["url"] as? String, let url = URL(string: address) else { return (nil, "invalid url") }
                guard url.scheme == "https", url.host() != api.base.host(),
                      (body["method"] as? String)?.uppercased() == "GET" else {
                    return (nil, "Space data requests require a public HTTPS GET")
                }
                var request = URLRequest(url: url)
                for (name, value) in body["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
                let document = self.document
                do {
                    let response = try await fetch(request)
                    if self.document == document { requests[request] = fingerprint(response) }
                    return (response, nil)
                } catch {
                    if self.document == document, requests[request] == nil { requests[request] = Data() }
                    throw error
                }
            case "refresh":
                await refresh()
                return (nil, nil)
            default:
                return (nil, "unknown op")
            }
        } catch {
            return (nil, error.localizedDescription)
        }
    }
}
