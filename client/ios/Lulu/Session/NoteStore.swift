import Foundation
import LuluKit
import Observation

struct Note: Identifiable, Equatable {
    struct Check: Identifiable, Equatable {
        let id = UUID()
        var text = ""
        var done = false
    }

    struct Block: Identifiable, Equatable {
        enum Content: Equatable {
            case text(String)
            case check(Check)
            case file(String)
        }

        let id: UUID
        var content: Content

        init(id: UUID = UUID(), content: Content) {
            self.id = id
            self.content = content
        }

        init(_ block: NotePayload.Block) {
            id = block.id
            switch block.kind {
            case .text: content = .text(block.text ?? "")
            case .check: content = .check(.init(text: block.text ?? "", done: block.done ?? false))
            case .file: content = .file(block.ref ?? "")
            }
        }

        var payload: NotePayload.Block {
            switch content {
            case .text(let text): .init(id: id, kind: .text, text: text)
            case .check(let check): .init(id: id, kind: .check, text: check.text, done: check.done)
            case .file(let ref): .init(id: id, kind: .file, ref: ref)
            }
        }

        var isText: Bool {
            if case .text = content { true } else { false }
        }
    }

    let id: UUID
    var revision: Int
    var title: String
    var date: Date
    var blocks: [Block]
    var source: String?

    init(id: UUID = UUID(), title: String = "", body: String = "", date: Date = .now, checks: [Check] = [], fileIDs: [String] = [], source: String? = nil) {
        self.id = id
        revision = 0
        self.title = title
        self.date = date
        self.source = source
        blocks = [Block(content: .text(body))]
        blocks += checks.map { Block(content: .check($0)) }
        blocks += fileIDs.map { Block(content: .file($0)) }
    }

    init(id: UUID, revision: Int = 0, date: Date, payload: NotePayload) {
        self.id = id
        self.revision = revision
        self.date = date
        title = payload.title
        source = payload.source
        blocks = payload.blocks.map(Block.init)
    }

    init(_ revision: NoteRevision) {
        self.init(id: revision.id, revision: revision.revision,
                  date: Date(timeIntervalSince1970: revision.updatedAt / 1000), payload: revision.payload)
    }

    var payload: NotePayload {
        NotePayload(title: title, blocks: blocks.map(\.payload), source: source)
    }

    var body: String {
        blocks.compactMap { if case .text(let text) = $0.content, !text.isEmpty { text } else { nil } }
            .joined(separator: "\n")
    }

    var checks: [Check] {
        blocks.compactMap { if case .check(let check) = $0.content { check } else { nil } }
    }

    var fileIDs: [String] {
        blocks.compactMap { if case .file(let id) = $0.content { id } else { nil } }
    }

    var displayTitle: String { title.isEmpty ? "新笔记" : title }

    mutating func insert(_ block: Block, after anchor: UUID?, splittingAt offset: Int? = nil) {
        guard let anchor, let index = blocks.firstIndex(where: { $0.id == anchor }) else {
            blocks.append(block)
            return
        }
        if let offset, offset >= 0, case .text(let text) = blocks[index].content,
           let split = text.index(text.startIndex, offsetBy: offset, limitedBy: text.endIndex), split < text.endIndex {
            if split == text.startIndex {
                blocks.insert(block, at: index)
            } else {
                blocks[index].content = .text(String(text[..<split]))
                let remainder = Block(content: .text(String(text[split...])))
                blocks.insert(contentsOf: [block, remainder], at: index + 1)
            }
        } else if case .text("") = blocks[index].content {
            blocks[index] = block
        } else {
            blocks.insert(block, at: index + 1)
        }
    }
}

@MainActor @Observable
final class NoteStore {
    struct Offer: Identifiable {
        var id = "note-offer-\(UUID())"
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

    struct Reply {
        let text: String
        let updated: Bool
    }

    private struct NoteDiscussion: Codable {
        struct Undo: Codable {
            let before: NotePayload
            let after: NotePayload
        }

        var last: NoteExchange?
        var updated = false
        var hidden = false
        var undo: Undo?
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

