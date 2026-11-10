import AppKit
import SwiftUI

private enum Block {
    case paragraph(String)
    case heading(level: Int, text: String)
    case item(marker: String, depth: Int, text: String)
    case quote(String)
    case rule
    case code(language: String, body: String)
    case table([[String]])
}

private func parse(_ text: String) -> [Block] {
    var result: [Block] = []
    var prose: [String] = []
    var table: [String] = []
    var fence: (language: String, lines: [String])?
    func flushProse() {
        if !prose.isEmpty { result.append(.paragraph(prose.joined(separator: "\n"))) }
        prose = []
    }
    func flushTable() {
        if !table.isEmpty { result.append(.table(cells(of: table))) }
        table = []
    }
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(raw)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if var open = fence {
            if trimmed.hasPrefix("```") {
                result.append(.code(language: open.language, body: open.lines.joined(separator: "\n")))
                fence = nil
            } else {
                open.lines.append(line)
                fence = open
            }
            continue
        }
        if trimmed.hasPrefix("|") {
            flushProse()
            table.append(trimmed)
            continue
        }
        flushTable()
        let depth = (line.count - line.drop(while: { $0 == " " }).count) / 2
        if trimmed.hasPrefix("```") {
            flushProse()
            fence = (trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces), [])
        } else if trimmed.isEmpty {
            flushProse()
        } else if let block = heading(trimmed) ?? rule(trimmed) ?? item(trimmed, depth: depth) {
            flushProse()
            result.append(block)
        } else if trimmed.hasPrefix(">") {
            flushProse()
            let body = trimmed.dropFirst().trimmingCharacters(in: .whitespaces)
            if case .quote(let previous)? = result.last {
                result[result.count - 1] = .quote(previous + "\n" + body)
            } else {
                result.append(.quote(body))
            }
        } else {
            prose.append(line)
        }
    }
    flushProse()
    flushTable()
    if let fence { result.append(.code(language: fence.language, body: fence.lines.joined(separator: "\n"))) }
    return result
}

private func heading(_ line: String) -> Block? {
    let level = line.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(level), line.dropFirst(level).first == " " else { return nil }
    return .heading(level: level, text: line.dropFirst(level).trimmingCharacters(in: .whitespaces))
}

private func rule(_ line: String) -> Block? {
    guard line.count >= 3, let first = line.first, "-*_".contains(first), line.allSatisfy({ $0 == first }) else { return nil }
    return .rule
}

private func item(_ line: String, depth: Int) -> Block? {
    for bullet in ["- ", "* ", "+ "] where line.hasPrefix(bullet) {
        return .item(marker: "•", depth: depth, text: String(line.dropFirst(2)))
    }
    let digits = line.prefix(while: \.isNumber)
    let rest = line.dropFirst(digits.count)
    guard (1...3).contains(digits.count), rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
    return .item(marker: "\(digits).", depth: depth, text: String(rest.dropFirst(2)))
}

private func cells(of lines: [String]) -> [[String]] {
    lines.compactMap { line in
        var parts = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.first == "" { parts.removeFirst() }
        if parts.last == "" { parts.removeLast() }
        let divider = parts.allSatisfy { !$0.isEmpty && $0.allSatisfy { "-: ".contains($0) } }
        return divider ? nil : parts
    }
}

private func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    var result = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    let code = result.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
    for range in code { result[range].backgroundColor = Color.veil }
    return linkified(result)
}

func linkified(_ text: AttributedString) -> AttributedString {
    var result = text
    let plain = String(text.characters)
    let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    for match in detector?.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) ?? [] {
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

struct MarkdownText: View {
    let text: String
    var size: CGFloat = 15
    var line: CGFloat = 19
    var selectable = false
    var document = false

    var body: some View {
        if selectable {
            content.textSelection(.enabled)
        } else {
            content
        }
    }

    private var content: some View {
        let blocks = parse(text)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                view(block).padding(.top, index == 0 ? 0 : gap(blocks[index - 1], block))
            }
        }
        .font(.ui(size))
        .lineHeight(.exact(points: line))
        .foregroundStyle(Color.ink)
    }

    private func gap(_ previous: Block, _ next: Block) -> CGFloat {
        switch (previous, next) {
        case (.item, .item): document ? 6 : 4
        case (_, .heading(let level, _)): document ? (level <= 2 ? 30 : 22) : 14
        case (.heading, _): document ? 10 : 6
        default: document ? 16 : 10
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        guard document else { return level <= 2 ? size + 2 : size }
        switch level {
        case 1: return 28
        case 2: return 22
        case 3: return 18
        default: return size
        }
    }

    @ViewBuilder
    private func view(_ block: Block) -> some View {
        switch block {
        case .paragraph(let text):
            Text(inline(text))
        case .heading(let level, let text):
            let points = headingSize(level)
            Text(inline(text))
                .font(.ui(points, .semibold))
                .lineHeight(.exact(points: (points * 1.32).rounded()))
                .tracking(document && level <= 2 ? -0.3 : 0)
        case .item(let marker, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: document ? 10 : 6) {
                Text(marker).monospacedDigit().foregroundStyle(Color.muted)
                Text(inline(text))
            }
            .padding(.leading, CGFloat(depth) * (document ? 22 : 16))
        case .quote(let text):
            HStack(spacing: document ? 14 : 8) {
                Capsule().fill(document ? Color.info.opacity(0.6) : Color.faint).frame(width: 3)
                Text(inline(text)).foregroundStyle(Color.muted).italic(document)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().fill(Color.line).frame(height: 1).padding(.vertical, document ? 14 : 4)
        case .code(let language, let body):
            CodeBlock(language: language, code: body)
        case .table(let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(inline(cell)).fontWeight(index == 0 ? .semibold : .regular)
                            }
                        }
                        if index == 0 { Rectangle().fill(Color.line).frame(height: 1).gridCellColumns(max(row.count, 1)) }
                    }
                }
                .font(.ui(size - 2))
                .lineHeight(.exact(points: line - 2))
                .padding(10)
            }
            .background(Color.veil, in: .rect(cornerRadius: 12, style: .continuous))
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
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 28, height: 24)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help(copied ? "已拷贝" : "拷贝代码")
            }
            .font(.ui(12))
            .lineHeight(.exact(points: 16))
            .foregroundStyle(Color.muted)
            .padding(.leading, 12)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineHeight(.exact(points: 18))
                    .padding([.horizontal, .bottom], 12)
            }
        }
        .background(Color.veil, in: .rect(cornerRadius: 12, style: .continuous))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}
