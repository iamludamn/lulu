import Foundation
import Testing
@testable import PiStackKit

@Test func checklistCountsOnlyPendingRowsAndKeepsOriginalIndices() throws {
    let panel = try JSONDecoder().decode(PanelState.self, from: Data(#"""
        {"order":["check","mixed"],"widgets":{
            "check":{"id":"check","size":"m","title":"Checklist","body":{"kind":"list","items":[{"title":"First","done":true},{"title":"Second","done":false}]}},
            "mixed":{"id":"mixed","size":"m","title":"List","body":{"kind":"list","items":[{"title":"Label"},{"title":"Task","done":true}]}}
        }}
        """#.utf8))
    #expect(panel.widgets["check"]?.pendingChecklistCount == 1)
    #expect(panel.widgets["mixed"]?.pendingChecklistCount == nil)
    let completed = panel.checking("check", item: 1, done: true)
    #expect(completed.widgets["check"]?.pendingChecklistCount == 0)
    let reopened = completed.checking("check", item: 1, done: false)
    #expect(reopened.list == panel.list)
}

@Test func scheduleOverviewPutsTheEarliestActiveOccurrenceFirst() throws {
    let rows = try JSONDecoder().decode([ScheduledTaskRow].self, from: Data(#"""
        [
          {"id":"later","name":"Later","schedule":{"kind":"once","at":30},"state":"active","nextRunAt":30},
          {"id":"paused","name":"Paused","schedule":{"kind":"once","at":5},"state":"paused","nextRunAt":5},
          {"id":"next","name":"Next","mode":"reminder","schedule":{"kind":"once","at":10},"state":"active","nextRunAt":10},
          {"id":"done","name":"Done","schedule":{"kind":"once","at":1},"state":"done","nextRunAt":null}
        ]
        """#.utf8))
    let ordered = ScheduledTaskRow.upcomingFirst(rows)
    #expect(ordered.map(\.id) == ["next", "later", "paused", "done"])
    #expect(ordered.first?.mode == .reminder)
    #expect(rows[0].mode == nil)
    #expect(rows[1].upcomingAt == nil)
}