    private struct SavedNote: Codable {
        let id: UUID
        let revision: Int
        let date: Date
        let payload: NotePayload
    }

    private struct LocalState: Codable {
        let notes: [SavedNote]
        let pinned: Set<String>
        let dirty: Set<UUID>
        let pending: [UUID: NoteMutation]
        let pinChanges: [String: Bool]
        let context: UUID?
        let discussions: [UUID: NoteDiscussion]?
    }

    private struct SyncEndpoint {
        let api: Api
        let bot: String
        let token: String
    }

    private let endpoint: SyncEndpoint?
    private let database: NoteDatabase?
    private var dirty: Set<UUID> = []
    private var pending: [UUID: NoteMutation] = [:]
    private var pinChanges: [String: Bool] = [:]
    private var discussions: [UUID: NoteDiscussion] = [:]
    private(set) var syncError: String?
    @ObservationIgnored private var debounce: Task<Void, Never>?
    @ObservationIgnored private var uploads: [UUID: Task<Void, Error>] = [:]
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var refreshAgain = false

    init(mockData: Bool = false, api: Api? = nil, bot: String = "", token: String = "") {
        self.mockData = mockData
        endpoint = mockData ? nil : api.map { SyncEndpoint(api: $0, bot: bot, token: token) }
        database = try? endpoint.map { try NoteDatabase(scope: $0.api.base.absoluteString + "|" + $0.bot) }
        if !mockData {
            do {
                guard let database else {
                    if endpoint != nil { syncError = "无法打开本地笔记" }
                    return
                }
                if let saved = try database.load(LocalState.self) {
                    notes = saved.notes.map { Note(id: $0.id, revision: $0.revision, date: $0.date, payload: $0.payload) }
                    pinnedIDs = saved.pinned
                    dirty = saved.dirty
                    pending = saved.pending
                    pinChanges = saved.pinChanges
                    contextID = saved.context
                    discussions = saved.discussions ?? [:]
                }
            } catch { syncError = "无法读取本地笔记" }
            return
        }
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

    func attach(_ id: UUID?) {
        contextID = id
        saveLocally()
    }

    func togglePin(_ id: String) {
        let pinned = pinnedIDs.insert(id).inserted
        if !pinned { pinnedIDs.remove(id) }
        guard endpoint != nil else { return }
        pinChanges[id] = pinned
        changed()
    }

    func create() -> UUID {
        let note = Note()
        notes.append(note)
        markChanged(note.id)
        return note.id
    }

    func update(_ note: Note) {
        guard let index = notes.firstIndex(where: { $0.id == note.id }), notes[index] != note else { return }
        var edited = note
        edited.date = .now
        notes[index] = edited
        markChanged(note.id)
    }

    func reply(in id: UUID) -> Reply? {
        guard let discussion = discussions[id], !discussion.hidden, let last = discussion.last else { return nil }
        return Reply(text: last.reply, updated: discussion.updated)
    }

    func dismissReply(in id: UUID) {
        discussions[id]?.hidden = true
        saveLocally()
    }

    func ask(_ text: String, in id: UUID) async throws {
        guard let original = notes.first(where: { $0.id == id }) else { throw ApiError.message("找不到这篇笔记") }
        guard text.utf16.count <= 4000 else { throw ApiError.message("提问太长，请缩短后重试") }
        let answer: NoteAnswer
        if let endpoint {
            answer = try await endpoint.api.askNote(endpoint.bot, note: original.payload, question: text,
                                                    previous: discussions[id]?.last, token: endpoint.token)
        } else if mockData {
            try await Task.sleep(for: .milliseconds(420))
            answer = mockAnswer(text, note: original)
        } else {
            throw ApiError.message("笔记服务未连接")
        }
        try Task.checkCancellation()
        guard let current = notes.first(where: { $0.id == id }) else { throw ApiError.message("找不到这篇笔记") }
        let content = answer.content.flatMap { $0 == original.payload ? nil : $0 }
        if content != nil, current.payload != original.payload {
            throw ApiError.message("笔记在回复期间已有改动，请重新提问")
        }
        var discussion = discussions[id] ?? NoteDiscussion()
        discussion.last = NoteExchange(question: text, reply: answer.reply)
        discussion.hidden = false
        discussion.updated = content != nil
        if let content { discussion.undo = .init(before: original.payload, after: content) }
        discussions[id] = discussion
        if let content {
            update(Note(id: id, revision: current.revision, date: .now, payload: content))
        } else {
            saveLocally()
        }
    }

    func canUndo(_ note: Note) -> Bool {
        discussions[note.id]?.undo?.after == note.payload
    }

    func updatedBlocks(in note: Note) -> Set<UUID> {
        guard let undo = discussions[note.id]?.undo, undo.after == note.payload else { return [] }
        let previous = Dictionary(uniqueKeysWithValues: undo.before.blocks.map { ($0.id, $0) })
        return Set(undo.after.blocks.filter { $0 != previous[$0.id] }.map(\.id))
    }

    @discardableResult
    func undoUpdate(in id: UUID) -> Bool {
        guard var discussion = discussions[id], let undo = discussion.undo,
              let current = notes.first(where: { $0.id == id }), current.payload == undo.after else { return false }
        discussion.undo = nil
        if discussion.updated {
            discussion.last = nil
            discussion.updated = false
        }
        discussions[id] = discussion
        update(Note(id: id, revision: current.revision, date: .now, payload: undo.before))
        return true
    }

    private func mockAnswer(_ text: String, note: Note) -> NoteAnswer {
        let rain = ["雨", "室内"].contains(where: text.contains)
        let edit = ["补上", "补一", "加上", "加入", "改成", "写入", "更新", "修改"].contains(where: text.contains)
        guard edit else { return NoteAnswer(reply: rain ? "下雨的话，上午可以去苏州博物馆，下午留给室内展览。" : "可以从「\(note.displayTitle)」里最重要的一点开始。") }
        var updated = note
        updated.blocks.append(.init(content: .text(rain ? "雨天备选\n上午去苏州博物馆，下午留给室内展览。" : text)))
        return NoteAnswer(reply: rain ? "已补上雨天备选。" : "已补充到笔记里。", content: updated.payload)
    }

    private func markChanged(_ id: UUID) {
        guard endpoint != nil else { return }
        dirty.insert(id)
        changed()
    }

    private func changed() {
        saveLocally()
        debounce?.cancel()
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(550)) } catch { return }
            self?.debounce = nil
            await self?.refresh()
        }
    }

