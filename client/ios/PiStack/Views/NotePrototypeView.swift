#if DEBUG && targetEnvironment(simulator) && LULU_NOTE_PROTOTYPE
import SwiftUI

struct NotePrototypeView: View {
    private static let reply = "周六下午沿平江路走走，晚上去双塔市集。周日上午去苏州博物馆，记得提前预约。"
    private static let initialReplyID = UUID()
    private static let locale = Locale(identifier: "zh_CN")
    private static let files: [PrototypeFile] = [
        .init(id: "map", name: "苏州散步地图", ext: "pdf", date: sampleDate(day: 0, hour: 9, minute: 32),
              text: "平江路 → 拙政园 → 苏州博物馆"),
        .init(id: "coffee", name: "苏州咖啡店清单", ext: "html", date: sampleDate(day: -1, hour: 16, minute: 22),
              text: "十全街｜有露台\n平江路｜适合歇脚"),
        .init(id: "agenda", name: "周五例会议程", ext: "pdf", date: sampleDate(day: -1, hour: 11, minute: 17),
              text: "本周进展\n下周安排\n待讨论事项")
    ]

    @State private var page = Page.chat
    @State private var notes = [
        PrototypeNote(title: "出行灵感", body: "挑一段好走的河边路线，留些时间喝咖啡。", date: sampleDate(day: 0, hour: 9, minute: 36)),
        PrototypeNote(title: "购物清单", body: "周末出门前买齐。", date: sampleDate(day: -1, hour: 18, minute: 55),
                      checks: [.init(text: "燕麦奶"), .init(text: "咖啡豆")]),
        PrototypeNote(title: "Lulu 灵感随记", body: "把路上想到的点子先记下来，下次聊到时继续整理。", date: sampleDate(day: -1, hour: 14, minute: 8)),
        PrototypeNote(title: "桌面整理", body: "线材放到桌下，台灯换到左手边。", date: sampleDate(day: -1, hour: 10, minute: 5)),
        PrototypeNote(title: "十一月想读的书", body: "周末把读书笔记整理到一起。", date: sampleDate(day: -1, hour: 8, minute: 46))
    ]
    @State private var turns = [
        PrototypeTurn(content: .user("周末想去苏州，帮我排个轻松一点的路线。")),
        PrototypeTurn(id: initialReplyID, content: .assistant(reply))
    ]
    @State private var selection: GalleryItem?
    @State private var previewFile: PrototypeFile?
    @State private var contextID: UUID?
    @State private var messageTarget: UUID?
    @State private var draft = ""
    @State private var query = ""
    @State private var showsFiles = false
    @State private var generating: UUID?
    @State private var outcomes: [UUID: String] = [:]
    @State private var landed = Set<UUID>()
    @FocusState private var editingChat: Bool

    private var entries: [GalleryItem] {
        let all = notes.map(GalleryItem.note) + Self.files.map(GalleryItem.file)
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return all
            .filter { term.isEmpty || "\($0.title) \($0.text)".localizedCaseInsensitiveContains(term) }
            .sorted { $0.date > $1.date }
    }

    private var contextNote: PrototypeNote? { notes.first { $0.id == contextID } }

    var body: some View {
        Group {
            if let previewFile {
                fileDetail(previewFile)
            } else if let selection {
                switch selection {
                case .file(let file):
                    fileDetail(file)
                case .note(let note):
                    if let index = notes.firstIndex(where: { $0.id == note.id }) {
                        noteDetail($notes[index])
                    }
                }
            } else {
                VStack(spacing: 0) {
                    navigation
                    switch page {
                    case .panel: panel
                    case .chat: chat
                    case .assets: gallery
                    }
                }
            }
        }
        .background(Color(uiColor: page == .assets && selection == nil ? .secondarySystemBackground : .systemBackground))
        .tint(Color(light: 0x2E608F, dark: 0xA1CEF7))
        .sheet(isPresented: $showsFiles) { filePicker }
    }

