import PiStackKit
import SwiftUI
import WebKit

struct HTMLDocument: View {
    let title: String
    let load: () async throws -> String
    var bridge: SpaceBridge?

    var body: some View {
        Loaded(load: load) { html in
            HTMLPage(html: html, bridge: bridge)
                .ignoresSafeArea(edges: .bottom)
        }
        .background {
            ZStack {
                Wallpaper()
                Rectangle().fill(.regularMaterial).ignoresSafeArea()
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let bridge {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("刷新", systemImage: "arrow.clockwise") { Task { await bridge.refresh() } }
                }
            }
        }
    }
}

struct HTMLPage: UIViewRepresentable {
    let html: String
    let bridge: SpaceBridge?
    /// false renders the page as a still preview: no scrolling and no touches.
    var interactive = true
    @Environment(\.colorScheme) private var scheme

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let dark = scheme == .dark
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let theme = HTMLTheme.script(dark: dark)
        configuration.userContentController.addUserScript(WKUserScript(source: theme, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.addUserScript(WKUserScript(source: theme, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        bridge?.install(in: configuration.userContentController)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        view.scrollView.isScrollEnabled = interactive
        view.isUserInteractionEnabled = interactive
        context.coordinator.dark = dark
        let prepared = HTMLTheme.prepared(html, network: bridge != nil)
        bridge?.attach(view, html: prepared)
        view.loadHTMLString(prepared, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let dark = scheme == .dark
        guard context.coordinator.dark != dark else { return }
        context.coordinator.dark = dark
        view.evaluateJavaScript(HTMLTheme.script(dark: dark))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var dark = false

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard action.navigationType == .linkActivated, let url = action.request.url, url.scheme != "about" else {
                decisionHandler(.allow)
                return
            }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }
}
