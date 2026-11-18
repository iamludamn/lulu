import PiStackKit
import SwiftUI
import WebKit

struct HTMLDocument: View {
    let title: String
    var cached: () -> String? = { nil }
    let load: () async throws -> String
    var bridge: SpaceBridge?
    var updates: SpaceUpdate?
    var showUpdatesInitially = false
    @State private var showUpdates = false

    var body: some View {
        Loaded(cached: cached, load: load) { html in
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
        .safeAreaInset(edge: .top, spacing: 0) {
            if bridge?.preview == false, updates?.hasNewContent == true {
                Button { showUpdates = true } label: {
                    Label("有新内容", systemImage: "circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(8)
                        .background(.thinMaterial)
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showUpdates) {
            if let bridge { SpaceUpdatesView(bridge: bridge, status: updates) }
        }
        .task(id: showUpdatesInitially) {
            if showUpdatesInitially { showUpdates = true }
        }
        .onChange(of: updates, initial: true) { previous, current in
            if previous?.updatedAt != current?.updatedAt || previous?.version != current?.version ||
                previous?.mode != current?.mode {
                bridge?.invalidateManagedData(current)
            }
        }
        .toolbar {
            if let bridge {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if bridge.preview || updates == nil || updates?.mode.kind == "manual" {
                        Button("刷新", systemImage: "arrow.clockwise") { Task { await bridge.refresh() } }
                    }
                    if !bridge.preview {
                        Button(updates?.hasNewContent == true ? "有新内容" : "更新", systemImage: updates?.hasNewContent == true ? "bell.badge" : "clock") {
                            showUpdates = true
                        }
                    }
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
        context.coordinator.html = prepared
        view.loadHTMLString(prepared, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let dark = scheme == .dark
        let prepared = HTMLTheme.prepared(html, network: bridge != nil)
        if context.coordinator.html != prepared {
            context.coordinator.html = prepared
            bridge?.attach(view, html: prepared)
            view.loadHTMLString(prepared, baseURL: nil)
        }
        guard context.coordinator.dark != dark else { return }
        context.coordinator.dark = dark
        view.evaluateJavaScript(HTMLTheme.script(dark: dark))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var dark = false
        var html = ""

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme != "about", action.targetFrame?.isMainFrame != false else {
                decisionHandler(.allow)
                return
            }
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
}
