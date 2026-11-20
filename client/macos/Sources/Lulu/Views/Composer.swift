import AppKit
import SwiftUI

struct Composer: View {
    @Binding var draft: String
    let busy: Bool
    let placeholder: String
    let focus: Int
    let onSend: () -> Void
    let onStop: () -> Void
    @State private var textHeight: CGFloat = 22

    static let minHeight: CGFloat = 48
    static let maxHeight: CGFloat = 219

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var height: CGFloat { min(Self.maxHeight, max(Self.minHeight, textHeight + 26)) }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ComposerField(text: $draft, height: $textHeight, focus: focus, onSubmit: submit)
                .padding(.leading, 16)
                .padding(.trailing, 52)
                .padding(.vertical, 13)
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(placeholder)
                            .type(15, line: 22)
                            .foregroundStyle(Color.muted)
                            .padding(.leading, 16)
                            .padding(.top, 13)
                            .allowsHitTesting(false)
                    }
                }
            action.padding(6)
        }
        .frame(height: height)
        .pane(24, tint: nil)
        .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.line.opacity(0.6), lineWidth: 0.5).allowsHitTesting(false) }
        .animation(.snappy(duration: 0.22), value: height)
    }

    private func submit() {
        if canSend { onSend() }
    }

    @ViewBuilder
    private var action: some View {
        let mode = canSend ? 0 : busy ? 1 : 2
        Button {
            if canSend { onSend() } else if busy { onStop() }
        } label: {
            Image(systemName: mode == 1 ? "stop.fill" : "arrow.up")
                .font(.system(size: mode == 1 ? 12 : 15, weight: .bold))
                .foregroundStyle(mode == 2 ? Color.faint : Color.knobInk)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 36, height: 36)
                .background(mode == 2 ? Color.veil : Color.knob, in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(mode == 2)
        .help(mode == 0 ? (busy ? "追加" : "发送") : mode == 1 ? "停止" : "")
        .animation(.snappy(duration: 0.2), value: mode)
    }
}

private struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let focus: Int
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        let view = scroll.documentView as! NSTextView
        view.delegate = context.coordinator
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        view.importsGraphics = false
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 22
        paragraph.maximumLineHeight = 22
        let font = NSFont.systemFont(ofSize: 15)
        let baseline = (22 - (font.ascender - font.descender)) / 2
        view.defaultParagraphStyle = paragraph
        view.typingAttributes = [.font: font, .paragraphStyle: paragraph, .foregroundColor: NSColor.textColor, .baselineOffset: baseline]
        view.font = font
        view.textColor = .textColor
        view.insertionPointColor = .textColor
        view.string = text
        context.coordinator.view = view
        DispatchQueue.main.async {
            view.window?.makeFirstResponder(view)
            context.coordinator.measure()
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let view = coordinator.view else { return }
        if view.string != text, !view.hasMarkedText() {
            view.string = text
            view.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            DispatchQueue.main.async { coordinator.measure() }
        }
        if coordinator.focus != focus {
            coordinator.focus = focus
            DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        weak var view: NSTextView?
        var focus: Int

        init(_ parent: ComposerField) {
            self.parent = parent
            focus = parent.focus
        }

        func textDidChange(_ notification: Notification) {
            guard let view else { return }
            parent.text = view.string
            measure()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
            let flags = NSApp.currentEvent?.modifierFlags ?? []
            if flags.contains(.shift) || flags.contains(.option) {
                textView.insertNewlineIgnoringFieldEditor(nil)
            } else {
                parent.onSubmit()
            }
            return true
        }

        func measure() {
            guard let view, let manager = view.layoutManager, let container = view.textContainer else { return }
            manager.ensureLayout(for: container)
            let used = manager.usedRect(for: container).height
            let lines = max(22, used)
            if abs(parent.height - lines) > 0.5 { parent.height = lines }
        }
    }
}
