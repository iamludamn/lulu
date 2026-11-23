import Foundation
import SwiftParser
import SwiftSyntax

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])!
var foundComment = false

for case let file as URL in files {
    if file.lastPathComponent == "build" || file.lastPathComponent == "xcuserdata" {
        files.skipDescendants()
    }
    guard file.pathExtension == "swift" else { continue }
    let source = try String(contentsOf: file, encoding: .utf8)
    let tree = Parser.parse(source: source)
    let converter = SourceLocationConverter(fileName: file.path, tree: tree)

    func check(_ trivia: Trivia, at start: AbsolutePosition) {
        var position = start
        for piece in trivia {
            defer { position = position.advanced(by: piece.sourceLength.utf8Length) }
            switch piece {
            case .lineComment(let text):
                if position.utf8Offset == 0 && file.lastPathComponent == "Package.swift" &&
                    text.range(of: #"^// swift-tools-version: \d+\.\d+(\.\d+)?$"#, options: .regularExpression) != nil {
                    continue
                }
            case .blockComment, .docBlockComment, .docLineComment:
                break
            default:
                continue
            }

            let location = converter.location(for: position)
            let diagnostic = "\(location.file):\(location.line):\(location.column): error no-comments: Remove the source comment.\n"
            FileHandle.standardError.write(Data(diagnostic.utf8))
            foundComment = true
        }
    }

    for token in tree.tokens(viewMode: .sourceAccurate) {
        check(token.leadingTrivia, at: token.position)
        check(token.trailingTrivia, at: token.endPositionBeforeTrailingTrivia)
    }
}

exit(foundComment ? 1 : 0)