    private func saveLocally() {
        do { try persist() } catch { syncError = error.localizedDescription }
    }

    private func persist() throws {
        guard endpoint != nil else { return }
        guard let database else { throw ApiError.message("无法打开本地笔记") }
        try database.save(LocalState(
            notes: notes.map { SavedNote(id: $0.id, revision: $0.revision, date: $0.date, payload: $0.payload) },
            pinned: pinnedIDs, dirty: dirty, pending: pending, pinChanges: pinChanges, context: contextID,
            discussions: discussions
        ))
    }

    func refresh() async {
        guard let endpoint else { return }
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        defer {
            refreshing = false
            if refreshAgain {
                refreshAgain = false
                Task { await refresh() }
            }
        }
        var failure: Error?
        for id in dirty {
            do { try await synchronize(id) } catch { failure = error }
        }
        for (key, value) in pinChanges {
            do {
                try await endpoint.api.pinNoteCard(endpoint.bot, key: key, pinned: value, token: endpoint.token)
                if pinChanges[key] == value { pinChanges.removeValue(forKey: key) }
            } catch { failure = error }
        }
        do {
            let gallery = try await endpoint.api.notes(endpoint.bot, token: endpoint.token)
            for revision in gallery.notes where !dirty.contains(revision.id) {
                if let index = notes.firstIndex(where: { $0.id == revision.id }) {
                    if revision.revision > notes[index].revision { notes[index] = Note(revision) }
                } else {
                    notes.append(Note(revision))
                }
            }
            let remote = Set(gallery.pinned)
            pinnedIDs = remote.union(pinChanges.filter { $0.value }.map(\.key)).subtracting(pinChanges.filter { !$0.value }.map(\.key))
            try persist()
            syncError = failure?.localizedDescription
        } catch {
            syncError = error.localizedDescription
        }
    }

