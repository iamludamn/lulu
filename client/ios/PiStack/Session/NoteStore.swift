import Foundation
import Observation

struct Note: Identifiable, Equatable {
    struct Check: Identifiable, Equatable {
        let id = UUID()
        var text = ""
        var done = false
    }

    let id = UUID()
    var title = ""
    var body = ""
    var date = Date.now
    var checks: [Check] = []
    var fileIDs: [String] = []
    var source: String?

    var displayTitle: String { title.isEmpty ? "新笔记" : title }
}

@MainActor @Observable
final class NoteStore {
    struct Offer: Identifiable {
        let id = "note-offer-\(UUID())"
        let note: Note
        var original: Note?
        var outcome: Outcome?
    }

    enum Outcome {
        case saved, updated, outdated

        var label: String {
            switch self {
            case .saved: "已存入笔记"
            case .updated: "已更新原笔记"
            case .outdated: "原笔记已有改动，请重新生成更新"
            }
        }
    }

    private struct LocalRow {
        let row: ChatRow
        let anchor: String?
    }

    private(set) var offers: [String: Offer] = [:]
    private var localRows: [LocalRow] = []
    private(set) var generating = false
    private(set) var contextID: UUID?
    var requestedRow: String?
    var notes: [Note] = []
    private(set) var pinnedIDs: Set<String> = []
    let mockData: Bool
    let sessionDate = Date.now

    private static let routeReplyID = "mock-suzhou-reply"
    private static let routeReply = "周六下午沿平江路走走，晚上去双塔市集。周日上午去苏州博物馆，记得提前预约。"

    init(mockData: Bool = false) {
        self.mockData = mockData
        guard mockData else { return }
        notes = [
            Note(title: "出行灵感", body: "挑一段好走的河边路线，留些时间喝咖啡。", date: sampleDate(day: 0, hour: 9, minute: 36)),
            Note(title: "购物清单", body: "周末出门前买齐。", date: sampleDate(day: -1, hour: 18, minute: 55),
                 checks: [.init(text: "燕麦奶"), .init(text: "咖啡豆")]),
            Note(title: "Lulu 灵感随记", body: "把路上想到的点子先记下来。", date: sampleDate(day: -4, hour: 14, minute: 8)),
            Note(title: "桌面整理", body: "线材放到桌下，台灯换到左手边。", date: sampleDate(day: -16, hour: 10, minute: 5)),
            Note(title: "十一月想读的书", body: "周末把读书笔记整理到一起。", date: sampleDate(day: -410, hour: 8, minute: 46))
        ]
        append(.user, "周末想去苏州，帮我排个轻松一点的路线。", anchor: nil)
        append(.assistant, Self.routeReply, anchor: nil, id: Self.routeReplyID)
    }

    var context: Note? { notes.first { $0.id == contextID } }

    func attach(_ id: UUID?) { contextID = id }

    func togglePin(_ id: String) {
        if !pinnedIDs.insert(id).inserted { pinnedIDs.remove(id) }
    }

    func create() -> UUID {
        let note = Note()
        notes.append(note)
        return note.id
    }

    func update(_ note: Note) {
        guard let index = notes.firstIndex(where: { $0.id == note.id }), notes[index] != note else { return }
        var edited = note
        edited.date = .now
        notes[index] = edited
    }

    func transcript(_ realRows: [ChatRow]) -> [ChatRow] {
        let byAnchor = Dictionary(grouping: localRows, by: \.anchor)
        let ids = Set(realRows.map(\.id))
        return realRows.flatMap { row in
            [row] + (byAnchor[row.id] ?? []).map(\.row)
        } + localRows.filter { entry in
            entry.anchor.map { !ids.contains($0) } ?? true
        }.map(\.row)
    }

    func propose(from source: ChatRow, context: [ChatRow], anchor: String?) {
        guard !generating else { return }
        if let existing = offers.values.first(where: { $0.original == nil && $0.note.source == source.id }) {
            requestedRow = existing.id
            return
        }
        let note: Note
        if source.id == Self.routeReplyID {
            note = Note(title: "周末去苏州", body: "周六沿平江路走走，晚上去双塔市集。\n周日参观苏州博物馆。",
                        checks: [.init(text: "预约苏州博物馆")], fileIDs: ["mock:map"], source: source.id)
        } else {
            let prompt = context.last(where: { $0.role == .user })?.text
            let title = prompt.map { String($0.prefix(24)) } ?? "Lulu 对话笔记"
            note = Note(title: title, body: source.body ?? source.text, source: source.id)
        }

        generating = true
        Task {
            try? await Task.sleep(for: .milliseconds(430))
            appendOffer(Offer(note: note), anchor: anchor)
            generating = false
        }
    }

    /// The Note discussion and edit service is local until the edit protocol is defined.
    func handleSend(_ text: String, anchor: String?) -> Bool {
        guard mockData || context != nil else { return false }
        append(.user, text, anchor: anchor)
        let rain = ["雨", "室内"].contains(where: text.contains)
        let edit = ["改", "更新", "编辑", "加入", "加上"].contains(where: text.contains)
            && !["怎么改", "如何改"].contains(where: text.contains)
        if let original = context, edit {
            var revision = original
            revision.body = original.fileIDs.contains("mock:map") && rain
                ? "周六沿平江路走走，晚上去双塔市集。\n周日上午参观苏州博物馆，下午改去室内展馆。"
                : [original.body, text].filter { !$0.isEmpty }.joined(separator: "\n")
            appendOffer(Offer(note: revision, original: original), anchor: anchor)
        } else if let note = context {
            let response = note.fileIDs.contains("mock:map") && rain
                ? "可以把苏州博物馆放在上午，下午改去室内展馆。散步地图留着，等天气好再用。"
                : "我们可以继续讨论「\(note.displayTitle)」。\n\(note.body)"
            append(.assistant, response, anchor: anchor)
        } else {
            append(.assistant, Self.routeReply, anchor: anchor)
        }
        return true
    }

    func accept(_ id: String) {
        guard var offer = offers[id], offer.outcome == nil else { return }
        var note = offer.note
        note.date = .now
        if let original = offer.original {
            if let index = notes.firstIndex(where: { $0.id == original.id }), notes[index] == original {
                notes[index] = note
                offer.outcome = .updated
            } else {
                offer.outcome = .outdated
            }
        } else {
            notes.append(note)
            offer.outcome = .saved
        }
        offers[id] = offer
    }

    func sampleDate(day: Int, hour: Int, minute: Int) -> Date {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: sessionDate)
        let offset = DateComponents(day: day, hour: hour, minute: minute)
        let sample = calendar.date(byAdding: offset, to: start) ?? start
        return sample <= sessionDate ? sample : max(start, sessionDate.addingTimeInterval(Double(minute - 60)))
    }

    private func append(_ role: ChatRow.Role, _ text: String, anchor: String?, id: String = "note-chat-\(UUID())") {
        localRows.append(LocalRow(row: ChatRow(id: id, role: role, text: text), anchor: anchor))
    }

    private func appendOffer(_ offer: Offer, anchor: String?) {
        offers[offer.id] = offer
        append(.assistant, "", anchor: anchor, id: offer.id)
    }
}
