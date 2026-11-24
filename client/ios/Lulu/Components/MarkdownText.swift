import LuluKit
import SwiftUI

func markdownInline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    var result = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    let code = result.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
    for range in code { result[range].backgroundColor = Color.primary.opacity(0.08) }
    return linkified(result)
}

private let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

func linkified(_ text: AttributedString) -> AttributedString {
    var result = text
    let plain = String(text.characters)
    for match in linkDetector?.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) ?? [] {
        guard
            let url = match.url,
            let range = Range(match.range, in: plain),
            let lower = AttributedString.Index(range.lowerBound, within: result),
            let upper = AttributedString.Index(range.upperBound, within: result),
            result[lower..<upper].link == nil
        else { continue }
        result[lower..<upper].link = url
    }
    return result
}

struct MarkdownText: View, Equatable {
    let text: String
    var selectable = false
    var document = false
    var airy = false
    var section: MarkdownBlock.Content? = nil

    var body: some View {
        if selectable {
            content.textSelection(.enabled)
        } else {
            content
        }
    }

    private var content: some View {
        let blocks = section.map { [$0] } ?? MarkdownBlock.parse(text).map(\.content)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                view(block).padding(.top, index == 0 ? 0 : gap(blocks[index - 1], block))
            }
        }
    }

    private func gap(_ previous: MarkdownBlock.Content, _ next: MarkdownBlock.Content) -> CGFloat {
        switch (previous, next) {
        case (.item, .item), (.task, .task), (.item, .task), (.task, .item): document ? 6 : (airy ? 5 : 4)
        case (_, .heading(let level, _)): document ? (level <= 2 ? 30 : 22) : 14
        case (.heading, _): document ? 10 : 8
        default: document ? 16 : (airy ? 11 : 8)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        guard document else { return level <= 2 ? .title3.bold() : .headline }
        switch level {
        case 1: return .title.weight(.semibold)
        case 2: return .title2.weight(.semibold)
        case 3: return .title3.weight(.semibold)
        default: return .headline
        }
    }

    @ViewBuilder
    private func view(_ block: MarkdownBlock.Content) -> some View {
        switch block {
        case .paragraph(let text):
            Text(markdownInline(text))
        case .heading(let level, let text):
            Text(markdownInline(text)).font(headingFont(level))
        case .item(let marker, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: document ? 10 : 6) {
                Text(marker).monospacedDigit().foregroundStyle(.secondary)
                Text(markdownInline(text))
            }
            .padding(.leading, CGFloat(depth) * (document ? 22 : 16))
        case .task(let done, let depth, let text, _):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle").foregroundStyle(.tint)
                Text(markdownInline(text))
            }
            .padding(.leading, CGFloat(depth) * (document ? 22 : 16))
        case .quote(let text):
            HStack(spacing: document ? 14 : 8) {
                Capsule().fill(document ? AnyShapeStyle(Color.accentColor.opacity(0.6)) : AnyShapeStyle(.tertiary)).frame(width: 3)
                Text(markdownInline(text)).foregroundStyle(.secondary).italic(document)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Divider().padding(.vertical, document ? 14 : 4)
        case .code(let language, let body):
            CodeBlock(language: language, code: body)
        case .table(let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(markdownInline(cell)).fontWeight(index == 0 ? .semibold : .regular)
                            }
                        }
                        if index == 0 { Divider().gridCellColumns(max(row.count, 1)) }
                    }
                }
                .font(.subheadline)
                .padding(10)
            }
            .background(Color.primary.opacity(0.06), in: .rect(cornerRadius: 10))
        }
    }
}

private struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 28, height: 24)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "已拷贝" : "拷贝代码")
            }
            .font(.caption)
            .fontDesign(.default)
            .foregroundStyle(.secondary)
            .padding(.leading, 10)
            .padding(.trailing, 4)
            .padding(.vertical, 2)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .fontDesign(.monospaced)
                    .padding([.horizontal, .bottom], 10)
            }
        }
        .background(Color.primary.opacity(0.06), in: .rect(cornerRadius: 10))
        .sensoryFeedback(.success, trigger: copied) { _, new in new }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}