    func synchronize(_ id: UUID) async throws {
        if let existing = uploads[id] {
            try await existing.value
            return
        }
        let task = Task { try await upload(id) }
        uploads[id] = task
        defer { uploads.removeValue(forKey: id) }
        try await task.value
    }

    private func upload(_ id: UUID) async throws {
        guard let endpoint else { return }
        while dirty.contains(id), let note = notes.first(where: { $0.id == id }) {
            let mutation = pending[id] ?? NoteMutation(id: id, requestId: UUID(), baseRevision: note.revision, content: note.payload)
            pending[id] = mutation
            try persist()
            let result = try await endpoint.api.saveNote(endpoint.bot, mutation: mutation, token: endpoint.token)
            guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
            if notes[index].payload == mutation.content {
                notes[index] = Note(result)
                dirty.remove(id)
            } else {
                notes[index].revision = result.revision
            }
            pending.removeValue(forKey: id)
            try persist()
        }
    }

    func hasLocalEdits(_ id: UUID) -> Bool { dirty.contains(id) }

    func synchronizedReference(_ reference: Note) async throws -> Note {
        if hasLocalEdits(reference.id) { try await synchronize(reference.id) }
        guard let synced = notes.first(where: { $0.id == reference.id }),
              synced.payload == reference.payload, synced.revision > 0 else {
            throw ApiError.message("笔记引用已变化，请确认后重新发送")
        }
        return synced
    }

    func recordError(_ error: Error) { syncError = error.localizedDescription }

    func ingest(_ entries: [ConversationEntry]) {
        guard !mockData else { return }
        struct Job: Decodable { let id: UUID }
        var running: Set<UUID> = []
        for entry in entries {
            if entry.kind == "lulu.note.generating", let job = entry.noteData(Job.self) {
                running.insert(job.id)
            } else if entry.kind == "lulu.note.failed", let job = entry.noteData(Job.self) {
                running.remove(job.id)
            } else if entry.kind == "lulu.note.proposal", let proposal = entry.noteData(NoteProposal.self) {
                running.remove(proposal.id)
                let id = proposal.id.uuidString.lowercased()
                if offers[id] != nil { continue }
                let value = Note(id: proposal.base?.id ?? proposal.id, date: Date(timeIntervalSince1970: proposal.at / 1000), payload: proposal.content)
                offers[id] = Offer(id: id, note: value, original: proposal.base.map(Note.init))
            } else if ["lulu.note.accepted", "lulu.note.stale"].contains(entry.kind),
                      let receipt = entry.noteData(NoteAcceptance.self) {
                let id = receipt.id.uuidString.lowercased()
                if let offer = offers[id], offer.outcome == nil {
                    let stale = entry.kind == "lulu.note.stale"
                    offers[id]?.outcome = stale ? .outdated : (receipt.editing ? .updated : .saved)
                    Task { await refresh() }
                }
            }
        }
        generating = !running.isEmpty
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

    func handleSend(_ text: String, anchor: String?) -> Bool {
        guard mockData else { return false }
        append(.user, text, anchor: anchor)
        let rain = ["雨", "室内"].contains(where: text.contains)
        let edit = ["改", "更新", "编辑", "加入", "加上"].contains(where: text.contains)
            && !["怎么改", "如何改"].contains(where: text.contains)
        if let original = context, edit {
            var revision = original
            if original.fileIDs.contains("mock:map"), rain,
               let index = revision.blocks.firstIndex(where: { if case .text = $0.content { true } else { false } }) {
                revision.blocks[index].content = .text("周六沿平江路走走，晚上去双塔市集。\n周日上午参观苏州博物馆，下午改去室内展馆。")
            } else {
                revision.blocks.append(.init(content: .text(text)))
            }
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