    private var navigation: some View {
        HStack {
            Color.clear.frame(width: 35, height: 35).accessibilityHidden(true)
            Spacer()
            HStack(spacing: 3) {
                ForEach(Page.allCases) { destination in
                    Button {
                        navigate(destination)
                    } label: {
                        Text(destination == .assets ? "Note" : destination.title)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 13)
                            .padding(.vertical, 7)
                            .background {
                                if page == destination { Capsule().fill(.background) }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(page == destination ? .isSelected : [])
                }
            }
            .padding(4)
            .background(.thinMaterial, in: .capsule)
            Spacer()
            Avatar(name: "lulu", id: "main", size: 35)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 8)
    }

    private var panel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("视图").font(.largeTitle.bold())
                Label("出门前清单", systemImage: "checklist")
                Label("日程概览", systemImage: "calendar")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
    }

    private var chat: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(turns) { turn in
                        chatRow(turn).id(turn.id)
                    }
                    if generating != nil {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Lulu 正在整理笔记…").font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 8)
                    }
                    Color.clear.frame(height: 1).id("chat-bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 18)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: turns.count) {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
            .onChange(of: generating) { _, value in
                if value != nil { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
            .task(id: messageTarget) {
                if let messageTarget {
                    proxy.scrollTo(messageTarget, anchor: .center)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        }
    }

    @ViewBuilder
    private func chatRow(_ turn: PrototypeTurn) -> some View {
        switch turn.content {
        case .user(let text):
            HStack {
                Spacer(minLength: 42)
                Text(text).padding(13)
                    .background(.blue.opacity(0.12), in: .rect(cornerRadius: 19))
            }
        case .assistant(let text):
            VStack(alignment: .leading, spacing: 5) {
                Text("Lulu").font(.caption.weight(.semibold)).foregroundStyle(.tint)
                Text(text).lineSpacing(3)
            }
            .padding(13)
            .background(.regularMaterial, in: .rect(cornerRadius: 19))
            .contentShape(.rect(cornerRadius: 19))
            .contextMenu {
                Button("存入 Note", systemImage: "note.text.badge.plus") {
                    offerNote(from: turn.id, text: text)
                }
                .disabled(generating != nil)
            }
            .accessibilityIdentifier(turn.id == Self.initialReplyID ? "note-prototype.reply" : "note-prototype.assistant")
            .accessibilityAction(named: "存入 Note") { offerNote(from: turn.id, text: text) }
            .padding(.trailing, 38)
        case .candidate(let candidate):
            if landed.contains(turn.id), let outcome = outcomes[turn.id] {
                Label(outcome, systemImage: outcome.hasPrefix("已") ? "checkmark.circle" : "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 9)
            } else {
                SwipeToKeep(destination: .assets, onLand: {
                    landed.insert(turn.id)
                }, onKeep: {
                    accept(candidate, turnID: turn.id)
                }, confirmed: outcomes[turn.id] != nil, horizontalExit: true) { _, armed in
                    candidateCard(candidate, armed: armed)
                        .accessibilityAction(named: candidate.isUpdate ? "更新原笔记" : "存入 Note") {
                            accept(candidate, turnID: turn.id)
                            landed.insert(turn.id)
                        }
                }
                .padding(.trailing, 32)
            }
        }
    }

    private func candidateCard(_ candidate: PrototypeCandidate, armed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(candidate.isUpdate ? "Note 更新" : "Note", systemImage: "note.text")
                .font(.caption.weight(.semibold)).foregroundStyle(.tint)
            Text(candidate.note.title).font(.headline)
            Text(candidate.note.body).font(.subheadline).lineSpacing(3).foregroundStyle(.secondary)
            Label(candidate.isUpdate ? "右滑更新原笔记" : "右滑存入 Note", systemImage: "arrow.right")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(.blue.opacity(0.10), in: .capsule)
                .foregroundStyle(.tint)
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: .rect(cornerRadius: 19))
        .overlay(RoundedRectangle(cornerRadius: 19).strokeBorder(.blue.opacity(armed ? 0.65 : 0.22)))
        .contentShape(.rect(cornerRadius: 19))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("note-prototype.candidate")
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let contextNote {
                HStack(spacing: 7) {
                    Label(contextNote.title, systemImage: "note.text")
                        .font(.footnote.weight(.semibold)).lineLimit(1)
                    Button("移除笔记引用", systemImage: "xmark.circle.fill") { contextID = nil }
                        .labelStyle(.iconOnly)
                }
                .foregroundStyle(.tint)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.blue.opacity(0.10), in: .capsule)
            }
            HStack {
                TextField("给 Lulu 发消息", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($editingChat)
                    .accessibilityIdentifier("note-prototype.composer")
                Button("发送", systemImage: "arrow.up.circle.fill", action: send)
                    .labelStyle(.iconOnly)
                    .font(.title2)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.regularMaterial, in: .capsule)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.background)
    }

    private var gallery: some View {
        let groups = Dictionary(grouping: entries) { Calendar.current.startOfDay(for: $0.date) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 19) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("全部 Note").font(.largeTitle.bold())
                    Text("\(entries.count) 项").font(.footnote).foregroundStyle(.secondary)
                }
                if entries.isEmpty {
                    Text("没有找到相关内容").foregroundStyle(.secondary)
                }
                ForEach(groups.keys.sorted(by: >), id: \.self) { day in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(day.formatted(.relative(presentation: .named).locale(Self.locale))).font(.headline)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3),
                                  alignment: .leading, spacing: 14) {
                            ForEach(groups[day] ?? []) { entry in
                                Button { selection = entry } label: { galleryCard(entry) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 740)
            .padding(.horizontal, 18)
            .padding(.top, 7)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 9) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索", text: $query).accessibilityLabel("搜索 Note")
                }
                .padding(.horizontal, 13)
                .frame(height: 43)
                .glassEffect(.regular)
                roundButton("新建笔记", icon: "square.and.pencil", action: newNote)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 7)
        }
    }

    private func galleryCard(_ entry: GalleryItem) -> some View {
        VStack(alignment: .center, spacing: 4) {
            Group {
                switch entry {
                case .note(let note):
                    VStack(alignment: .leading, spacing: 3) {
                        Text(note.title.isEmpty ? "新笔记" : note.title).font(.system(size: 8, weight: .semibold)).lineLimit(1)
                        Text(note.body).font(.system(size: 7)).lineLimit(3)
                        if let first = note.checks.first {
                            Label(first.text, systemImage: first.done ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 7)).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(7)
                case .file(let file):
                    fileArtwork(file, compact: true)
                }
            }
            .frame(height: 73)
            .frame(maxWidth: .infinity)
            .background(.background)
            .clipShape(.rect(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.primary.opacity(0.10)))
            .shadow(color: .black.opacity(0.06), radius: 2, y: 2)
            .accessibilityHidden(true)
            Text(entry.title).font(.caption.weight(.medium)).lineLimit(1)
            Text(entry.date.formatted(.dateTime.hour().minute().locale(Self.locale)))
                .font(.caption2).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func noteDetail(_ note: Binding<PrototypeNote>) -> some View {
        let value = note.wrappedValue
        return ScrollView {
            VStack(alignment: .leading, spacing: 13) {
                Text(value.date.formatted(.dateTime.month().day().hour().minute().locale(Self.locale)))
                    .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                TextField("新笔记", text: note.title, axis: .vertical)
                    .font(.largeTitle.bold())
                    .accessibilityLabel("笔记标题")
                TextField("开始记录…", text: note.body, axis: .vertical)
                    .lineSpacing(4)
                    .accessibilityLabel("笔记正文")
                ForEach(note.checks) { item in
                    HStack(spacing: 8) {
                        Button {
                            item.wrappedValue.done.toggle()
                        } label: {
                            Image(systemName: item.wrappedValue.done ? "checkmark.circle.fill" : "circle")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .accessibilityLabel(item.wrappedValue.done ? "取消勾选" : "勾选")
                        TextField("清单项", text: item.text)
                    }
                }
                ForEach(Self.files.filter { value.fileIDs.contains($0.id) }) { file in
                    Button { previewFile = file } label: {
                        VStack(spacing: 0) {
                            Label(file.filename, systemImage: "doc")
                                .font(.footnote.weight(.semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                            fileArtwork(file, compact: false).frame(height: 116)
                        }
                        .background(.thinMaterial)
                        .clipShape(.rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
                if let source = value.source {
                    Button("查看 Lulu 原对话", systemImage: "bubble") {
                        selection = nil
                        messageTarget = source
                        navigate(.chat)
                    }
                    .font(.footnote)
                }
            }
            .frame(maxWidth: 660)
            .padding(.horizontal, 22)
            .padding(.top, 15)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: value) { previous, updated in
            if previous.id == updated.id && previous.date == updated.date {
                note.wrappedValue.date = .now
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                roundButton("返回 Note", icon: "chevron.left") { selection = nil }
                Spacer()
                Button("带回对话", systemImage: "bubble.left") {
                    contextID = value.id
                    selection = nil
                    messageTarget = nil
                    navigate(.chat)
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.glass)
            }
            .padding(.horizontal, 17)
            .padding(.bottom, 5)
            .background(.background)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 10) {
                roundButton("添加清单项", icon: "checklist") {
                    note.wrappedValue.checks.append(.init(text: ""))
                }
                roundButton("引用已有文件", icon: "paperclip") { showsFiles = true }
                Spacer()
                roundButton("新建笔记", icon: "square.and.pencil", action: newNote)
            }
            .padding(.horizontal, 17)
            .padding(.vertical, 6)
            .background(.background)
        }
    }

    private func fileDetail(_ file: PrototypeFile) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            roundButton("返回", icon: "chevron.left") {
                if previewFile != nil { previewFile = nil } else { selection = nil }
            }
            Text(file.filename).font(.title.bold())
            fileArtwork(file, compact: false).frame(height: 230).clipShape(.rect(cornerRadius: 14))
            if file.id == "map" { Text(file.text).font(.subheadline) }
            Spacer()
        }
        .frame(maxWidth: 660, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 18)
    }

    private func fileArtwork(_ file: PrototypeFile, compact: Bool) -> some View {
        Group {
            if file.id == "map" {
                ZStack(alignment: .topLeading) {
                    Color(light: 0xE7F0E9, dark: 0x263C38)
                    GeometryReader { proxy in
                        let w = proxy.size.width
                        let h = proxy.size.height
                        Path { river in
                            river.move(to: CGPoint(x: w * 0.13, y: h * 0.86))
                            river.addQuadCurve(to: CGPoint(x: w * 0.53, y: h * 0.48), control: CGPoint(x: w * 0.39, y: h * 0.88))
                            river.addQuadCurve(to: CGPoint(x: w * 0.88, y: h * 0.17), control: CGPoint(x: w * 0.68, y: h * 0.59))
                        }
                        .stroke(.cyan.opacity(0.30), lineWidth: compact ? 7 : 14)
                        Path { walk in
                            walk.move(to: CGPoint(x: w * 0.25, y: h * 0.76))
                            walk.addLines([CGPoint(x: w * 0.43, y: h * 0.63), CGPoint(x: w * 0.59, y: h * 0.57), CGPoint(x: w * 0.77, y: h * 0.29)])
                        }
                        .stroke(.teal, style: StrokeStyle(lineWidth: compact ? 1.5 : 3, dash: [4, 3]))
                    }
                    Text("平江路")
                        .font(.system(size: compact ? 7 : 12, weight: .medium))
                        .padding(compact ? 7 : 14)
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    Text(file.name).font(compact ? .system(size: 8, weight: .semibold) : .headline)
                    Text(file.text).font(compact ? .system(size: 7) : .subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(compact ? 7 : 16)
                .background(.background)
            }
        }
    }

    private var filePicker: some View {
        NavigationStack {
            List(Self.files) { file in
                if case .note(let selected) = selection, let index = notes.firstIndex(where: { $0.id == selected.id }) {
                    Button {
                        if !notes[index].fileIDs.contains(file.id) { notes[index].fileIDs.append(file.id) }
                        showsFiles = false
                    } label: { Label(file.filename, systemImage: "doc") }
                    .disabled(notes[index].fileIDs.contains(file.id))
                }
            }
            .navigationTitle("从画廊选择文件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { showsFiles = false } }
            }
        }
    }

    private func roundButton(_ label: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.body.weight(.medium)).frame(width: 43, height: 43)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(label)
    }

    private func navigate(_ destination: Page) {
        editingChat = false
        landed.formUnion(outcomes.keys)
        page = destination
    }

    private func newNote() {
        let note = PrototypeNote()
        notes.append(note)
        selection = .note(note)
    }

    private func offerNote(from source: UUID, text: String) {
        guard generating == nil else { return }
        if let candidate = turns.first(where: { turn in
            if case .candidate(let candidate) = turn.content { return !candidate.isUpdate && candidate.note.source == source }
            return false
        }) {
            messageTarget = candidate.id
            return
        }
        editingChat = false
        generating = source
        let note = source == Self.initialReplyID
            ? PrototypeNote(title: "周末去苏州", body: "周六沿平江路走走，晚上去双塔市集。\n周日参观苏州博物馆。", checks: [.init(text: "预约苏州博物馆")], fileIDs: ["map"], source: source)
            : PrototypeNote(title: "Lulu 对话笔记", body: text, source: source)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(430))
            turns.append(.init(content: .candidate(.init(note: note))))
            generating = nil
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        editingChat = false
        messageTarget = nil
        turns.append(.init(content: .user(text)))
        let rain = ["雨", "室内"].contains(where: text.contains)
        let isEdit = ["改", "更新", "编辑", "修改", "加入", "加上"].contains(where: text.contains)
            && !["怎么改", "如何改"].contains(where: text.contains)
        if let target = contextNote, isEdit {
            var revision = target
            let mockEdit = target.fileIDs.contains("map") && rain
                ? "周六沿平江路走走，晚上去双塔市集。\n周日上午参观苏州博物馆，下午改去室内展馆。"
                : [target.body, text].filter { !$0.isEmpty }.joined(separator: "\n")
            revision.body = mockEdit
            turns.append(.init(content: .candidate(.init(note: revision, original: target))))
        } else {
            let reply: String
            if contextNote?.fileIDs.contains("map") == true, rain {
                reply = "可以把苏州博物馆放在上午，下午改去室内展馆。散步地图还可以留着，等天气好再用。"
            } else if let note = contextNote {
                reply = "我们可以继续讨论「\(note.title.isEmpty ? "新笔记" : note.title)」。\n\(note.body)"
            } else {
                reply = "可以先把周末路线整理成一条 Note，或者带一条已有笔记回来一起讨论。"
            }
            turns.append(.init(content: .assistant(reply)))
        }
    }

    private func accept(_ candidate: PrototypeCandidate, turnID: UUID) {
        guard outcomes[turnID] == nil else { return }
        var note = candidate.note
        note.date = .now
        if let original = candidate.original {
            guard let index = notes.firstIndex(where: { $0.id == original.id }), notes[index] == original else {
                outcomes[turnID] = "原笔记已有改动，请重新生成更新"
                return
            }
            notes[index] = note
            outcomes[turnID] = "已更新原笔记"
        } else {
            notes.append(note)
            outcomes[turnID] = "已存入 Note"
        }
    }

    private static func sampleDate(day: Int, hour: Int, minute: Int) -> Date {
        let calendar = Calendar.current
        let now = Date.now
        let start = calendar.startOfDay(for: now)
        let offset = DateComponents(day: day, hour: hour, minute: minute)
        let sample = calendar.date(byAdding: offset, to: start) ?? start
        return sample <= now ? sample : max(start, now.addingTimeInterval(Double(minute - 60)))
    }
}

private struct PrototypeNote: Identifiable, Equatable {
    struct Check: Identifiable, Equatable {
        let id = UUID()
        var text: String
        var done = false
    }
    let id = UUID()
    var title = ""
    var body = ""
    var date = Date.now
    var checks: [Check] = []
    var fileIDs: [String] = []
    var source: UUID?
}

private struct PrototypeFile: Identifiable {
    let id: String
    let name: String
    let ext: String
    let date: Date
    let text: String
    var filename: String { "\(name).\(ext)" }
}

private struct PrototypeCandidate {
    let note: PrototypeNote
    var original: PrototypeNote?
    var isUpdate: Bool { original != nil }
}

private struct PrototypeTurn: Identifiable {
    enum Content {
        case user(String)
        case assistant(String)
        case candidate(PrototypeCandidate)
    }
    var id = UUID()
    let content: Content
}

private enum GalleryItem: Identifiable {
    case note(PrototypeNote)
    case file(PrototypeFile)

    var id: String {
        switch self {
        case .note(let note): note.id.uuidString
        case .file(let file): file.id
        }
    }

    var title: String {
        switch self {
        case .note(let note): note.title.isEmpty ? "新笔记" : note.title
        case .file(let file): file.name
        }
    }

    var date: Date {
        switch self {
        case .note(let note): note.date
        case .file(let file): file.date
        }
    }

    var text: String {
        switch self {
        case .note(let note): note.body
        case .file(let file): file.text
        }
    }
}

private extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
}
#endif
