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
