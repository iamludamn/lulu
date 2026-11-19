import Foundation
import Testing
@testable import PiStackKit

private func widget(_ revision: Int, rows: String = "[]", origin: String? = nil) -> String {
    let metadata = origin.map { #","origin":"\#($0)""# } ?? ""
    return """
    {"id":"lulu:schedules","title":"定时任务","size":"m"\(metadata),"body":{"kind":"schedules","revision":\(revision),"rows":\(rows)}}
    """
}

private func offer(_ id: Int, _ widget: String) -> String {
    """
    {"id":\(id),"kind":"lulu.schedules.offer","data":{"at":1900000000000,"widget":{"kind":"panel","panel":\(widget)}}}
    """
}

private func decodeView(_ entries: [String]) throws -> ConversationView {
    try JSONDecoder().decode(ConversationView.self, from: Data("""
    {"entries":[\(entries.joined(separator: ","))],"docs":{}}
    """.utf8))
}

private func decodePanel(_ json: String) throws -> PanelState {
    try JSONDecoder().decode(PanelState.self, from: Data(json.utf8))
}

@Test func schedulesDecodeFromTranscriptAndSurviveCacheRoundTrip() throws {
    let rows = (1...15).map { index in
        """
        {"id":"job-\(index)","name":"Task \(index)","schedule":{"kind":"daily","time":"09:45","tz":"Asia/Singapore"},"state":"\(index == 1 ? "deleted" : "active")","nextRunAt":\(index == 1 ? "null" : "1900000000000")}
        """
    }.joined(separator: ",")
    let view = try decodeView([offer(10, widget(1, rows: "[\(rows)]")), offer(11, widget(2))])
    let reloaded = try JSONDecoder().decode(ConversationView.self, from: JSONEncoder().encode(view))
    let entries = chatEntries(reloaded, hidden: [])
    #expect(entries.map(\.id) == ["schedules:10", "schedules:11"])
    guard case .panel(let full) = entries.first?.card, case .schedules(let revision, let tasks) = full.body,
          case .panel(let empty) = entries.last?.card, case .schedules(_, let emptyRows) = empty.body else {
        Issue.record("Schedule widget did not decode")
        return
    }
    #expect(revision == 1)
    #expect(tasks.count == 15)
    #expect(tasks.last?.id == "job-15")
    #expect(tasks.first?.state == .deleted)
    #expect(tasks.first?.nextRunAt == nil)
    #expect(tasks.last?.schedule == .daily(time: "09:45", tz: "Asia/Singapore"))
    #expect(emptyRows.isEmpty)
}

@Test func scheduleSwipeLabelsFollowDurableReceiptsAndLatestRevision() throws {
    let entries = chatEntries(try decodeView([offer(10, widget(1)), offer(20, widget(2))]), hidden: [])
    let a = entries[0]
    let b = entries[1]
    let empty = try decodePanel(#"{"order":[],"widgets":{},"scheduleRevision":1}"#)
    #expect(scheduleOfferState(a, panel: empty) == .add)
    let keptA = try decodePanel("""
    {"order":["lulu:schedules"],"widgets":{"lulu:schedules":\(widget(1, origin: a.id))},"scheduleRevision":2,
     "scheduleReceipts":{"\(a.id)":{"action":"add","requestIds":["req-a"]}}}
    """)
    #expect(scheduleOfferState(a, panel: keptA) == .accepted(.add))
    #expect(scheduleOfferState(b, panel: keptA) == .update)
    #expect(scheduleOfferState(b, panel: keptA.checking("lulu:schedules", item: 0, done: true)) == .update)
    let reconnected = try decodePanel("""
    {"order":["lulu:schedules"],"widgets":{"lulu:schedules":\(widget(2, origin: b.id))},"scheduleRevision":2,
     "scheduleReceipts":{"\(b.id)":{"action":"update","requestIds":["req-b"]}}}
    """)
    #expect(scheduleOfferState(b, panel: reconnected) == .accepted(.update))
    #expect(reconnected.scheduleReceipts[b.id]?.requestIds.contains("req-b") == true)
    #expect(scheduleOfferState(a, panel: reconnected) == .superseded)
    let removed = try decodePanel("""
    {"order":[],"widgets":{},"scheduleRevision":2,"scheduleReceipts":{"\(b.id)":{"action":"update","requestIds":["req-b"]}}}
    """)
    #expect(scheduleOfferState(a, panel: removed) == .superseded)
    #expect(scheduleOfferState(b, panel: removed) == .add)
}

@Test func schedulePlaceholdersAndLegacyPanelsDecodeWithoutAnOffer() throws {
    let view = try decodeView([#"{"id":99,"kind":"lulu.schedules.offer"}"#])
    #expect(chatEntries(view, hidden: []).isEmpty)
    let panel = try decodePanel(#"{"order":["n"],"widgets":{"n":{"id":"n","size":"s","title":"Note","body":{"kind":"note","markdown":"hello"}}}}"#)
    #expect(panel.list.map(\.id) == ["n"])
    #expect(panel.scheduleRevision == nil)
    #expect(panel.scheduleReceipts.isEmpty)
}
