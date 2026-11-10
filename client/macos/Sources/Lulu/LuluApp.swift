import AppKit
import SwiftUI

@main
struct LuluApp: App {
    @State private var model = AppModel()
    @AppStorage("lulu.appearance") private var appearance = Appearance.system

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
    }

    var body: some Scene {
        Window("lulu", id: "main") {
            RootView()
                .environment(model)
                .frame(minWidth: 420, minHeight: 560)
                .background(WindowFrame())
                .onChange(of: appearance, initial: true) { _, next in NSApp.appearance = next.appearance }
                .onAppear {
                    Notifier.shared.onOpen = { model.page = .chat }
                    Notifier.shared.authorize()
                    NSApp.activate()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1320, height: 880)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("设置…") { model.settings = true }.keyboardShortcut(",")
            }
            CommandGroup(replacing: .newItem) {}
            CommandMenu("显示") {
                ForEach(Page.allCases) { page in
                    Button(page.title) {
                        model.settings = false
                        model.page = page
                    }
                    .keyboardShortcut(KeyEquivalent(Character(String(page.rawValue + 1))))
                }
            }
            CommandMenu("对话") {
                Button("停止回复") { model.stopping += 1 }.keyboardShortcut(".")
            }
        }
    }
}

private struct WindowFrame: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.setFrameAutosaveName("lulu.main")
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {}
}

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "自动"
        case .light: "浅色"
        case .dark: "深色"
        }
    }

    var appearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
}
