import Foundation
import Testing
@testable import LuluKit

@Test func noteProposalsAndReceiptsSurviveTranscriptCache() throws {
    let id = "fd959745-d55f-4a31-ad46-cec2b9ca49d7"
    let block = "ff09c8c6-f965-4904-8f4a-a0128800bda8"
    let snapshot = """
    {"docs":{},"entries":[
      {"id":11,"kind":"lulu.note.proposal","data":{"id":"\(id)","base":null,"at":123,
        "content":{"title":"Trip","blocks":[{"id":"\(block)","kind":"file","ref":"artifact://map.pdf@3"}]}}},
      {"id":12,"kind":"lulu.note.accepted","data":{"id":"\(id)","editing":false}}
    ]}
    """
    let view = try JSONDecoder().decode(ConversationView.self, from: Data(snapshot.utf8))
    let cached = try JSONDecoder().decode(ConversationView.self, from: JSONEncoder().encode(view))
    let offer = try #require(chatEntries(cached, hidden: []).first?.noteProposal)
    #expect(offer.content.blocks.first?.ref == "artifact://map.pdf@3")
    #expect(offer.id == UUID(uuidString: id))
    #expect(cached.entries.last?.noteData(NoteAcceptance.self)?.id == offer.id)
}

@Test func noteReferenceIsOptionalInPromptFrame() throws {
    let id = try #require(UUID(uuidString: "fd959745-d55f-4a31-ad46-cec2b9ca49d7"))
    let ordinary = Command(.submit("Hello"))
    #expect(ordinary.frame["noteRef"] == nil)
    let withNote = Command(.submit("Review this", noteId: id, revision: 3))
    let reference = try #require(withNote.frame["noteRef"] as? [String: Any])
    #expect(reference["id"] as? String == id.uuidString)
    #expect(reference["revision"] as? Int == 3)
}

@Test func noteAnswersDecodeAnOptionalUpdate() throws {
    let reply = try JSONDecoder().decode(NoteAnswer.self, from: Data("""
    {"reply":"A trip."}
    """.utf8))
    #expect(reply.reply == "A trip.")
    #expect(reply.content == nil)
    let edit = try JSONDecoder().decode(NoteAnswer.self, from: Data("""
    {"reply":"Updated.","content":{"title":"Trip","blocks":[]}}
    """.utf8))
    #expect(edit.content?.title == "Trip")
}

@Test func markdownReadSectionsRetainTheirSourceAndTaskOffsets() throws {
    let source = "## 周末\r\n\r\n路线 🗺️\r\n散步。\r\n  - [X] 预约\r\n\r\n| 项目 | 费用 |\r\n| --- | ---: |\r\n| 门票 | 30 |\r\n\r\n~~~text\r\n- [ ] 字面量\r\n~~~"
    let sections = MarkdownBlock.parse(source)
    #expect(sections.map { (source as NSString).substring(with: $0.range) } == [
        "## 周末", "路线 🗺️\r\n散步。", "  - [X] 预约", "| 项目 | 费用 |\r\n| --- | ---: |\r\n| 门票 | 30 |", "~~~text\r\n- [ ] 字面量\r\n~~~"
    ])
    let task = try #require(sections.first { if case .task = $0.content { true } else { false } })
    guard case .task(let done, let depth, let text, let marker) = task.content else { return }
    #expect(done)
    #expect(depth == 1)
    #expect(text == "预约")
    #expect((source as NSString).substring(with: marker) == "X")
    #expect((source as NSString).replacingCharacters(in: marker, with: " ").contains("  - [ ] 预约"))
    #expect(sections.contains { $0.content == .table([["项目", "费用"], ["门票", "30"]]) })
}

@Test func markdownReturnContinuesTasksAndExitsAnEmptyItem() throws {
    let source = "  - [x] 预约 🎫"
    let caret = NSRange(location: source.utf16.count, length: 0)
    let continued = try #require(MarkdownBlock.listReturn(in: source, replacing: caret))
    #expect(continued.range == caret)
    #expect(continued.text == "\n  - [ ] ")
    let second = source + continued.text
    let empty = try #require(MarkdownBlock.listReturn(in: second, replacing: NSRange(location: second.utf16.count, length: 0)))
    #expect((second as NSString).replacingCharacters(in: empty.range, with: empty.text) == source + "\n")
    let code = "```text\n- [ ] 示例"
    #expect(MarkdownBlock.listReturn(in: code, replacing: NSRange(location: code.utf16.count, length: 0)) == nil)
}
