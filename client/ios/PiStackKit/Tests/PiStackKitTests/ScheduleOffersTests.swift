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
    #expect(scheduleOfferState(b, panel: keptA) == .superseded)
    #expect(scheduleOfferState(b, panel: keptA.checking("lulu:schedules", item: 0, done: true)) == .superseded)
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

@Test func chatRendersTextAndCardsOnlyAfterSuccessfulSend() throws {
    func call(_ id: String, _ arguments: String) -> String {
        """
        {"type":"toolCall","name":"send_to_user","id":"\(id)","arguments":\(arguments)}
        """
    }
    func result(_ entry: Int, _ id: String, error: Bool = false, details: String = "{}") -> String {
        """
        {"id":\(entry),"kind":"pi.tool-result","model":[{"role":"toolResult","toolName":"send_to_user","toolCallId":"\(id)","isError":\(error),"details":\(details)}]}
        """
    }
    let overview = #"{"type":"widget","widget":{"kind":"schedule_overview"},"end_turn":true}"#
    let calls = [
        call("text", ##"{"type":"text","content":"Summary","body":"# Details"}"##),
        call("asset", #"{"type":"widget","widget":{"kind":"asset","ref":"artifact://report.html@1","title":"Report"}}"#),
        call("widget", #"{"type":"widget","widget":{"kind":"panel","panel":{"id":"note","title":"Note","size":"m","body":{"kind":"note","markdown":"Saved note"}}}}"#),
        call("schedule", overview),
        call("failed", overview),
        call("pending", overview),
    ].joined(separator: ",")
    let details = """
    {"widget":{"kind":"panel","panel":\(widget(1))}}
    """
    let view = try decodeView([
        #"{"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Unsent draft"}]}]}"#,
        #"{"id":2,"kind":"pi.user","model":[{"role":"user","content":"Show me"}]}"#,
        """
        {"id":3,"kind":"pi.assistant","model":[{"role":"assistant","content":[\(calls)]}]}
        """,
        result(4, "text"), result(5, "asset"), result(6, "widget"),
        result(7, "schedule", details: details), result(8, "failed", error: true, details: details),
    ])
    let entries = chatEntries(view, hidden: [])
    #expect(entries.map(\.id) == ["2", "text", "asset", "widget", "schedule"])
    #expect(entries[1].text == "Summary")
    #expect(entries[1].body == "# Details")
    guard case .asset? = entries[2].card, case .panel? = entries[3].card,
          let schedule = entries.last, case .panel(let panel)? = schedule.card,
          case .schedules = panel.body else {
        Issue.record("A successfully sent card did not decode")
        return
    }
    #expect(schedule.final)
    #expect(scheduleOfferState(schedule, panel: PanelState()) == .add)
    let accepted = try decodePanel("""
    {"order":["lulu:schedules"],"widgets":{"lulu:schedules":\(widget(1, origin: schedule.id))},
     "scheduleReceipts":{"\(schedule.id)":{"action":"add","requestIds":["keep"]}}}
    """)
    #expect(scheduleOfferState(schedule, panel: accepted) == .accepted(.add))
}
