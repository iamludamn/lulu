import Foundation

public struct MarkdownBlock {
    public enum Content: Equatable {
        case paragraph(String)
        case heading(level: Int, text: String)
        case item(marker: String, depth: Int, text: String)
        case task(done: Bool, depth: Int, text: String, marker: NSRange)
        case quote(String)
        case rule
        case code(language: String, body: String)
        case table([[String]])
    }

    public let range: NSRange
    public let content: Content

    public static func parse(_ source: String) -> [Self] {
        let lines = source.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        var position = 0
        let ranges = lines.map { line in
            let range = NSRange(location: position, length: line.utf16.count)
            let separator = line.endIndex == source.endIndex ? 0 : String(source[line.endIndex]).utf16.count
            position = NSMaxRange(range) + separator
            return range
        }
        var output: [Self] = []
        var index = 0
        func append(_ content: Content, from start: Int) {
            let first = ranges[start].location
            output.append(Self(range: NSRange(location: first, length: NSMaxRange(ranges[index - 1]) - first), content: content))
        }
        func trimmed(_ index: Int) -> String {
            lines[index].trimmingCharacters(in: .whitespaces)
        }
        func startsTable(_ index: Int) -> Bool {
            guard index + 1 < lines.count, lines[index].contains("|") else { return false }
            let columns = cells(lines[index + 1])
            return columns.count == cells(lines[index]).count && columns.count > 1 && columns.allSatisfy {
                $0.contains("-") && $0.allSatisfy { "-:".contains($0) }
            }
        }
        func standalone(_ index: Int) -> Content? {
            let line = trimmed(index)
            let level = line.prefix(while: { $0 == "#" }).count
            if (1...6).contains(level), line.dropFirst(level).first == " " {
                return .heading(level: level, text: line.dropFirst(level + 1).trimmingCharacters(in: .whitespaces))
            }
            if line.count >= 3, let first = line.first, "-*_".contains(first), line.allSatisfy({ $0 == first }) {
                return .rule
            }
            guard let list = ListLine(lines[index]) else { return nil }
            let depth = list.indent.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2
            if let done = list.done {
                let offset = ranges[index].location + list.indent.utf16.count + 3
                return .task(done: done, depth: depth, text: list.body, marker: NSRange(location: offset, length: 1))
            }
            return .item(marker: list.number.map { "\($0)." } ?? "•", depth: depth, text: list.body)
        }

        while index < lines.count {
            let start = index
            let line = trimmed(index)
            index += 1
            if line.isEmpty { continue }
            if let fence = fencePrefix(line) {
                let bodyStart = index
                while index < lines.count && !closesFence(trimmed(index), fence: fence) { index += 1 }
                let body = lines[bodyStart..<index].joined(separator: "\n")
                if index < lines.count { index += 1 }
                append(.code(language: line.dropFirst(fence.count).trimmingCharacters(in: .whitespaces), body: body), from: start)
            } else if startsTable(start) {
                index += 1
                while index < lines.count && lines[index].contains("|") && !trimmed(index).isEmpty { index += 1 }
                append(.table([cells(lines[start])] + lines[(start + 2)..<index].map(cells)), from: start)
            } else if let block = standalone(start) {
                append(block, from: start)
            } else if line.hasPrefix(">") {
                while index < lines.count && trimmed(index).hasPrefix(">") { index += 1 }
                let body = (start..<index).map { trimmed($0).dropFirst().trimmingCharacters(in: .whitespaces) }
                append(.quote(body.joined(separator: "\n")), from: start)
            } else {
                while index < lines.count {
                    let next = trimmed(index)
                    if next.isEmpty || next.hasPrefix(">") || fencePrefix(next) != nil ||
                        standalone(index) != nil || startsTable(index) { break }
                    index += 1
                }
                append(.paragraph(lines[start..<index].joined(separator: "\n")), from: start)
            }
        }
        return output
    }

    public static func listReturn(in text: String, replacing selection: NSRange) -> (range: NSRange, text: String)? {
        let source = text as NSString
        guard Range(selection, in: text) != nil else { return nil }
        let current = source.lineRange(for: NSRange(location: selection.location, length: 0))
        let line = source.substring(with: current).prefix(while: { !$0.isNewline })
        guard NSMaxRange(selection) <= current.location + line.utf16.count,
              let list = ListLine(line),
              parse(text).contains(where: { block in
                  guard block.range.location == current.location else { return false }
                  switch block.content { case .task, .item: return true; default: return false }
              }) else { return nil }
        let prefix = list.indent + list.marker
        guard selection.location >= current.location + prefix.utf16.count else { return nil }
        if list.body.trimmingCharacters(in: .whitespaces).isEmpty {
            return (NSRange(location: current.location, length: line.utf16.count), "")
        }
        let next = list.done != nil ? "\(list.marker.prefix(2))[ ] " :
            list.number.map { "\($0 + 1)\(list.marker.suffix(2))" } ?? list.marker
        return (selection, "\n" + list.indent + next)
    }

    private static func fencePrefix(_ line: String) -> String? {
        guard let first = line.first, first == "`" || first == "~" else { return nil }
        let prefix = line.prefix(while: { $0 == first })
        return prefix.count >= 3 ? String(prefix) : nil
    }

    private static func closesFence(_ line: String, fence: String) -> Bool {
        line.hasPrefix(fence) && line.allSatisfy { $0 == fence.first }
    }

    private static func cells(_ line: Substring) -> [String] {
        var parts = line.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        if parts.first == "" { parts.removeFirst() }
        if parts.last == "" { parts.removeLast() }
        return parts
    }

    private struct ListLine {
        let indent: String
        let marker: String
        let body: String
        let number: Int?
        let done: Bool?

        init?(_ line: Substring) {
            let indent = line.prefix(while: { $0 == " " || $0 == "\t" })
            self.indent = String(indent)
            let rest = line.dropFirst(indent.count)
            if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
                let afterBullet = rest.dropFirst(2)
                let token = afterBullet.prefix(3)
                if ["[ ]", "[x]", "[X]"].contains(token), afterBullet.count == 3 || afterBullet.dropFirst(3).first == " " {
                    marker = String(rest.prefix(6))
                    body = String(rest.dropFirst(6))
                    done = token != "[ ]"
                } else {
                    marker = String(rest.prefix(2))
                    body = String(afterBullet)
                    done = nil
                }
                number = nil
            } else {
                let digits = rest.prefix(while: { $0.isASCII && $0.isNumber })
                let ending = rest.dropFirst(digits.count)
                guard (1...9).contains(digits.count), let number = Int(digits),
                      ending.hasPrefix(". ") || ending.hasPrefix(") ") else { return nil }
                marker = String(rest.prefix(digits.count + 2))
                body = String(ending.dropFirst(2))
                self.number = number
                done = nil
            }
        }
    }
}
