import PiStackKit
import SwiftUI
import WebKit

struct HTMLDocument: View {
    let title: String
    var cached: () async -> String? = { nil }
    let load: () async throws -> String
    var bridge: SpaceBridge?
    var updates: SpaceUpdate?
    var showUpdatesInitially = false
    @State private var showUpdates = false
    @State private var html: String?
    @State private var issue: String?
    @State private var refreshTask: Task<Void, Never>?
    @State private var loadAttempt = 0
    @State private var initialLoading = true

    var body: some View {
        Group {
            if let html {
                HTMLPage(html: html, bridge: bridge, showLoading: refreshTask == nil)
                    .ignoresSafeArea(edges: .bottom)
            } else if let issue {
                ContentUnavailableView {
                    Label("加载失败", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(issue)
                } actions: {
                    Button("重试") { loadAttempt += 1 }
                }
            } else {
                ProgressView()
            }
        }
        .task(id: loadAttempt) {
            issue = nil
            if html == nil {
                let value = await cached()
                guard !Task.isCancelled else { return }
                html = value
            }
            await loadHTML()
            if !Task.isCancelled { initialLoading = false }
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    if html != nil, bridge.preview || updates == nil || updates?.mode.kind == "manual" {
                        if refreshTask != nil {
                            ProgressView().accessibilityLabel("正在刷新")
                        } else {
                            Button("刷新", systemImage: "arrow.clockwise") { refresh(bridge) }
                                .disabled(initialLoading)
                        }
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

    private func loadHTML(refreshing bridge: SpaceBridge? = nil) async {
        do {
            let value = try await load()
            guard !Task.isCancelled else { return }
            if html != value {
                await bridge?.invalidateFetches()
                guard !Task.isCancelled else { return }
                html = value
            }
        } catch {
            guard !Task.isCancelled, html == nil else { return }
            issue = error.localizedDescription
        }
    }

    private func refresh(_ bridge: SpaceBridge) {
        guard refreshTask == nil else { return }
        refreshTask = Task {
            let previous = html
            await loadHTML(refreshing: bridge)
            guard !Task.isCancelled else { return }
            if previous == html { await bridge.refresh() }
            guard !Task.isCancelled else { return }
            refreshTask = nil
        }
    }
}

struct HTMLPage: View {
    let html: String
    let bridge: SpaceBridge?
    var interactive = true
    var showLoading = true

    var body: some View {
        HTMLSurface(html: html, bridge: bridge, interactive: interactive, showLoading: showLoading)
            .id(bridge.map { ObjectIdentifier($0) })
    }
}

private enum HTMLPresentation {
    case loading, ready, failed
}

private enum HTMLPageEvent {
    case finished, navigationFailed, processTerminated
}

private struct HTMLSurface: View {
    let html: String
    let bridge: SpaceBridge?
    let interactive: Bool
    let showLoading: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("pistack.wallpaper") private var theme = WallpaperTheme.sky
    @State private var presentation = HTMLPresentation.loading

    var body: some View {
        WebPage(html: html, bridge: bridge, interactive: interactive, present: present)
        .allowsHitTesting(presentation == .ready)
        .accessibilityHidden(presentation != .ready)
        .overlay {
            if presentation != .ready {
                Color(.systemBackground)
                    .overlay {
                        if interactive {
                            WallpaperMesh(theme: theme)
                                .overlay { Rectangle().fill(.regularMaterial) }
                        }
                    }
                    .overlay {
                        if presentation == .failed {
                            Label("页面无法加载", systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else if showLoading {
                            ProgressView()
                        }
                    }
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
    }

    private func present(_ event: HTMLPageEvent) {
        let next: HTMLPresentation
        switch event {
        case .finished:
            next = .ready
        case .navigationFailed:
            guard presentation != .ready else { return }
            next = .failed
        case .processTerminated:
            next = .failed
        }
        guard presentation != next else { return }
        withAnimation(next == .ready && !reduceMotion ? .easeOut(duration: 0.16) : nil) {
            presentation = next
        }
    }
}

private struct WebPage: UIViewRepresentable {
    let html: String
    let bridge: SpaceBridge?
    let interactive: Bool
    let present: (HTMLPageEvent) -> Void
    @Environment(\.colorScheme) private var scheme

    func makeCoordinator() -> Coordinator { Coordinator(present: present) }

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
        context.coordinator.source = html
        context.coordinator.navigation = view.loadHTMLString(prepared, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.present = present
        let dark = scheme == .dark
        if coordinator.source != html {
            let prepared = HTMLTheme.prepared(html, network: bridge != nil)
            coordinator.source = html
            bridge?.attach(view, html: prepared)
            coordinator.navigation = view.loadHTMLString(prepared, baseURL: nil)
        }
        guard coordinator.dark != dark else { return }
        coordinator.dark = dark
        view.evaluateJavaScript(HTMLTheme.script(dark: dark))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var dark = false
        var source = ""
        var navigation: WKNavigation?
        var present: (HTMLPageEvent) -> Void

        init(present: @escaping (HTMLPageEvent) -> Void) {
            self.present = present
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            self.navigation = navigation
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let navigation, navigation === self.navigation { present(.finished) }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            if let navigation, navigation === self.navigation { present(.navigationFailed) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            if let navigation, navigation === self.navigation { present(.navigationFailed) }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            navigation = nil
            present(.processTerminated)
        }

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
