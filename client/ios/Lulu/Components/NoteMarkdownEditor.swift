import LuluKit
import SwiftUI
import UniformTypeIdentifiers

struct NoteMarkdownEditor: UIViewRepresentable {
    let text: String
    let selection: NSRange
    let label: String
    let onText: (String, NSRange) -> Void
    let onSelection: (NSRange) -> Void
    let onEnd: () -> Void
    let onChooseFile: (NSRange) -> Void
    let onPaste: (UIPasteboard, NSRange) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> Editor {
        let view = Editor()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.isScrollEnabled = false
        view.textContainer.lineFragmentPadding = 0
        view.textContainerInset = .zero
        view.smartDashesType = .no
        view.smartQuotesType = .no
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: Editor, context: Context) {
        let coordinator = context.coordinator
        coordinator.editor = self
        coordinator.syncing = true
        defer { coordinator.syncing = false }
        view.accessibilityLabel = label
        view.onPaste = onPaste
        if view.markedTextRange == nil {
            if view.text != text { view.text = text }
            if view.selectedRange != selection && NSMaxRange(selection) <= text.utf16.count {
                view.selectedRange = selection
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: Editor, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let measured = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(22, ceil(measured.height)))
    }

    static func dismantleUIView(_ view: Editor, coordinator: Coordinator) {
        view.delegate = nil
        view.resignFirstResponder()
    }

    final class Editor: UITextView {
        var onPaste: ((UIPasteboard, NSRange) -> Bool)?
        private var requestedFocus = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, !requestedFocus else { return }
            requestedFocus = true
            DispatchQueue.main.async { [weak self] in
                guard let self, self.window != nil else { return }
                self.becomeFirstResponder()
            }
        }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)) {
                let clipboard = UIPasteboard.general
                if clipboard.hasImages || clipboard.contains(pasteboardTypes: [UTType.fileURL.identifier, UTType.pdf.identifier]) {
                    return true
                }
            }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {
            if onPaste?(UIPasteboard.general, selectedRange) != true { super.paste(sender) }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var editor: NoteMarkdownEditor
        var syncing = false

        init(_ editor: NoteMarkdownEditor) { self.editor = editor }

        func textViewDidChange(_ view: UITextView) {
            guard !syncing, view.markedTextRange == nil else { return }
            editor.onText(view.text, view.selectedRange)
        }

        func textViewDidChangeSelection(_ view: UITextView) {
            guard !syncing, view.markedTextRange == nil, view.text == editor.text else { return }
            editor.onSelection(view.selectedRange)
        }

        func textViewDidEndEditing(_ view: UITextView) {
            if view.text != editor.text { editor.onText(view.text, view.selectedRange) }
            let finish = editor.onEnd
            DispatchQueue.main.async { finish() }
        }

        func textView(_ view: UITextView, shouldChangeTextInRanges ranges: [NSValue], replacementText text: String) -> Bool {
            guard text == "\n", ranges.count == 1, let range = ranges.first?.rangeValue,
                  view.markedTextRange == nil,
                  let continuation = MarkdownBlock.listReturn(in: view.text, replacing: range),
                  let start = view.position(from: view.beginningOfDocument, offset: continuation.range.location),
                  let end = view.position(from: start, offset: continuation.range.length),
                  let editRange = view.textRange(from: start, to: end) else { return true }
            view.replace(editRange, withText: continuation.text)
            view.selectedRange = NSRange(location: continuation.range.location + continuation.text.utf16.count, length: 0)
            editor.onText(view.text, view.selectedRange)
            return false
        }

        func textView(_ view: UITextView, editMenuForTextInRanges ranges: [NSValue], suggestedActions: [UIMenuElement]) -> UIMenu? {
            let insert = UIAction(title: "插入文件", image: UIImage(systemName: "paperclip")) { [weak self, weak view] _ in
                guard let view else { return }
                self?.editor.onChooseFile(view.selectedRange)
            }
            return UIMenu(children: [insert] + suggestedActions)
        }
    }
}
