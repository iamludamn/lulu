import Foundation
import Testing
@testable import PiStackKit

private func widget(_ version: Int, origin: String? = nil) throws -> PanelWidget {
    var json: [String: Any] = ["id": "trip", "size": "m", "title": "旅行计划", "body": ["kind": "space", "src": "artifact://spaces/trip/index.html@\(version)", "preview": "artifact://spaces/trip/cover.html@\(version)"]]
    json["origin"] = origin
    return try JSONDecoder().decode(PanelWidget.self, from: JSONSerialization.data(withJSONObject: json))
}
private func entry(_ id: String, version: Int) throws -> ChatEntry {
    ChatEntry(id: id, position: Double(version), role: .assistant, text: "", body: nil, card: .panel(try widget(version)), time: nil, final: true)
}
private func panel(_ json: String) throws -> PanelState {
    try JSONDecoder().decode(PanelState.self, from: Data(json.utf8))
}

@Test func onlyLatestPendingOfferIsActionable() throws {
    let entries = try [entry("a", version: 1), entry("b", version: 2), entry("c", version: 2)]
    let states = spaceOfferStates(entries, panel: PanelState())
    #expect(states["a"] == .superseded)
    #expect(states["b"] == .superseded)
    #expect(states["c"] == .add)
}

@Test func keptSpaceProposalIsAnUpdateWithoutChangingCurrentVersion() throws {
    let current = try widget(1, origin: "a")
    let panel = PanelState(order: ["trip"], widgets: ["trip": current])
    let states = spaceOfferStates(try [entry("a", version: 1), entry("b", version: 2)], panel: panel)
    #expect(states["a"] == .accepted(.add))
    #expect(states["b"] == .update)
    #expect(panel.widgets["trip"]?.spaceVersion == 1)
}

@Test func acceptedOffersBecomeDurableReceiptsNotResurrectedCards() throws {
    let state = try panel("""
    {"order":["trip"],"widgets":{"trip":{"id":"trip","size":"m","title":"旅行计划","origin":"b","body":{"kind":"space","src":"artifact://spaces/trip/index.html@2","preview":"artifact://spaces/trip/cover.html@2"}}},"spaceReceipts":{"a":{"id":"trip","version":1,"action":"add"},"b":{"id":"trip","version":2,"action":"update"}}}
    """)
    let states = spaceOfferStates(try [entry("a", version: 1), entry("b", version: 2)], panel: state)
    #expect(states["a"] == .accepted(.add))
    #expect(states["b"] == .accepted(.update))
    #expect(states.values.allSatisfy { !$0.actionable })
    #expect(state.checking("trip", item: 0, done: true).spaceReceipts == state.spaceReceipts)
}

@Test func removalAndReloadCannotTurnOldRevisionsIntoActionableCards() throws {
    let state = try panel("""
    {"order":[],"widgets":{},"spaceReceipts":{"b":{"id":"trip","version":2,"action":"update"}}}
    """)
    let states = spaceOfferStates(try [entry("a", version: 1), entry("b", version: 2)], panel: state)
    #expect(states["a"] == .superseded)
    #expect(states["b"] == .add)
}

@Test func legacyPanelDocumentsStillDecode() throws {
    #expect(try panel("{\"order\":[],\"widgets\":{}}").spaceReceipts.isEmpty)
    #expect(SpaceOfferState.add.caption == "滑动加入视图")
    #expect(SpaceOfferState.update.caption == "滑动更新视图")
    #expect(SpaceOfferState.accepted(.update).caption == "已更新")
}
