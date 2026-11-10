import AppKit
import PiStackKit
import SwiftUI
import WebKit

extension EnvironmentValues {
    @Entry var openArtifact: (ArtifactAddress) -> Void = { _ in }
    @Entry var openSpace: (ArtifactAddress, String) -> Void = { _, _ in }
    @Entry var openText: (String) -> Void = { _ in }
}

private struct Opening: Identifiable {
    let id = UUID()
    let title: String
    var address: ArtifactAddress?
    var text: String?
    var space: String?
}

private struct ArtifactViewer: ViewModifier {
    let botId: String
    let api: Api
    @State private var opening: Opening?
    @State private var problem: String?
    @State private var fetching = false

    func body(content: Content) -> some View {
        content
            .environment(\.openArtifact) { open($0) }
            .environment(\.openSpace) { address, space in
                show(Opening(title: title(address), address: address, space: space))
            }
            .environment(\.openText) { text in
                show(Opening(title: "全文 · 约 \(readingLength(text)) 字", text: text))
            }
            .overlay {
                if let opening {
                    DocumentPage(opening: opening, botId: botId, api: api) { show(nil) }
                        .transition(.opacity.combined(with: .scale(scale: 0.98)))
                        .id(opening.id)
                }
            }
            .overlay(alignment: .top) {
                if fetching {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text("正在下载…")
                    }
                    .type(12, .medium, line: 16)
                    .padding(.horizontal, 14)
                    .frame(height: 32)
                    .glassEffect(.regular, in: .capsule)
                    .padding(.top, 70)
                    .transition(.opacity)
                }
            }
            .alert("无法打开", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("好") {}
            } message: {
                Text(problem ?? "")
            }
    }

    private func show(_ next: Opening?) {
        withAnimation(.spring(duration: 0.32, bounce: 0.12)) { opening = next }
    }

    private func title(_ address: ArtifactAddress) -> String { address.fileName }

    private func open(_ address: ArtifactAddress) {
        if address.isMarkdown || address.isHTML {
            show(Opening(title: title(address), address: address))
            return
        }
        withAnimation { fetching = true }
        Task {
            defer { withAnimation { fetching = false } }
            do {
                NSWorkspace.shared.open(try await api.download(api.artifactURL(botId, address), as: address.fileName))
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

private struct DocumentPage: View {
    let opening: Opening
    let botId: String
    let api: Api
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            Rectangle().fill(.ultraThinMaterial).overlay { Color.black.opacity(0.28) }
                .contentShape(.rect)
                .onTapGesture(perform: onClose)
            content
                .padding(.top, 76)
            HStack(spacing: 12) {
                Spacer()
                Text(opening.title).type(13, .semibold, line: 18).foregroundStyle(Color.ink).lineLimit(1)
                Spacer()
            }
            .frame(height: 48)
            .padding(.top, 14)
            .padding(.horizontal, 140)
            HStack(spacing: 10) {
                Spacer()
                if let action { action }
                CircleButton(symbol: "xmark", help: "关闭", action: onClose)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.top, 14)
            .padding(.horizontal, 16)
        }
        .ignoresSafeArea()
    }

    private var action: AnyView? {
        if let text = opening.text {
            return AnyView(Capsuled(symbol: "doc.on.doc", title: "拷贝") { copy(text) })
        }
        guard let address = opening.address else { return nil }
        return AnyView(Capsuled(symbol: "arrow.down.to.line", title: "下载") {
            Task {
                guard let file = try? await api.download(api.artifactURL(botId, address), as: address.fileName) else { return }
                let panel = NSSavePanel()
                panel.nameFieldStringValue = address.fileName
                if panel.runModal() == .OK, let url = panel.url {
                    try? FileManager.default.removeItem(at: url)
                    try? FileManager.default.copyItem(at: file, to: url)
                }
            }
        })
    }

    @ViewBuilder
    private var content: some View {
        if let text = opening.text {
            reader(text)
        } else if let address = opening.address {
            let load = { try await api.artifactText(botId, name: address.name, version: address.version) }
            if address.isHTML {
                Loaded(load: load) { html in
                    HTMLPage(html: html, bridge: opening.space.map { SpaceBridge(botId: botId, space: $0, api: api) })
                        .background(Color.paper)
                        .clipShape(.rect(cornerRadius: 28, style: .continuous))
                        .overlay { RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Color.line, lineWidth: 0.5) }
                        .shadow(color: .black.opacity(0.25), radius: 30, y: 10)
                        .frame(maxWidth: 1180)
                        .padding(.horizontal, 32)
                        .padding(.bottom, 24)
                }
            } else {
                Loaded(load: load) { reader($0) }
            }
        }
    }

    private func reader(_ text: String) -> some View {
        ScrollView {
            MarkdownText(text: text, size: 15, line: 25, selectable: true, document: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 48)
                .padding(.vertical, 44)
                .pane(28, tint: .reply)
                .frame(width: 720)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.automatic)
    }
}

struct CircleButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.ink).frame(width: 48, height: 48).contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(.pane).interactive(), in: .circle)
        .help(help)
    }
}

struct Capsuled: View {
    let symbol: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .type(13, .semibold, line: 18)
                .foregroundStyle(Color.knobInk)
                .padding(.horizontal, 18)
                .frame(height: 48)
                .background(Color.knob, in: .capsule)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
    }
}

private struct HTMLPage: NSViewRepresentable {
    let html: String
    let bridge: SpaceBridge?
    @Environment(\.colorScheme) private var scheme

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let dark = scheme == .dark
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let theme = HTMLTheme.script(dark: dark)
        configuration.userContentController.addUserScript(WKUserScript(source: theme, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.addUserScript(WKUserScript(source: theme, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        bridge?.install(in: configuration.userContentController)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.underPageBackgroundColor = .clear
        view.navigationDelegate = context.coordinator
        context.coordinator.dark = dark
        view.loadHTMLString(HTMLTheme.prepared(html), baseURL: nil)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
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
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }
}

extension View {
    func artifactViewer(botId: String, api: Api) -> some View {
        modifier(ArtifactViewer(botId: botId, api: api))
    }
}
