import PiStackKit
import WebKit

extension Notification.Name {
    /// Posted with a widget id when the user asks for a space's card to be refreshed.
    static let spaceRefresh = Notification.Name("spaceRefresh")
}

final class SpaceBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "lulu"

    private static let script = #"""
    (function(){
    var h=window.webkit.messageHandlers.lulu,native=window.fetch.bind(window);
    function enc(b){var a=new Uint8Array(b),s="";for(var i=0;i<a.length;i+=32768)s+=String.fromCharCode.apply(null,a.subarray(i,i+32768));return btoa(s);}
    function dec(t){var s=atob(t),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
    var lulu=window.lulu={fetchedAt:null,
    state:{get:function(){return h.postMessage({op:"get"}).then(function(t){return t==null?null:JSON.parse(t)});},
    set:function(v){return h.postMessage({op:"set",value:JSON.stringify(v)});}},
    refresh:function(){return h.postMessage({op:"refresh"});}};
    window.fetch=function(input,init){
    var req;
    try{req=new Request(input,init);}catch(e){return Promise.reject(e);}
    var u=new URL(req.url);
    if(u.protocol!=="http:"&&u.protocol!=="https:")return native(input,init);
    return req.arrayBuffer().then(function(buf){
    var headers={};req.headers.forEach(function(v,k){headers[k]=v;});
    return h.postMessage({op:"fetch",url:req.url,method:req.method,headers:headers,body:buf.byteLength?enc(buf):null});
    }).then(function(r){
    lulu.fetchedAt=r.at;
    var empty=r.status===204||r.status===205||r.status===304;
    var res=new Response(empty?null:dec(r.body),{status:r.status,statusText:r.text,headers:r.headers});
    try{Object.defineProperty(res,"url",{value:req.url});}catch(e){}
    return res;
    },function(e){throw new TypeError((e&&e.message)||"Network request failed");});
    };
    })();
    """#

    /// What a previewed page saved, held here instead of being written to the saved state.
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

    /// `refresh` is the space's refresh setting when the page is open full screen, nil for a card face.
    init(botId: String, space: String, refresh: SpaceRefresh?, preview: Bool = false, api: Api) {
        self.botId = botId
        self.space = space
        self.preview = preview
        self.api = api
        fetcher = SpaceFetcher(botId: botId, space: space, refresh: refresh)
    }

    func install(in controller: WKUserContentController) {
        controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.name)
        controller.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func attach(_ view: WKWebView, html: String) {
        self.view = view
        self.html = html
    }

    @MainActor
    func refresh() async {
        await fetcher.invalidate()
        view?.loadHTMLString(html, baseURL: nil)
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
            case "fetch":
                guard let address = body["url"] as? String, let url = URL(string: address) else { return (nil, "invalid url") }
                var request = URLRequest(url: url)
                request.httpMethod = (body["method"] as? String)?.uppercased() ?? "GET"
                for (name, value) in body["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
                if let encoded = body["body"] as? String { request.httpBody = Data(base64Encoded: encoded) }
                return (try await fetcher.respond(to: request), nil)
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
