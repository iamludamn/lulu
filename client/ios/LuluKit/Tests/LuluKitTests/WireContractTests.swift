import Foundation
import Testing
@testable import LuluKit

@Test func decodesBotStateAndDefaultsAcrossWireVersions() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let fixture = testFile.deletingLastPathComponent()
        .appendingPathComponent("../../../../../core/tests/fixtures/chat-wire.json")
        .standardizedFileURL
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture))
    let frames = try #require(document as? [String: Any])
    func state(_ key: String) throws -> ServerMessage {
        let json = try #require(frames[key])
        return try JSONDecoder().decode(ServerMessage.self, from: JSONSerialization.data(withJSONObject: json))
    }

    guard case .state(let view, _, _, let panel, _) = try state("state") else {
        Issue.record("Expected a state frame")
        return
    }
    #expect(view.deliveryReceipts == true)
    #expect(view.applied(to: nil)?.entries.isEmpty == true)
    #expect(panel.list.map(\.id) == ["lulu:schedules"])
    #expect(panel.scheduleRevision == 2)
    #expect(panel.scheduleReceipts["schedule-offer"]?.requestIds == ["keep-schedule"])

    guard case .state(let legacyView, _, _, let legacyPanel, let assets) = try state("legacyState") else {
        Issue.record("Expected a legacy state frame")
        return
    }
    #expect(legacyView.deliveryReceipts == nil)
    #expect(legacyView.applied(to: nil)?.entries.isEmpty == true)
    #expect(legacyPanel.list.isEmpty)
    #expect(legacyPanel.scheduleReceipts.isEmpty)
    #expect(assets.isEmpty)
}
